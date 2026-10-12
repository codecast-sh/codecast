// `cast line dissolve <ct-N> --kind <k> [--into <ref>] -m <note>`: a line
// station found the problem needs no new fix; this closes it with the outcome
// its reason earns (learning-loop.md LL13), instead of marking every
// dissolution done whatever it argued.
//
//   judge_defect                 dropped: the judge was wrong (its defects are filed by the station)
//   known_cause --into ct-N      merged into that open problem, reports and all
//   in_flight   --into ct-N      open, waiting on the task that owns the fix; closes with it
//                                (done when the change it names has landed since)
//   already_fixed / historical   done, when the change it names is on origin/main;
//                                a change that has not landed waits on its task like in_flight
//
// The run's own repository answers whether a named commit or branch landed.
import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import { fmt } from "./colors.js";
import { apiPost, type PublishDeps } from "./castApi.js";

export type DissolveClose = { outcome: "done" | "dropped" | "merged" | "waiting"; into?: string; note: string } | { error: string };

const TASK = /\bct-\d+\b/;
const SHA = /\b[0-9a-f]{7,40}\b/;
const BRANCH = /\b(?:origin\/)?codecast\/[\w./-]+/;

/** A change a close names: a commit or a codecast branch, in its target or its words. */
export function namedChange(text: string): string | null {
  return BRANCH.exec(text)?.[0] ?? SHA.exec(text)?.[0] ?? null;
}

/**
 * The close a dissolution earns. `landed` says whether a named change is on
 * the main line (null when nothing was named or it could not be read). An
 * unknown kind (a station that reported none) closes done, as before.
 */
export function dissolveClose(kind: string, into: string, note: string, landed: boolean | null): DissolveClose {
  const k = kind.trim();
  const said = `${into} ${note}`;
  const task = TASK.exec(into)?.[0] ?? TASK.exec(note)?.[0];
  const waitOn = (why: string): DissolveClose => (task ? { outcome: "waiting", into: task, note } : { error: `${why}: name the task that owns the fix (--into ct-N), or the problem stays open` });
  if (k === "judge_defect") return { outcome: "dropped", note: `Dropped: the judge was wrong. ${note}`.trim() };
  if (k === "known_cause") return TASK.exec(into)?.[0] ? { outcome: "merged", into: TASK.exec(into)![0], note } : { error: "known_cause names the problem that holds it (--into ct-N)" };
  if (k === "in_flight" && landed !== true) return waitOn("in_flight is a fix that has not landed");
  if ((k === "already_fixed" || k === "historical") && landed === false) return waitOn(`the change it names (${namedChange(said)}) is not on origin/main`);
  return { outcome: "done", note };
}

/** Whether a commit or branch is on origin/main in `cwd`; null when it cannot be told. */
export function changeLanded(cwd: string, change: string | null): boolean | null {
  if (!change) return null;
  const git = (args: string[]) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const ref = change.startsWith("codecast/") && git(["rev-parse", "--verify", "-q", `origin/${change}`]).status === 0 ? `origin/${change}` : change;
  if (git(["rev-parse", "--verify", "-q", `${ref}^{commit}`]).status !== 0) return null;
  return git(["merge-base", "--is-ancestor", ref, "origin/main"]).status === 0;
}

export function registerLineDissolveCommand(line: Command, deps: PublishDeps): void {
  line
    .command("dissolve <task>")
    .description("Close a problem that needs no new fix, with the outcome its reason earns: dropped (judge wrong), merged (another problem holds it), waiting on the task whose fix has not landed, or done")
    .requiredOption("--kind <kind>", "The dissolution's kind: judge_defect, known_cause, in_flight, already_fixed, historical")
    .option("--into <ref>", "The problem, task, commit or branch it dissolved into")
    .option("-m, --message <text>", "The closing note a person reads on the problem", "")
    .option("--json", "Machine-readable output")
    .action(async (task: string, options: { kind: string; into?: string; message: string; json?: boolean }) => {
      const into = options.into?.trim() ?? "";
      const cwd = process.env.CODECAST_CWD || process.cwd();
      const close = dissolveClose(options.kind, into, options.message.trim(), changeLanded(cwd, namedChange(`${into} ${options.message}`)));
      if ("error" in close) {
        console.error(fmt.error(`${task}: ${close.error}`));
        process.exit(1);
      }
      const result = await apiPost(deps, "/cli/line/dissolve", { task, ...close });
      if (options.json) return console.log(JSON.stringify(result, null, 2));
      const how = result.outcome === "merged" ? `merged into ${result.into} (${result.moved} reports moved)` : result.outcome === "waiting" ? (result.status === "done" ? `done with ${result.into}` : `waiting on ${result.into}`) : result.status;
      console.log(`${task}: ${how}`);
    });
}
