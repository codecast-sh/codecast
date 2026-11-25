/**
 * The body of `cast check`: which projects to ask about, then one shared
 * watcher's answer for each (check.ts). Kept off index.ts's static import
 * graph; index.ts loads it when the command runs.
 */

import { fmt } from "./colors.js";

export async function runCheckCommand(projects: string[], o: { fresh?: boolean; json?: boolean; changedSince?: string; all?: boolean }): Promise<void> {
  const { logWatcherEvent, repoRoot, resolveProjects, watchDir } = await import("./check.js");
  const { askCheck } = await import("./checkBun.js");
  const { gitPaths, projectsForAsk, projectsTouching } = await import("./checkAffected.js");
  const root = repoRoot();
  // What the ask named against what it resolved to, so an audit can tell a bare ask from a named one.
  const mode = o.changedSince ? "changed-since" : projects.length ? "named" : o.all ? "all" : "bare";
  const logAsk = (resolved: Array<{ name: string }>) => logWatcherEvent("ask", { project: resolved.map((p) => p.name).join(",") || "-", root }, `mode=${mode} named=${projects.join(",") || "-"}`);
  let wanted;
  try {
    if (o.all && o.changedSince) throw new Error("--all checks every project and --changed-since only those a change reaches: pass one");
    if (o.changedSince) wanted = resolveProjects(root, projects);
    else {
      const ask = projectsForAsk(root, projects, { all: o.all });
      if (ask.why && !o.json) console.error(fmt.muted(`  ${ask.why}`));
      wanted = ask.projects;
      if (!wanted.length) {
        logAsk(wanted);
        if (o.json) console.log("[]");
        else console.log(`${fmt.success("✓")} nothing to check`);
        return;
      }
    }
    if (o.changedSince) {
      const changed = [
        ...gitPaths(root, ["diff", "--name-only", o.changedSince, "--"]),
        ...gitPaths(root, ["ls-files", "--others", "--exclude-standard"]),
      ].filter(Boolean);
      wanted = projectsTouching(root, wanted, changed, (line) => { if (!o.json) console.error(fmt.muted(`  ${line}`)); });
      if (!wanted.length) {
        logAsk(wanted);
        if (o.json) console.log("[]");
        else console.log(`${fmt.success("✓")} no project's program changed since ${o.changedSince}`);
        return;
      }
    }
    logAsk(wanted);
  } catch (err) {
    console.error(`${fmt.error("✗")} ${(err as Error).message}`);
    process.exit(2);
  }
  const { CheckFailure, summarize } = await import("./checkOutcome.js");
  const { printHint } = await import("./infraExit.js");
  const results = [];
  const outcomes: import("./checkOutcome.js").ProjectOutcome[] = [];
  const phantomExamples: string[] = [];
  // This run needs all of these programs: making room for one never stops another.
  const protect = new Set(wanted.map((t) => watchDir(root, t.name)));
  for (const target of wanted) {
    const project = target.name;
    try {
      const r = await askCheck(target, root, { fresh: o.fresh, protect, note: (line) => { if (!o.json) console.error(fmt.muted(`  ${line}`)); } });
      results.push(r);
      // A watcher's first pass (whoever started it) was built from the tree as it is, so errors
      // that look phantom there are real: suggesting --fresh again would only restart it in a loop.
      const phantomCount = r.started || o.fresh || r.firstPass ? 0 : r.phantom;
      outcomes.push({ project, errors: r.errors, phantom: phantomCount, globalTsc: r.globalTsc });
      if (phantomCount) phantomExamples.push(...r.phantomExamples);
      if (!o.json) {
        if (r.diagnostics.trim()) console.log(r.diagnostics.trimEnd());
        const age = r.passAgeMs < 60_000 ? `${Math.round(r.passAgeMs / 1000)}s` : `${Math.round(r.passAgeMs / 60_000)}m`;
        const phantom = phantomCount ? `, ${phantomCount} name${phantomCount === 1 ? "s" : ""} what exists on disk` : "";
        const how = r.checker ? `bun check ${(r.runMs! / 1000).toFixed(1)}s${r.started ? "" : ", shared"}` : `pass ${age} old${r.started ? ", watcher started by this call" : ""}${phantom}`;
        console.log(`${r.errors === 0 ? fmt.success("✓") : fmt.error("✗")} ${project}: ${r.errors} error${r.errors === 1 ? "" : "s"} ${fmt.muted(`(${how})`)}`);
      }
    } catch (err) {
      const failure = err instanceof CheckFailure ? err : new CheckFailure((err as Error).message, "infra");
      outcomes.push({ project, failure });
      if (o.json) results.push({ project, error: failure.message, kind: failure.kind });
      else console.error(`${fmt.error("✗")} ${project}: ${failure.message}`);
    }
  }
  const { exit, hint } = summarize(outcomes, phantomExamples);
  if (o.json) console.log(JSON.stringify(results, null, 2));
  if (hint) printHint(hint);
  process.exit(exit);
}
