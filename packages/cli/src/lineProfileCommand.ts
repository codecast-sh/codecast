// `cast line profile`, `cast line set|unset|finder` and `cast line
// eval-result` (docs/architecture/line-profile.md LP2, LP4): the repo's
// resolved line profile, edits to it, and the eval station's verdict built
// from the reps a project's eval command wrote. An edit goes through the
// same editor the app's settings page uses (lineProfileEdit.ts): one key in
// place with comments kept, checked by the loader before anything is
// written, then published.
//
//   cast line profile [--json] [--publish]
//   cast line set <key> <value...> | unset <key> [--no-publish] [--json]
//   cast line finder set <id> [--source] [--kind] [--fingerprint] [--runs] [--project] | rm <id>
//   cast line station set <id> [--prompt-file] [--script-file] [--timeout] | reset <id>
//   cast line profile --starter --project <name> [--team <name>] [--write]
//   cast line eval-result --reps <reps.json> --out <eval-result.json> [--json]
import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { buildEvalResult, evalResultLines, repsFileProblem, unscoredSurfaces } from "@platform/evals/analysis";
import type { EvalRepsFile } from "@platform/evals/contract";
import { fmt } from "./colors.js";
import { findLineProfile, formatLineProfile, LINE_PROFILE_REL_PATH, LineProfileError, loadLineProfile, starterLineProfile, type LineFinder, type ResolvedLineProfile } from "./lineProfile.js";
import { runLineProfileEdit, type LineProfileEditReply, type PublishOutcome } from "./lineProfileEdit.js";
import { atomicWriteFile } from "./atomicWrite.js";
import { publishedRepoLine } from "./repoLine.js";
import { apiPost, type PublishDeps } from "./castApi.js";
import { LINE_VALUE_KINDS, parseLineValue, splitFinderKind, type LineFinderInput, type LineProfileEdit, type LineProfileFacts, type LineStationPatch } from "@codecast/shared/contracts/lineProfile";

function fail(message: string, code = 2): never {
  console.error(fmt.error(message));
  process.exit(code);
}

/**
 * Build eval-result.json from reps.json and write it. Returns the station's
 * exit code: 0 when the result is ok, 1 when it is not. A reps file that
 * cannot be read is a usage error (2), never a pass.
 */
export function runEvalResult(repsPath: string, outPath: string): { code: number; lines: string[]; result: ReturnType<typeof buildEvalResult> } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(repsPath, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${repsPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const problem = repsFileProblem(raw);
  if (problem) throw new Error(`${repsPath}: ${problem}`);
  const result = buildEvalResult(raw as EvalRepsFile);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  // 2: the eval could not judge the change (a side with no scored rep), so the
  // line stops instead of sending the builder back over missing evidence.
  const unscored = unscoredSurfaces(raw as EvalRepsFile);
  return { code: result.ok ? 0 : unscored.length ? 2 : 1, lines: evalResultLines(result), result };
}

export type PublishGroup = { project: string; default: boolean; finders: Array<Omit<LineFinder, "project">> };

/**
 * What `--publish` sends (LP3): the declared finders grouped by the project
 * each files into (its own `project`, else the profile's). The profile's
 * default project is always a group, finders or none, so /line can tell
 * which project a checkout serves. Finders with no project at all are
 * returned apart: they file into the workspace and no project page shows them.
 */
export function publishGroups(r: ResolvedLineProfile): { groups: PublishGroup[]; unprojected: string[] } {
  const p = r.profile;
  const groups = new Map<string, PublishGroup>();
  const group = (project: string) => {
    let g = groups.get(project);
    if (!g) { g = { project, default: project === p.project, finders: [] }; groups.set(project, g); }
    return g;
  };
  if (p.project) group(p.project);
  const unprojected: string[] = [];
  for (const { project, ...finder } of p.finders) {
    const target = project ?? p.project;
    if (target) group(target).finders.push(finder);
    else unprojected.push(finder.id);
  }
  return { groups: [...groups.values()], unprojected };
}

/**
 * The rest of the resolved profile, sent with every publish so the app shows
 * the whole line without a daemon round trip: every value but the finders
 * (those ride their groups), where each came from, and the file's path
 * relative to the root it was found under.
 */
export function publishFacts(r: ResolvedLineProfile): LineProfileFacts {
  const { finders: _finders, ...values } = r.profile;
  const file = r.file ? (r.root ? path.relative(r.root, r.file) : r.file) : null;
  // The repo's own line rides along when it has one (line-map.md LX5), so the
  // app mirrors the graph and prompts the repo holds and the version a run records.
  const line = publishedRepoLine(r.root);
  return { ...values, sources: r.sources, notes: r.notes, warnings: r.warnings, file, ...(line ? { line } : {}) };
}

/**
 * Publish a resolved profile onto its projects (LP3), where `cast signal add`
 * from this checkout would write. Throws LineProfileError when the profile
 * names no project, since there is nowhere to put it.
 */
export async function publishLineProfile(deps: PublishDeps, resolved: ResolvedLineProfile): Promise<{ projects: Array<{ project: string; short_id?: string; title: string; finders: number; changed: boolean }>; unprojected: string[] }> {
  const { groups, unprojected } = publishGroups(resolved);
  if (!groups.length) throw new LineProfileError(`nothing to publish: the profile names no project (${resolved.file ?? "no .codecast/line.toml"})`);
  const { scopeFor } = await import("./signalCommand.js");
  const { deviceId } = await import("./remote/device.js");
  const result = await apiPost(deps, "/cli/line/profile/publish", {
    ...(await scopeFor(deps, undefined, true)),
    root: resolved.root ?? undefined,
    groups,
    profile: publishFacts(resolved),
    device_id: deviceId(),
  });
  return { projects: result.projects ?? [], unprojected };
}

/**
 * Apply edits to this checkout's line profile: in place, checked by the
 * loader, written atomically, then published unless `publish` is false.
 * A failed publish keeps the write and says why in `published`.
 */
export async function editThisLineProfile(deps: PublishDeps, edits: LineProfileEdit[], opts: { publish: boolean; cwd?: string }): Promise<LineProfileEditReply> {
  const { root } = findLineProfile(opts.cwd ?? (process.env.CODECAST_CWD || process.cwd()));
  if (!root) throw new LineProfileError("not inside a repository: run from the checkout whose line this is");
  return runLineProfileEdit({ root, edits }, {
    admit: async (file) => file,
    write: (file, content) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      atomicWriteFile(file, content, fs.existsSync(file) ? {} : { mode: 0o644 });
    },
    ...(opts.publish ? {
      publish: async (r: string): Promise<PublishOutcome> => {
        try {
          await publishLineProfile(deps, loadLineProfile(r));
          return { ok: true };
        } catch (err) {
          return { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
      },
    } : {}),
  });
}

/** A finder as `cast line finder set` was told it, over the one the profile declares by that id. */
export function finderEdit(current: LineFinder | undefined, id: string, given: { source?: string; kind?: string; fingerprint?: string; runs?: string; project?: string }): LineFinderInput {
  const base: Partial<LineFinderInput> = current ? { ...current, kind: current.kind } : {};
  const next: Partial<LineFinderInput> = { ...base, id };
  if (given.source !== undefined) next.source = given.source;
  if (given.kind !== undefined) next.kind = splitFinderKind(given.kind);
  if (given.fingerprint !== undefined) next.fingerprint = given.fingerprint;
  for (const k of ["runs", "project"] as const) {
    if (given[k] === undefined) continue;
    if (given[k]!.trim()) next[k] = given[k];
    else delete next[k];
  }
  const missing = (["source", "kind", "fingerprint"] as const).filter((k) => !next[k] || (Array.isArray(next[k]) && !next[k]!.length));
  if (missing.length) throw new LineProfileError(`a new finder needs ${missing.map((k) => `--${k}`).join(", ")}`);
  return next as LineFinderInput;
}

const valueText = (v: unknown) => (v == null ? "unset" : Array.isArray(v) ? v.join(", ") || "none" : String(v));
const getPath = (obj: any, key: string) => key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** What an edit says back: each key it touched, as the file now resolves it, then the publish. */
function reportEdit(reply: LineProfileEditReply, keys: string[], json?: boolean): void {
  const { content: _content, ...rest } = reply;
  if (json) { console.log(JSON.stringify(rest, null, 2)); return; }
  for (const key of keys) {
    if (key.startsWith("stations.")) {
      const id = key.slice("stations.".length);
      const l = reply.line;
      console.log(!l?.changed ? `station ${id}  unchanged` : `station ${id}  ${l.stations.includes(id) ? "changed" : "unchanged"}  line ${l.graph_hash}${l.materialized ? `  (wrote the line out to ${path.dirname(l.file)})` : ""}`);
    } else if (key.startsWith("finders.")) {
      const id = key.slice("finders.".length);
      const f = reply.profile.finders.find((x) => x.id === id);
      console.log(f ? `finder ${f.id}  ${f.source}  ${f.kind === "any" ? "any" : f.kind.join(", ")}  ${f.fingerprint}${f.runs ? `  runs ${f.runs}` : ""}` : `finder ${id}  removed`);
    } else {
      console.log(`${key} = ${valueText(getPath(reply.profile, key))}  (${reply.sources[key] ?? "default"})`);
    }
  }
  const wrote = reply.line?.changed ? reply.line.file : reply.file;
  if (!reply.changed) console.log(fmt.muted(`unchanged: ${wrote}`));
  else if (!reply.published) console.log(fmt.muted(`wrote ${wrote}; not published`));
  else if (reply.published.ok === true) console.log(fmt.muted(`wrote ${wrote}; published`));
  else console.log(fmt.warning(`wrote ${wrote}; the publish failed: ${reply.published.detail ?? "no detail"}`));
  for (const w of reply.warnings) console.log(fmt.warning(w));
}

export function registerLineProfileCommands(line: Command, deps: PublishDeps): void {
  const run = async (edits: LineProfileEdit[], options: { publish?: boolean; json?: boolean }, keys: string[]) => {
    try {
      reportEdit(await editThisLineProfile(deps, edits, { publish: options.publish !== false }), keys, options.json);
    } catch (err) {
      if (err instanceof LineProfileError) fail(err.message);
      throw err;
    }
  };
  const keyList = Object.keys(LINE_VALUE_KINDS).join(", ");

  line
    .command("set <key> <value...>")
    .description(`Set one value in this repo's .codecast/line.toml, in place with comments kept, checked before it is written, then published so the app shows it. Keys: ${keyList}`)
    .option("--no-publish", "Write the file only")
    .option("--json", "Machine-readable output")
    .action(async (key: string, values: string[], options: { publish?: boolean; json?: boolean }) => {
      const text = LINE_VALUE_KINDS[key] === "list" ? values.join("\n") : values.join(" ");
      const parsed = parseLineValue(key, text);
      if ("error" in parsed) fail(`${key}: ${parsed.error}`);
      await run([{ op: "set", key, value: parsed.value }], options, [key]);
    });

  line
    .command("unset <key>")
    .description("Remove one value from this repo's .codecast/line.toml, so the line uses its default; then publish")
    .option("--no-publish", "Write the file only")
    .option("--json", "Machine-readable output")
    .action(async (key: string, options: { publish?: boolean; json?: boolean }) => {
      if (!LINE_VALUE_KINDS[key]) fail(`unknown key "${key}" (known: ${keyList})`);
      await run([{ op: "remove", key }], options, [key]);
    });

  const finder = line.command("finder").description("Add, change or remove a finder (a source that files signals into this line) in this repo's .codecast/line.toml");
  finder
    .command("set <id>")
    .description("Add a finder, or change the one with this id; only the parts given change")
    .option("--source <name>", "The tool its reports come from (sentry, evals, a person)")
    .option("--kind <kinds>", "What it reports: bug, regression, prompt_miss, ux, cohesion, request, comma separated, or any")
    .option("--fingerprint <pattern>", "How its reports group into one problem")
    .option("--runs <what>", "What runs it, if anything here does (empty clears it)")
    .option("--project <name>", "The project its signals go to, when not the profile's (empty clears it)")
    .option("--no-publish", "Write the file only")
    .option("--json", "Machine-readable output")
    .action(async (id: string, options: { source?: string; kind?: string; fingerprint?: string; runs?: string; project?: string; publish?: boolean; json?: boolean }) => {
      let input: LineFinderInput;
      try {
        const current = loadLineProfile().profile.finders.find((f) => f.id === id);
        input = finderEdit(current, id, options);
      } catch (err) {
        if (err instanceof LineProfileError) fail(err.message);
        throw err;
      }
      await run([{ op: "set_finder", finder: input }], options, [`finders.${id}`]);
    });
  finder
    .command("rm <id>")
    .description("Remove the finder with this id")
    .option("--no-publish", "Write the file only")
    .option("--json", "Machine-readable output")
    .action(async (id: string, options: { publish?: boolean; json?: boolean }) => {
      await run([{ op: "remove_finder", id }], options, [`finders.${id}`]);
    });

  // The repo's own line (line-map.md LX5): one station's prompt, script or
  // timeout, through the same checked edit as the app's, then published.
  const station = line.command("station").description("Change one station of this repo's own line (.codecast/line/), written out from the shipped line the first time; checked before it is written, then published");
  station
    .command("set <id>")
    .description("Set a station's prompt, script or timeout; only the parts given change")
    .option("--prompt-file <path>", "The station's prompt, from a file (- reads stdin)")
    .option("--script-file <path>", "The station's script, from a file (- reads stdin)")
    .option("--timeout <minutes>", "How long the station may run, in minutes (0 removes the limit)")
    .option("--no-publish", "Write the files only")
    .option("--json", "Machine-readable output")
    .action(async (id: string, options: { promptFile?: string; scriptFile?: string; timeout?: string; publish?: boolean; json?: boolean }) => {
      const readText = (p: string) => fs.readFileSync(p === "-" ? 0 : p, "utf8");
      const edit: { op: "set_station"; station: string } & LineStationPatch = { op: "set_station", station: id };
      if (options.promptFile !== undefined) edit.prompt = readText(options.promptFile);
      if (options.scriptFile !== undefined) edit.script = readText(options.scriptFile);
      if (options.timeout !== undefined) {
        const m = Number(options.timeout);
        if (!Number.isFinite(m) || m < 0) fail("--timeout is minutes, 0 or more");
        edit.timeout = m > 0 ? Math.round(m * 60) : null;
      }
      if (Object.keys(edit).length === 2) fail("say what changes: --prompt-file, --script-file or --timeout");
      await run([edit], options, [`stations.${id}`]);
    });
  station
    .command("reset <id>")
    .description("Put a station back to the shipped line's prompt, script and timeout")
    .option("--no-publish", "Write the files only")
    .option("--json", "Machine-readable output")
    .action(async (id: string, options: { publish?: boolean; json?: boolean }) => {
      await run([{ op: "reset_station", station: id }], options, [`stations.${id}`]);
    });

  line
    .command("profile")
    .description("The line profile for this directory (.codecast/line.toml merged with the defaults), each value with where it came from")
    .option("--json", "Machine-readable output")
    .option("--publish", "Publish this profile onto the projects its finders file into, so the app shows the whole line and /line says when a finder goes silent")
    .option("--starter", "Print a starter .codecast/line.toml for a repository that has none: the defaults written out, the project filled in")
    .option("--project <name>", "With --starter: the project its signals and line belong to")
    .option("--team <name>", "With --starter: the workspace for writes from this repo")
    .option("--write", "With --starter: write it at the repository root; refused when a profile already exists")
    .action(async (options: { json?: boolean; publish?: boolean; starter?: boolean; project?: string; team?: string; write?: boolean }) => {
      if (options.starter) {
        if (!options.project?.trim()) fail("--starter needs --project <name>: the project this repository's line serves");
        const text = starterLineProfile({ project: options.project.trim(), team: options.team?.trim() || null });
        if (!options.write) { process.stdout.write(text); return; }
        const { file, root } = findLineProfile(process.env.CODECAST_CWD || process.cwd());
        if (file) fail(`${file} already exists; edit it rather than replacing it`);
        if (!root) fail("not inside a repository: run from the checkout whose line this is");
        const target = path.join(root, LINE_PROFILE_REL_PATH);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text, { flag: "wx" });
        console.log(`wrote ${target}`);
        return;
      }
      let resolved: ResolvedLineProfile;
      try {
        resolved = loadLineProfile();
      } catch (err) {
        if (err instanceof LineProfileError) fail(err.message);
        throw err;
      }
      if (!options.publish) {
        if (options.json) console.log(JSON.stringify(resolved, null, 2));
        else process.stdout.write(formatLineProfile(resolved));
        return;
      }
      let result: Awaited<ReturnType<typeof publishLineProfile>>;
      try {
        result = await publishLineProfile(deps, resolved);
      } catch (err) {
        if (err instanceof LineProfileError) fail(err.message);
        throw err;
      }
      const { unprojected } = result;
      if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }
      for (const p of result.projects) {
        console.log(`${p.short_id ?? p.project}  ${p.title}  ${p.finders} finder${p.finders === 1 ? "" : "s"}  ${p.changed ? "published" : "unchanged"}`);
      }
      if (unprojected.length) console.log(fmt.warning(`not published, no project: ${unprojected.join(", ")} (give each a project, or set [line] project)`));
    });

  line
    .command("eval-result")
    .description("Build eval-result.json (what the change card reads) from the reps.json a project's eval command wrote; exits 0 when the eval station passes, 1 when the change fails it, 2 when a surface has no scored rep on a side")
    .requiredOption("--reps <file>", "reps.json: per surface, per freeze, per side, the reps (line-profile.md LP4)")
    .requiredOption("--out <file>", "Where to write eval-result.json")
    .option("--json", "Print the result instead of the report")
    .action((options: { reps: string; out: string; json?: boolean }) => {
      let run: ReturnType<typeof runEvalResult>;
      try {
        run = runEvalResult(options.reps, options.out);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
      if (options.json) console.log(JSON.stringify(run.result, null, 2));
      else {
        for (const l of run.lines) console.log(l);
        console.log(`\n${run.result.ok ? "pass" : "fail"}  wrote ${options.out}`);
      }
      process.exitCode = run.code;
    });
}
