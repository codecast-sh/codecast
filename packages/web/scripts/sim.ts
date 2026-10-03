// `bun run sim`: the multiplayer simulation harness runner
// (docs/architecture/multiplayer-sim-harness.md, sections 3.8 and 3.12).
//
// It turns flags into SIM_* env vars and spawns
// `bun test store/__tests__/sim/ --isolate`, or with a filter only the file
// that registers the scenarios (sim.test.ts), after checking the filter names
// some. The env vars stay the source of truth, so a bare
// `SIM_SEEDS=3 bun test store/__tests__/sim/` behaves the same.
//
// Every run opens a session folder (sim/history.ts) and hands it to the tests
// as SIM_SESSION: they append runs.jsonl and write failure artifacts inside
// it. --shrink replays a failure's recorded order in subprocesses until no
// entry can go (sim/shrink.ts) and writes minimal.json beside it.
// `--list` and `--invariants` read the source statically and never import the
// store, so they answer at once.
//
// Run from packages/web: bun run sim [filter] [flags]

import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { SimFailureResult, SimInvariant, SimMarker, SimMinimal, SimResult, SimScenario, SimShrinkProgress } from "@codecast/shared/contracts/evalsApi";
import { levenshtein } from "@codecast/shared/contracts/levenshtein";
import { closeSession, openSession, pruneSessions, sessionsDir, storeTreePatch, treeState } from "../store/__tests__/sim/history";
import { formatOrder, parseOrder } from "../store/__tests__/sim/net";
import { SHRINK_MAX_ATTEMPTS, SHRINK_MAX_MS, shrinkOrder, splitOrderLine } from "../store/__tests__/sim/shrink";

const WEB_ROOT = join(import.meta.dir, "..");
const REPO_ROOT = join(WEB_ROOT, "../..");
const SIM_DIR = "store/__tests__/sim";
const SIM_ABS = join(WEB_ROOT, SIM_DIR);
const SCENARIO_DIRS: [dir: string, suffix: string][] = [["scenarios", ".scenario.ts"], ["selftests", ".selftest.ts"]];
// The DSL's default modes (section 3.8), shown when a scenario names none.
const DEFAULT_MODES = ["scripted", "interleave"];

const HELP = `bun run sim [filter] [flags]

Runs the sim scenarios and self-tests (bun test ${SIM_DIR}/ --isolate).
Each run is recorded as a session under ${sessionsDir().replace(process.env.HOME ?? "~", "~")}.

  filter               run only scenario and self-test files whose name contains it,   SIM_SCENARIO
                       or the one scenario of that exact name
  --seed a,b           pin the seeds                                                   SIM_SEEDS
  --sweep N            widen each scenario to N seeds                                  SIM_SWEEP
  --trace [label]      stream deliveries touching label (every delivery if omitted)    SIM_TRACE
  --red                run only the red (expected-failing) scenarios                   SIM_RED=1
  --keep               write a pass's artifacts into the session too                   SIM_KEEP=1
  --out dir            write run artifacts under dir instead, on a pass too            SIM_OUT
  --order="<channels>" replay one delivery order, as a report's --order line prints it SIM_ORDER
                       (one word: bun run drops an empty "", so an empty order is --order=)
  --shrink <dir>       shrink a failure's recorded order (dir: its artifact folder) to the
                       fewest deliveries that fail the same way; writes minimal.json there
  --list               print the scenario catalog (name, red markers, known, modes) and exit
  --invariants         print the invariant catalog (id, meaning) and exit
  --json               with --list or --invariants: print JSON rows instead of a table
  -h, --help           print this help and exit

Flags take "--flag value" or "--flag=value". Put the filter before --trace,
since a bare word after --trace is read as its label.
Env only: SIM_SELFTEST=0 skips the self-tests; CODECAST_SIM_HOME moves the session history.`;

type Parsed = { env: Record<string, string>; action: "run" | "list" | "invariants" | "shrink" | "help"; json: boolean; shrink?: string };

function fail(message: string): never {
  console.error(`sim: ${message}\n\n${HELP}`);
  process.exit(2);
}

function parseArgs(argv: string[]): Parsed {
  const env: Record<string, string> = {};
  let action: Parsed["action"] = "run";
  let json = false;
  let shrink: string | undefined;
  const VALUE_FLAGS: Record<string, string> = { "--seed": "SIM_SEEDS", "--sweep": "SIM_SWEEP", "--out": "SIM_OUT", "--order": "SIM_ORDER" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const next = () => {
      if (inline !== undefined) return inline;
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) fail(`${flag} needs a value${flag === "--order" ? ' (bun run drops an empty "", so write an empty order as --order=)' : ""}`);
      i++;
      return v;
    };
    if (flag in VALUE_FLAGS) {
      const value = next();
      if (flag === "--sweep" && !/^[1-9]\d*$/.test(value)) fail(`--sweep takes a positive integer, got "${value}"`);
      if (flag === "--seed" && !/^\d+(,\d+)*$/.test(value)) fail(`--seed takes comma separated integers, got "${value}"`);
      env[VALUE_FLAGS[flag]] = flag === "--out" ? resolve(value) : value;
    } else if (flag === "--trace") {
      const v = argv[i + 1];
      if (inline !== undefined) env.SIM_TRACE = inline;
      else if (v !== undefined && !v.startsWith("-")) env.SIM_TRACE = argv[++i];
      else env.SIM_TRACE = "1";
    } else if (flag === "--shrink") {
      action = "shrink";
      shrink = next();
    } else if (flag === "--red") env.SIM_RED = "1";
    else if (flag === "--keep") env.SIM_KEEP = "1";
    else if (flag === "--json") json = true;
    else if (flag === "--list") action = "list";
    else if (flag === "--invariants") action = "invariants";
    else if (flag === "-h" || flag === "--help") action = "help";
    else if (arg.startsWith("-")) fail(`unknown flag ${arg}`);
    else if (env.SIM_SCENARIO !== undefined) fail(`one filter only, got "${env.SIM_SCENARIO}" and "${arg}"`);
    else env.SIM_SCENARIO = arg;
  }
  if (json && action !== "list" && action !== "invariants") fail("--json goes with --list or --invariants");
  return { env, action, json, shrink };
}

// The object or array literal starting at `open` (a "{" or "["), by bracket
// depth. Strings are skipped so a bracket inside a name does not end it early.
function objectAt(src: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

// The literal a field holds (`key: {...}` or `key: [...]`), or "" when absent.
function fieldLiteral(obj: string, key: string): string {
  const m = obj.match(new RegExp(`\\b${key}\\s*:\\s*[[{]`));
  return m ? objectAt(obj, m.index! + m[0].length - 1) : "";
}

const stringField = (obj: string, key: string) => obj.match(new RegExp(`\\b${key}\\s*:\\s*(["'\`])((?:\\\\.|(?!\\1).)*)\\1`))?.[2];
// The plain string literals inside a literal (an identifier or a spread names none).
const stringsIn = (literal: string) => [...literal.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
const listField = (obj: string, key: string) => {
  const literal = fieldLiteral(obj, key);
  return literal.startsWith("[") ? literal : "";
};

// Every `scenario({ ... })` call, read statically. A red marker is
// `{ task, invariant }` (modes and seeds optional), `known` maps invariant ids to tasks.
function catalog(filter: string | undefined): SimScenario[] {
  const rows: SimScenario[] = [];
  for (const [dir, suffix] of SCENARIO_DIRS) {
    const abs = join(SIM_ABS, dir);
    if (!existsSync(abs)) continue;
    for (const file of readdirSync(abs).filter((f) => f.endsWith(suffix)).sort()) {
      if (filter && !file.includes(filter)) continue;
      const src = readFileSync(join(abs, file), "utf8");
      for (const m of src.matchAll(/\bscenario\(\s*\{/g)) {
        const obj = objectAt(src, m.index! + m[0].length - 1);
        const redLiteral = fieldLiteral(obj, "red");
        // A marker's own modes scope the marker; the scenario's sit outside it.
        const modes = listField(obj.replace(redLiteral, ""), "modes");
        const red = [...redLiteral.matchAll(/\{[^{}]*\}/g)].map(([marker]): SimMarker => {
          const seeds = listField(marker, "seeds");
          return {
            task: stringField(marker, "task") ?? "",
            invariant: stringField(marker, "invariant") ?? "",
            modes: listField(marker, "modes") ? stringsIn(listField(marker, "modes")) : null,
            seeds: seeds ? (seeds.match(/\d+/g) ?? []).map(Number) : null,
          };
        });
        const known = [...fieldLiteral(obj, "known").matchAll(/["']([\w-]+)["']\s*:\s*(\[[^\]]*\]|["'][\w-]+["'])/g)].map((k) => ({ invariant: k[1], tasks: k[2].match(/[\w-]+/g)! }));
        rows.push({ name: stringField(obj, "name") ?? "(unnamed)", file: `${dir}/${file}`, selftest: dir === "selftests", modes: modes ? stringsIn(modes) : DEFAULT_MODES, red, known });
      }
    }
  }
  return rows;
}

const redText = (r: SimScenario) =>
  r.red.map((m) => {
    const scope = [m.modes?.join(","), m.seeds && `seeds ${m.seeds.join(",")}`].filter(Boolean).join(" ");
    return `${m.task} ${m.invariant}${scope ? ` (${scope})` : ""}`;
  }).join("; ");

function listScenarios(filter: string | undefined, json: boolean) {
  const rows = catalog(filter);
  if (json) return console.log(JSON.stringify(rows, null, 1));
  if (rows.length === 0) {
    console.log(`No scenarios${filter ? ` matching "${filter}"` : ""} under ${SIM_DIR}/{scenarios,selftests}.`);
    return;
  }
  printTable(["name", "red", "known", "modes", "file"], rows.map((r) => [r.name, redText(r) || "-", r.known.map((k) => `${k.tasks.join(",")} ${k.invariant}`).join("; ") || "-", r.modes.join(","), r.file]));
  console.log(`\nNext: bun run sim ${fileStem(rows[0].file)}${rows.every((r) => r.red.length) ? " --red" : ""}`);
}

// The filter a scenario's file answers to: its name without the directory and suffix.
const fileStem = (file: string) => file.slice(file.indexOf("/") + 1).replace(/\.(scenario|selftest)\.ts$/, "");
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What a filter runs: the files whose name contains it, else the one
 * scenario of exactly that name (replay lines name a scenario, and a file can
 * hold several), narrowed with bun's test name pattern. Else the closest names.
 */
function resolveFilter(filter: string): { scenarioEnv: string; namePattern?: string } {
  if (catalog(filter).length) return { scenarioEnv: filter };
  const all = catalog(undefined);
  const named = all.find((r) => r.name === filter);
  if (named) return { scenarioEnv: fileStem(named.file), namePattern: `^${escapeRegex(named.name)} ` };
  const names = [...new Set([...all.map((r) => fileStem(r.file)), ...all.map((r) => r.name)])];
  const near = names.sort((a, b) => levenshtein(filter.toLowerCase(), a.toLowerCase()) - levenshtein(filter.toLowerCase(), b.toLowerCase())).slice(0, 3);
  console.error(`sim: no scenario or self-test file matches "${filter}". Closest: ${near.join(", ")}. bun run sim --list prints them all.`);
  process.exit(2);
}

function invariantCatalog(): SimInvariant[] {
  const file = join(SIM_ABS, "invariants.ts");
  const src = existsSync(file) ? readFileSync(file, "utf8") : "";
  const rows: SimInvariant[] = [];
  for (const m of src.matchAll(/\bid\s*:\s*["'](INV-[\w-]+)["']/g)) {
    // The meaning and keys are the first such fields after the id, inside the same entry.
    const rest = src.slice(m.index! + m[0].length);
    const end = rest.search(/\bid\s*:\s*["']INV-/);
    const entry = end < 0 ? rest : rest.slice(0, end);
    rows.push({ id: m[1], meaning: stringField(entry, "meaning") ?? "", keys: stringsIn(listField(entry, "keys")) });
  }
  return rows;
}

function listInvariants(json: boolean) {
  const rows = invariantCatalog();
  if (json) return console.log(JSON.stringify(rows, null, 1));
  if (rows.length === 0) {
    console.log(`No invariants in ${SIM_DIR}/invariants.ts.`);
    return;
  }
  printTable(["id", "meaning"], rows.map((r) => [r.id, r.meaning]));
  console.log("\nNext: bun run sim --list (the scenarios these are checked on)");
}

function printTable(head: string[], rows: string[][]) {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join("  ");
  console.log(line(head));
  for (const r of rows) console.log(line(r));
}

// The sim's env vars, dropped from what a shrink attempt inherits.
const withoutSimEnv = (env: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("SIM_")));

function readResult(dir: string): SimResult | null {
  try {
    return JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as SimResult;
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string, value: unknown) {
  writeFileSync(`${path}.${process.pid}.tmp`, JSON.stringify(value, null, 1) + "\n");
  renameSync(`${path}.${process.pid}.tmp`, path);
}

/**
 * --shrink: replays the failure's recorded order, cut down, as one bun test
 * subprocess per candidate (the scenario alone, at its seed, under SIM_ORDER),
 * and keeps a candidate only when it fails on the same invariant and the same
 * row (table and label). minimal.json.tmp holds the progress while it runs.
 */
async function shrink(dirArg: string): Promise<number> {
  const dir = resolve(dirArg);
  const result = readResult(dir);
  if (!result) fail(`no result.json in ${dir}`);
  if (result.passed) fail(`${dir} holds a passing run; --shrink takes a failure's artifact folder`);
  const failure = result as SimFailureResult;
  const scenario = catalog(undefined).find((r) => r.name === failure.scenario);
  if (!scenario) fail(`no scenario named "${failure.scenario}" under ${SIM_DIR}; only bun run sim failures shrink`);

  // The known check (nothing left out) is the scenario's other test at that seed.
  const known = basename(dir).endsWith("-known");
  const namePattern = `^${escapeRegex(scenario.name)} order seed ${failure.seed}${known ? ", nothing left out" : "( \\(|$)"}`;
  const rowKey = (r: SimResult | null) => (r && !r.passed && r.row ? `${r.row.table}/${r.row.label}` : null);
  const target = { invariant: failure.invariant.id, row: rowKey(failure) };
  const { mark, channels } = splitOrderLine(parseOrder(failure.order));
  const lineOf = (kept: readonly number[]) => formatOrder([...(mark ? [mark] : []), ...kept.map((i) => channels[i])]);

  const work = mkdtempSync(join(tmpdir(), "sim-shrink-"));
  const attemptDir = join(work, `${scenario.name}-order-${failure.seed}${known ? "-known" : ""}`);
  const env = {
    ...withoutSimEnv(process.env),
    SIM_SCENARIO: fileStem(scenario.file),
    SIM_SEEDS: String(failure.seed),
    SIM_OUT: work,
    ...(scenario.selftest ? {} : { SIM_SELFTEST: "0" }),
  };
  const deadline = Date.now() + SHRINK_MAX_MS;
  const progressPath = join(dir, "minimal.json.tmp");
  console.error(`sim shrink: ${failure.scenario} [${failure.mode} seed ${failure.seed}], ${target.invariant}${target.row ? ` on ${target.row}` : ""}; ${channels.length} recorded deliveries; caps ${SHRINK_MAX_ATTEMPTS} attempts, ${SHRINK_MAX_MS / 60_000} minutes`);

  const reproduces = async (kept: number[]): Promise<boolean> => {
    rmSync(attemptDir, { recursive: true, force: true });
    const proc = Bun.spawn([process.execPath, "test", `${SIM_DIR}/sim.test.ts`, "--isolate", "-t", namePattern], {
      cwd: WEB_ROOT,
      env: { ...env, SIM_ORDER: lineOf(kept) },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => proc.kill(), Math.max(0, deadline - Date.now()));
    await proc.exited;
    clearTimeout(timer);
    const got = readResult(attemptDir);
    const same = Boolean(got && !got.passed && got.invariant.id === target.invariant && rowKey(got) === target.row);
    const saw = !got ? "no result (crashed or timed out)" : got.passed ? "passed" : `${got.invariant.id}${rowKey(got) ? ` on ${rowKey(got)}` : ""}`;
    console.error(`  ${kept.length} entries: ${same ? "fails the same way" : `not reproduced (${saw})`}`);
    return same;
  };

  try {
    const r = await shrinkOrder(channels.length, reproduces, {
      onProgress: (p: SimShrinkProgress) => writeJsonAtomic(progressPath, p),
    });
    if (!r.reproduced) {
      console.error(`sim shrink: the recorded order no longer fails the same way at this tree; nothing written.`);
      return 1;
    }
    const minimal: SimMinimal = { order: r.kept.map((i) => channels[i]), removed: r.removed, attempts: r.attempts, ms: r.ms, oneMinimal: r.oneMinimal };
    writeJsonAtomic(join(dir, "minimal.json"), minimal);
    const minimalOrder = lineOf(r.kept);
    writeJsonAtomic(join(dir, "result.json"), { ...failure, minimalOrder });
    // The report's own replay lines, plus the minimal one. report.ts loads the
    // convex denylist, so it is imported only here, never on --list.
    const { replayCommands } = await import("../store/__tests__/sim/report");
    console.log(
      [
        `${channels.length} recorded, ${r.kept.length} needed${r.oneMinimal ? " (1-minimal)" : " (a cap stopped the search; not 1-minimal)"}; ${r.attempts} attempts in ${Math.round(r.ms / 1000)}s`,
        `minimal: ${join(dir, "minimal.json")}`,
        "replay:",
        ...replayCommands(failure.scenario, failure.seed, parseOrder(failure.order), failure.row?.label ?? null, parseOrder(minimalOrder)).map((l) => `  ${l}`),
      ].join("\n"),
    );
    return 0;
  } finally {
    rmSync(progressPath, { force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

// One `bun run sim`: a session folder around one bun test process. The tree
// patch is computed while the tests run.
async function run(env: Record<string, string>, argv: string[]): Promise<number> {
  // A filtered run spawns only the file that registers the scenarios, so the
  // sim's other test files (net, report, the slots guard) do not run with it.
  const filter = env.SIM_SCENARIO !== undefined ? resolveFilter(env.SIM_SCENARIO) : null;
  if (filter) env.SIM_SCENARIO = filter.scenarioEnv;
  const tree = treeState(REPO_ROOT);
  const { dir, session } = openSession(argv, tree);
  const patch = tree.dirty ? storeTreePatch(REPO_ROOT).catch(() => null) : Promise.resolve(null);
  const target = filter ? `${SIM_DIR}/sim.test.ts` : `${SIM_DIR}/`;
  const proc = Bun.spawn([process.execPath, "test", target, "--isolate", ...(filter?.namePattern ? ["-t", filter.namePattern] : [])], {
    cwd: WEB_ROOT,
    env: { ...process.env, ...env, SIM_SESSION: dir },
    stdio: ["inherit", "inherit", "inherit"],
  });
  // Ctrl-C reaches the test process too; wait for it so the session records the exit.
  process.on("SIGINT", () => {});
  const exit = await proc.exited;
  closeSession(dir, session, exit, await patch);
  pruneSessions();
  console.error(`\nsim session: ${dir}`);
  return exit;
}

const { env, action, json, shrink: shrinkDir } = parseArgs(process.argv.slice(2));
if (action === "help") console.log(HELP);
else if (action === "list") listScenarios(env.SIM_SCENARIO, json);
else if (action === "invariants") listInvariants(json);
else if (action === "shrink") process.exit(await shrink(shrinkDir!));
else process.exit(await run(env, process.argv.slice(2)));
