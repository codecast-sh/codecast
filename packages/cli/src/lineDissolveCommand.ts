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
//                                a change that has not landed waits on its task like in_flight.
//                                The close records when the fix landed (the newest commit it
//                                names on origin/main, or --fixed-at): a finding from after
//                                that reopens the problem instead of sitting in it closed.
//   draw                         dropped: a judge-route problem whose ruled findings the published
//                                judge does not file again (at most 1 in 5 runs): no fix to make
//   coaching    --into or-N      done: no code or prompt to change; a person on Union's side
//                                had what they needed and did not act on it, so the role
//                                that coaches them owns it
//
// The run's own repository answers whether a named commit or branch landed.
import { spawnSync } from "./proc.js";
import type { Command } from "commander";
import { fmt } from "./colors.js";
import { apiPost, type PublishDeps } from "./castApi.js";

export type DissolveClose = { outcome: "done" | "dropped" | "merged" | "waiting" | "coaching"; into?: string; note: string } | { error: string };

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
  if (k === "draw") return { outcome: "dropped", note: `Dropped: the judge does not repeat these findings. ${note}`.trim() };
  if (k === "coaching") return /^or-\d+$/i.test(into.trim()) ? { outcome: "coaching", into: into.trim(), note } : { error: "coaching names the role that coaches the people involved (--into or-N)" };
  if (k === "known_cause") return TASK.exec(into)?.[0] ? { outcome: "merged", into: TASK.exec(into)![0], note } : { error: "known_cause names the problem that holds it (--into ct-N)" };
  if (k === "in_flight" && landed !== true) return waitOn("in_flight is a fix that has not landed");
  if ((k === "already_fixed" || k === "historical") && landed === false) return waitOn(`the change it names (${namedChange(said)}) is not on origin/main`);
  return { outcome: "done", note };
}

/**
 * When the fix a dissolution names landed: the newest committer time among
 * the commits its words name that are on origin/main. Evidence from after it
 * shows the fix did not hold. Null when no named commit has landed.
 */
export function fixLandedAt(cwd: string, text: string): number | null {
  const shas = [...new Set(text.match(new RegExp(SHA.source, "g")) ?? [])];
  let newest: number | null = null;
  for (const sha of shas) {
    if (changeLanded(cwd, sha) !== true) continue;
    const r = spawnSync("git", ["-C", cwd, "show", "-s", "--format=%ct", `${sha}^{commit}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const at = Number(r.stdout.trim()) * 1000;
    if (r.status === 0 && at > 0) newest = Math.max(newest ?? 0, at);
  }
  return newest;
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
    .requiredOption("--kind <kind>", "The dissolution's kind: judge_defect, known_cause, in_flight, already_fixed, historical, coaching, draw")
    .option("--into <ref>", "The problem, task, commit or branch it dissolved into")
    .option("-m, --message <text>", "The closing note a person reads on the problem", "")
    .option("--fixed-at <date>", "When the fix went live (ISO date or time); defaults to the newest named commit on origin/main for already_fixed and historical")
    .option("--json", "Machine-readable output")
    .action(async (task: string, options: { kind: string; into?: string; message: string; fixedAt?: string; json?: boolean }) => {
      const into = options.into?.trim() ?? "";
      const cwd = process.env.CODECAST_CWD || process.cwd();
      const close = dissolveClose(options.kind, into, options.message.trim(), changeLanded(cwd, namedChange(`${into} ${options.message}`)));
      if ("error" in close) {
        console.error(fmt.error(`${task}: ${close.error}`));
        process.exit(1);
      }
      const given = options.fixedAt ? Date.parse(options.fixedAt) : NaN;
      if (options.fixedAt && Number.isNaN(given)) {
        console.error(fmt.error(`${task}: --fixed-at ${options.fixedAt} is not a date`));
        process.exit(1);
      }
      const fixed = options.fixedAt ? given : ["already_fixed", "historical"].includes(options.kind.trim()) ? fixLandedAt(cwd, `${into} ${options.message}`) : null;
      const result = await apiPost(deps, "/cli/line/dissolve", { task, kind: options.kind.trim(), ...close, ...(fixed ? { fixed_at: fixed } : {}) });
      if (options.json) return console.log(JSON.stringify(result, null, 2));
      const how = result.outcome === "merged" ? `merged into ${result.into} (${result.moved} reports moved)` : result.outcome === "coaching" ? `done, for coaching by ${result.owner}` : result.outcome === "waiting" ? (result.status === "done" ? `done with ${result.into}` : `waiting on ${result.into}`) : result.status;
      console.log(`${task}: ${how}`);
    });
}
