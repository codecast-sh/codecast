// A personal flow run's end records its deploy (docs/architecture/deploys.md
// DP11). A team's deploys are recorded by their paths (deploy.sh's marker, a
// ship pass, a GitHub status); a personal repository has none of those, and
// its flow's own stations are the only witness. So when a run in a `user:`
// workspace ends, where it ended says what its deploy did:
//
//  - completed at an exit labelled Live or Shipped: live when a step that ran
//    the deploy says it ran, else landed (nothing deployed); at Deployed,
//    unverified: live, noted as not seen running;
//  - ended at a station that says the deploy failed (label Deploy failed, or an
//    id like deploy_failed / deploy__failed): failed only when the step that
//    ran the deploy failed. When that step succeeded and only a station
//    watching for it failed after (deploy__wait), the deploy went out: live,
//    noted as unconfirmed;
//  - a ship step that says it "pushed <sha> to main but the deploy failed"
//    (in its output or the run's stop reason), wherever the run ended (Not
//    merged): failed, at that sha, with what failed;
//  - anywhere else (Landed: nothing documents a deploy): nothing.
//
// The deploy goes to `production` of the repository the run's session works
// in, carries the run's task, and lists the landed commit with the session that
// shipped it, so its card on the Deploys page names both. One deploy per run
// (deploys.ship_run); a run resumed after it ended updates that deploy.

import type { Doc, Id } from "../_generated/dataModel";
import { extractRepoFromRemoteUrl } from "@codecast/shared/contracts";
import { LINE_DEPLOY_GRAPH } from "@codecast/shared/contracts/lineDeploy";
import { runWorkflowOf } from "./runGraph";
import { NOTE_MAX, onDeployStatus, recordDeployMarker } from "../deploys";
import { findDeployTeam } from "../changesDeploy";
import { performRequestRepoIcon } from "../repoIcons";
import { commitBySha } from "../deployTargetsState";

type Ctx = { db: any };
type Run = Pick<Doc<"workflow_runs">, "status" | "current_node_id" | "node_statuses" | "fail_reason" | "merge">;
type Station = Run["node_statuses"][number];

const LIVE_LABELS = new Set(["Live", "Shipped"]);
const UNVERIFIED_LABEL = "Deployed, unverified";
const DEPLOY_FAILED_ID = /deploy.*fail/i;
const SHA = /^[0-9a-f]{7,40}$/;
const PUSHED_NOT_DEPLOYED = /pushed ([0-9a-f]{7,40}) to main but the deploy failed/;
export const RUN_DEPLOY_TARGET = "production";

export type RunDeployEnd = { status: "live"; note?: string } | { status: "failed"; note: string } | { skip: "landed" | "no deploy" };

function jsonOf(text: string | undefined): any {
  if (!text?.trim().startsWith("{")) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** The stations, the latest finished first. */
const latestFirst = (run: Pick<Run, "node_statuses">) => [...run.node_statuses].sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0));

/**
 * A station that ran the deploy: a ship or deploy step with output (`ship__ship`, the personal flow's `deploy`), not
 * a segment's empty parent nor a station that waits or watches for what it did.
 */
const ranDeploy = (n: Station) => /(^|__)(ship|deploy)$/.test(n.node_id) && !!n.result_preview?.trim();

/** What the step that ran the deploy said: failed (with its words), ran, or nothing ran. */
function deployStep(run: Run): { failed: string } | { ran: string | null } | null {
  for (const n of latestFirst(run)) {
    if (!ranDeploy(n)) continue;
    const j = jsonOf(n.result_preview);
    const note = typeof j?.note === "string" && j.note.trim() ? j.note.trim() : null;
    if (j?.outcome === "failed") return { failed: note ?? "Deploy failed" };
    if (n.status === "failed") return { failed: note ?? n.result_preview!.trim() };
    if (n.status === "completed") return { ran: note };
  }
  return null;
}

/** Why the run stopped: the latest failed station's output before its end, else its stop reason. */
function stopReason(run: Run): string | null {
  const failed = latestFirst(run).find((n) => n.node_id !== run.current_node_id && n.status === "failed" && n.result_preview?.trim() && !jsonOf(n.result_preview));
  return failed?.result_preview!.trim() ?? (run.fail_reason?.replace(/^Stopped:\s*/, "").trim() || null);
}

/** A ship step that pushed to main and then failed to deploy: the sha it pushed and what failed before it said so. */
function pushedNotDeployed(run: Run): { sha: string; note: string } | null {
  const texts = [...latestFirst(run).filter((n) => /(^|__)ship/.test(n.node_id)).map((n) => n.result_preview ?? ""), run.fail_reason ?? ""];
  for (const text of texts) {
    const m = text.match(PUSHED_NOT_DEPLOYED);
    if (!m) continue;
    const before = text.slice(0, m.index).replace(/^Stopped:\s*/, "").replace(/^The change was not shipped\.\s*/, "").trim();
    return { sha: m[1], note: before || m[0] };
  }
  return null;
}

/** What a run's end says its deploy did, given the label of the station it ended at. Only for an ended run. */
export function runDeployEnd(run: Run, label: string | null): RunDeployEnd {
  // A Live or Shipped end means the ship step succeeded; it deployed only when a step that ran the deploy says so (a
  // change already on main, or one no deploy ships, landed and went nowhere).
  if (run.status === "completed" && label && LIVE_LABELS.has(label)) {
    const step = deployStep(run);
    return step && "ran" in step ? { status: "live" } : { skip: "landed" };
  }
  const pushed = pushedNotDeployed(run);
  if (pushed) return { status: "failed", note: pushed.note };
  if (label === "Deploy failed" || DEPLOY_FAILED_ID.test(run.current_node_id ?? "")) {
    const step = deployStep(run);
    if (step && "failed" in step) return { status: "failed", note: step.failed };
    if (step) return { status: "live", note: `Deployed; codecast couldn't confirm it went live: ${stopReason(run) ?? "its watch failed"}` };
    return { status: "failed", note: stopReason(run) ?? "Deploy failed" };
  }
  if (run.status !== "completed") return { skip: "no deploy" };
  if (label === UNVERIFIED_LABEL) {
    const step = deployStep(run);
    const said = step && "ran" in step ? step.ran : null;
    return { status: "live", note: `Deployed, not seen running${said ? `: ${said}` : ""}` };
  }
  return { skip: label === "Landed" ? "landed" : "no deploy" };
}

/**
 * The commit that went out: the run's merge, else the sha a deploy or landing station reported as JSON, else one a
 * station's output names ("<sha> is on main", "pushed <sha> to main but the deploy failed", or a line a ship step
 * starts with the sha it shipped).
 */
export function runDeploySha(run: Run): string | null {
  if (run.merge?.sha) return run.merge.sha.toLowerCase();
  const stations = latestFirst(run);
  for (const n of stations) {
    if (!/deploy|land/i.test(n.node_id)) continue;
    const sha = jsonOf(n.result_preview)?.sha;
    if (typeof sha === "string" && SHA.test(sha.toLowerCase())) return sha.toLowerCase();
  }
  for (const n of stations) {
    const onMain = n.result_preview?.match(/\b([0-9a-f]{7,40}) is on main\b/);
    if (onMain) return onMain[1];
  }
  const pushed = pushedNotDeployed(run);
  if (pushed) return pushed.sha;
  for (const n of stations) {
    if (!/(^|__)ship/.test(n.node_id)) continue;
    const leading = n.result_preview?.match(/^([0-9a-f]{7,40})\s/m);
    if (leading) return leading[1];
  }
  return null;
}

/** The session that shipped a run's change: the one that pressed Ship, else the one its task came from, else the run's own. */
export async function runShipperConversation(ctx: Ctx, run: Doc<"workflow_runs"> | null): Promise<Id<"conversations"> | null> {
  if (!run) return null;
  if (run.spawner_conversation_id && !run.spawner_stand_in) return run.spawner_conversation_id;
  const task: Doc<"tasks"> | null = run.task_id ? await ctx.db.get(run.task_id) : null;
  return task?.created_from_conversation ?? run.primary_conversation_id ?? run.spawner_conversation_id ?? null;
}

/** The GitHub repository (`owner/name`) the run's sessions work in. */
async function runRepository(ctx: Ctx, run: Doc<"workflow_runs">, task: Doc<"tasks"> | null): Promise<string | null> {
  for (const id of [task?.created_from_conversation, run.primary_conversation_id, run.spawner_conversation_id]) {
    if (!id) continue;
    const c: Doc<"conversations"> | null = await ctx.db.get(id);
    const repository = extractRepoFromRemoteUrl(c?.git_remote_url);
    if (repository) return repository;
  }
  return null;
}

export type RunDeployResult =
  | { recorded: "live" | "failed"; deploy: string | null }
  | { updated: "live" | "failed"; deploy: string }
  | { already: string }
  | { skipped: "not personal" | "not ended" | "line deploy" | "landed" | "no deploy" | "no repository" | "team repository" };

/**
 * Record the deploy a personal run's end says it made, once per run: a run resumed after it ended (Deploy failed, then
 * Live) updates its deploy to what the new end says. `dry` decides without writing; `quiet` (a backfill) fires no
 * deploy trigger.
 */
export async function recordRunDeploy(ctx: Ctx, run: Doc<"workflow_runs">, opts: { dry?: boolean; quiet?: true } = {}): Promise<RunDeployResult> {
  if (!run.workspace?.startsWith("user:")) return { skipped: "not personal" };
  if (run.status !== "completed" && run.status !== "failed") return { skipped: "not ended" };
  const had: Doc<"deploys"> | null = await ctx.db.query("deploys").withIndex("by_ship_run", (q: any) => q.eq("ship_run", run._id)).first();
  const wf = await runWorkflowOf(ctx, run);
  // A line deploy's run is the deploy's own steps (DP8): its deploy is already a row.
  if (wf?.slug === LINE_DEPLOY_GRAPH) return { skipped: "line deploy" };
  const label = (wf?.nodes as Array<{ id: string; label?: string }> | undefined)?.find((n) => n.id === run.current_node_id)?.label
    ?? run.node_statuses.find((n) => n.node_id === run.current_node_id)?.label
    ?? null;
  const end = runDeployEnd(run, label);
  // A resumed run that ended without a deploy this time leaves the one it recorded.
  if ("skip" in end) return had ? { already: had.short_id } : { skipped: end.skip };
  const task: Doc<"tasks"> | null = run.task_id ? await ctx.db.get(run.task_id) : null;
  const sha = runDeploySha(run);
  const shipper = await runShipperConversation(ctx, run);
  // Cut as recordDeployMarker stores it, so a second look compares like with like.
  const note = end.note?.slice(-NOTE_MAX);
  const runCarry = run.task_id && end.status === "live"
    ? { task_id: run.task_id, run_id: run._id, ...(run.merge ? { merge_sha: run.merge.sha, merged_at: run.merge.at, ...(run.merge.pr_url ? { pr_url: run.merge.pr_url } : {}) } : {}), how: "sent" as const }
    : null;

  if (had) {
    // A deploy that went live stays live: a resumed run's failed redeploy is noted on it, never turns it failed.
    const keepLive = had.status === "live" && end.status === "failed";
    const want = keepLive
      ? { status: "live" as const, sha: had.sha ?? null, note: withLine(had.note, `A later redeploy failed: ${note ?? "Deploy failed"}`) }
      : { status: end.status, sha: sha ?? had.sha ?? null, note };
    if (had.status === want.status && (had.sha ?? null) === want.sha && (had.note ?? undefined) === want.note) return { already: had.short_id };
    if (opts.dry) return { updated: want.status, deploy: had.short_id };
    const at = run.updated_at ?? Date.now();
    const moved = had.status !== want.status || (had.sha ?? null) !== want.sha;
    const subject = moved && had.repository && want.sha ? await subjectOf(ctx, had.repository, want.sha, task, wf) : null;
    // The run's task joins what the deploy already carries; nothing it carried is dropped.
    const carries = runCarry && !had.carries.some((c) => String(c.task_id) === String(runCarry.task_id)) ? [...had.carries, runCarry] : had.carries;
    await ctx.db.patch(had._id, {
      status: want.status,
      sha: want.sha ?? undefined,
      note: want.note,
      carries,
      ...(subject && want.sha ? { commits: [commitRow(want.sha, subject, shipper, run.task_id)] } : {}),
      ...(moved ? { live_at: want.status === "live" ? at : undefined, finished_at: at } : {}),
      updated_at: Date.now(),
    });
    if (had.status !== want.status) await onDeployStatus(ctx, had._id, opts.quiet);
    return { updated: want.status, deploy: had.short_id };
  }

  const repository = await runRepository(ctx, run, task);
  if (!repository) return { skipped: "no repository" };
  // A repository one of the person's teams works on records its deploys in that team, by its own deploy path.
  let team: unknown;
  try { team = await findDeployTeam(ctx, run.user_id, repository); } catch { team = "more than one"; }
  if (team) return { skipped: "team repository" };
  if (opts.dry) return { recorded: end.status, deploy: null };

  const user: Doc<"users"> | null = await ctx.db.get(run.user_id);
  const subject = sha ? await subjectOf(ctx, repository, sha, task, wf) : null;
  const deploy = await recordDeployMarker(ctx, {
    workspace: run.workspace,
    target: RUN_DEPLOY_TARGET,
    ...(sha ? { sha } : {}),
    repository,
    source: `${wf?.slug ?? run.workflow_name ?? "personal"} flow`,
    started_by: { kind: "person", name: user?.name ?? user?.github_username ?? "someone", user_id: run.user_id },
    status: end.status,
    ...(note ? { note } : {}),
    ...(sha && subject ? { commits: [commitRow(sha, subject, shipper, run.task_id)] } : {}),
    ...(runCarry ? { carries: [runCarry] } : {}),
    ship_run: run._id,
    ...(opts.quiet ? { quiet: true as const } : {}),
    at: run.updated_at ?? Date.now(),
  });
  // The project's face is asked for here, once it has a deploy, so the Deploys page never asks itself (repoIcons.ts).
  await performRequestRepoIcon(ctx as any, run.user_id, run.workspace, repository);
  return { recorded: end.status, deploy };
}

/** A note with one more line, once: the line already there leaves it as it was. */
function withLine(note: string | undefined, whole: string): string {
  const line = whole.slice(-NOTE_MAX);
  if (note?.includes(line)) return note;
  return (note ? `${note}\n${line}` : line).slice(-NOTE_MAX);
}

/** The commit's own subject when main's commits know it, else the task's title, else the flow's. */
async function subjectOf(ctx: Ctx, repository: string, sha: string, task: Doc<"tasks"> | null, wf: Doc<"workflows"> | null): Promise<string> {
  const commit = await commitBySha(ctx, repository, sha);
  return commit?.message.split("\n")[0]?.trim() || task?.title || `${wf?.label ?? wf?.name ?? "flow"} run`;
}

const commitRow = (sha: string, subject: string, shipper: Id<"conversations"> | null, taskId: Id<"tasks"> | undefined) =>
  ({ sha, subject, ...(shipper ? { conversation_id: shipper } : {}), ...(taskId ? { task_ids: [taskId] } : {}) });
