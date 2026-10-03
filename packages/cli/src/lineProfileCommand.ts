// `cast line profile` and `cast line eval-result` (docs/architecture/
// line-profile.md LP2, LP4): the repo's resolved line profile, and the eval
// station's verdict built from the reps a project's eval command wrote.
//
//   cast line profile [--json] [--publish]
//   cast line profile --starter --project <name> [--team <name>] [--write]
//   cast line eval-result --reps <reps.json> --out <eval-result.json> [--json]
import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import type { EvalRepsFile } from "@codecast/shared/contracts/evalResult";
import { buildEvalResult, evalResultLines, repsFileProblem, unscoredSurfaces } from "../../evals/src/evalResult.js";
import { fmt } from "./colors.js";
import { findLineProfile, formatLineProfile, LINE_PROFILE_REL_PATH, LineProfileError, loadLineProfile, starterLineProfile, type LineFinder, type ResolvedLineProfile } from "./lineProfile.js";
import { apiPost, type PublishDeps } from "./castApi.js";

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

export function registerLineProfileCommands(line: Command, deps: PublishDeps): void {
  line
    .command("profile")
    .description("The line profile for this directory (.codecast/line.toml merged with the defaults), each value with where it came from")
    .option("--json", "Machine-readable output")
    .option("--publish", "Declare this profile's finders on the projects they file into, so /line shows each one and says when it goes silent")
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
      const { groups, unprojected } = publishGroups(resolved);
      if (!groups.length) fail(`nothing to publish: the profile names no project (${resolved.file ?? "no .codecast/line.toml"})`);
      // The write lands where `cast signal add` from this checkout would.
      const { scopeFor } = await import("./signalCommand.js");
      const result = await apiPost(deps, "/cli/line/profile/publish", { ...(await scopeFor(deps, undefined, true)), root: resolved.root ?? undefined, groups });
      if (options.json) { console.log(JSON.stringify({ ...result, unprojected }, null, 2)); return; }
      for (const p of result.projects ?? []) {
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
