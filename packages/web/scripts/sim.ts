// `bun run sim`: the multiplayer simulation harness runner
// (docs/architecture/multiplayer-sim-harness.md, section 3.8).
//
// It only turns flags into SIM_* env vars and spawns
// `bun test store/__tests__/sim/ --isolate`. The env vars stay the source of
// truth, so a bare `SIM_SEEDS=3 bun test store/__tests__/sim/` behaves the same.
// `--list` and `--invariants` read the source statically and never import the
// store, so they answer at once.
//
// Run from packages/web: bun run sim [filter] [flags]

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const WEB_ROOT = join(import.meta.dir, "..");
const SIM_DIR = "store/__tests__/sim";
const SIM_ABS = join(WEB_ROOT, SIM_DIR);
const SCENARIO_DIRS: [dir: string, suffix: string][] = [["scenarios", ".scenario.ts"], ["selftests", ".selftest.ts"]];
// The DSL's default modes (section 3.8), shown when a scenario names none.
const DEFAULT_MODES = ["scripted", "interleave"];

const HELP = `bun run sim [filter] [flags]

Runs the sim scenarios and self-tests (bun test ${SIM_DIR}/ --isolate).

  filter               run only scenario and self-test files whose name contains it   SIM_SCENARIO
  --seed a,b           pin the seeds                                                   SIM_SEEDS
  --sweep N            widen each scenario to N seeds                                  SIM_SWEEP
  --trace [label]      stream deliveries touching label (every delivery if omitted)    SIM_TRACE
  --red                run only the red (expected-failing) scenarios                   SIM_RED=1
  --out dir            write run artifacts under dir, on a pass too                    SIM_OUT
  --order "<channels>" replay one delivery order, as a report's --order line prints it SIM_ORDER
  --list               print the scenario catalog (name, red task, modes) and exit
  --invariants         print the invariant catalog (id, meaning) and exit
  -h, --help           print this help and exit

Flags take "--flag value" or "--flag=value". Put the filter before --trace,
since a bare word after --trace is read as its label.
Env only: SIM_SELFTEST=0 skips the self-tests.`;

type Parsed = { env: Record<string, string>; action: "run" | "list" | "invariants" | "help" };

function fail(message: string): never {
  console.error(`sim: ${message}\n\n${HELP}`);
  process.exit(2);
}

function parseArgs(argv: string[]): Parsed {
  const env: Record<string, string> = {};
  let action: Parsed["action"] = "run";
  const VALUE_FLAGS: Record<string, string> = { "--seed": "SIM_SEEDS", "--sweep": "SIM_SWEEP", "--out": "SIM_OUT", "--order": "SIM_ORDER" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const next = () => {
      if (inline !== undefined) return inline;
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) fail(`${flag} needs a value`);
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
    } else if (flag === "--red") env.SIM_RED = "1";
    else if (flag === "--list") action = "list";
    else if (flag === "--invariants") action = "invariants";
    else if (flag === "-h" || flag === "--help") action = "help";
    else if (arg.startsWith("-")) fail(`unknown flag ${arg}`);
    else if (env.SIM_SCENARIO !== undefined) fail(`one filter only, got "${env.SIM_SCENARIO}" and "${arg}"`);
    else env.SIM_SCENARIO = arg;
  }
  return { env, action };
}

// The object literal starting at `open` (a "{"), by brace depth. Strings are
// skipped so a brace inside a name does not end it early.
function objectAt(src: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

const stringField = (obj: string, key: string) => obj.match(new RegExp(`\\b${key}\\s*:\\s*(["'\`])((?:\\\\.|(?!\\1).)*)\\1`))?.[2];

function listScenarios(filter: string | undefined) {
  const rows: { name: string; red: string; modes: string; file: string }[] = [];
  for (const [dir, suffix] of SCENARIO_DIRS) {
    const abs = join(SIM_ABS, dir);
    if (!existsSync(abs)) continue;
    for (const file of readdirSync(abs).filter((f) => f.endsWith(suffix)).sort()) {
      if (filter && !file.includes(filter)) continue;
      const src = readFileSync(join(abs, file), "utf8");
      for (const m of src.matchAll(/\bscenario\(\s*\{/g)) {
        const obj = objectAt(src, m.index! + m[0].length - 1);
        const modes = obj.match(/\bmodes\s*:\s*\[([^\]]*)\]/)?.[1].match(/[a-z]+/g) ?? DEFAULT_MODES;
        rows.push({ name: stringField(obj, "name") ?? "(unnamed)", red: stringField(obj, "red") ?? "", modes: modes.join(","), file: `${dir}/${file}` });
      }
    }
  }
  if (rows.length === 0) {
    console.log(`No scenarios${filter ? ` matching "${filter}"` : ""} under ${SIM_DIR}/{scenarios,selftests}.`);
    return;
  }
  printTable(["name", "red", "modes", "file"], rows.map((r) => [r.name, r.red || "-", r.modes, r.file]));
}

function listInvariants() {
  const file = join(SIM_ABS, "invariants.ts");
  const src = existsSync(file) ? readFileSync(file, "utf8") : "";
  const rows: string[][] = [];
  for (const m of src.matchAll(/\bid\s*:\s*["'](INV-[\w-]+)["']/g)) {
    // The meaning is the first string field after the id, inside the same entry.
    const rest = src.slice(m.index! + m[0].length);
    const end = rest.search(/\bid\s*:\s*["']INV-/);
    rows.push([m[1], stringField(end < 0 ? rest : rest.slice(0, end), "meaning") ?? ""]);
  }
  if (rows.length === 0) {
    console.log(`No invariants in ${SIM_DIR}/invariants.ts.`);
    return;
  }
  printTable(["id", "meaning"], rows);
}

function printTable(head: string[], rows: string[][]) {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join("  ");
  console.log(line(head));
  for (const r of rows) console.log(line(r));
}

const { env, action } = parseArgs(process.argv.slice(2));
if (action === "help") console.log(HELP);
else if (action === "list") listScenarios(env.SIM_SCENARIO);
else if (action === "invariants") listInvariants();
else {
  const proc = Bun.spawn([process.execPath, "test", `${SIM_DIR}/`, "--isolate"], {
    cwd: WEB_ROOT,
    env: { ...process.env, ...env },
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(await proc.exited);
}
