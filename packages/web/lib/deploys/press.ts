// A Deploy, Redeploy or Roll back press, apart from how it is drawn: the
// ledger its review shows and the store write its confirm makes. The web's
// review (components/deploys/DeployPress) and the phone's deploy screen both
// read these, so the two ask with the same facts and send the same request.
// Pure of DOM: the phone imports it.
import { useInboxStore } from "../../store/inboxStore";
import { deployTargetLedger } from "../../components/consequential/ledgers";
import type { SwitchLedger } from "../../components/consequential/ConsequentialSwitch";
import { rollbackTarget, targetNow, type DeployTargetRow, type TeamDeployRow } from "./targets";

export type Press = { target: DeployTargetRow; action: "deploy" | "redeploy" | "rollback"; of: TeamDeployRow | null };

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "—");

/** What a press sends, from what, its CI and how to undo it, as the confirm shows it. */
export function pressLedger(p: Press, deploys: ReadonlyArray<TeamDeployRow>): SwitchLedger {
  const n = targetNow(p.target, deploys);
  const back = rollbackTarget(n.history, n.live);
  const sessions = p.action === "deploy" ? p.target.queue.groups.flatMap((g) => (g.session ? [g.session.title || g.session.short_id || "Untitled session"] : [])) : [];
  const unlinked = p.action === "deploy" ? p.target.queue.groups.filter((g) => !g.session).reduce((n, g) => n + g.commits.length, 0) : 0;
  return deployTargetLedger({
    target: p.target.name,
    repository: p.target.repository,
    action: p.action,
    fromSha: n.live?.sha ?? null,
    toSha: p.action === "deploy" ? p.target.queue.head_sha : p.of?.sha ?? null,
    commits: p.action === "deploy" ? p.target.queue.commits : 0,
    sessions,
    unlinked,
    ci: p.action === "deploy" ? p.target.queue.head_ci : "passed",
    runsOn: p.target.runs === "here" ? "The machine that publishes it" : null,
    undo: p.action === "deploy" ? (n.live ? `Roll back to ${short(n.live.sha)}` : null) : back || n.live ? `Deploy ${short(n.live?.sha)} again` : null,
  });
}

/** The confirm: the requested deploy paints at once through the store's deployTarget. */
export function sendPress(p: Press, teamId: string, deploys: ReadonlyArray<TeamDeployRow>, startedBy: string): void {
  const clientKey = `dp-client-${Math.random().toString(36).slice(2, 10)}`;
  const n = targetNow(p.target, deploys);
  const sessions = p.action === "deploy" ? p.target.queue.groups.flatMap((g) => (g.session ? [{ conversation_id: g.session.conversation_id, short_id: g.session.short_id, title: g.session.title }] : [])) : [];
  void useInboxStore.getState().deployTarget(clientKey, teamId, p.target.repository, p.target.name, p.action, p.of?.short_id ?? null, {
    started_by: startedBy,
    sha: p.action === "deploy" ? p.target.queue.head_sha : p.of?.sha ?? null,
    previous_sha: n.live?.sha ?? null,
    commits: p.action === "deploy" ? p.target.queue.commits : 0,
    sessions,
  });
}

/** The way back a superseded deploy offers ("Roll back here"): only for one that went live on another sha, on a
 *  target that can go back, while nothing else is going out there. */
export function rollBackHere(d: TeamDeployRow, target: DeployTargetRow | undefined, deploys: ReadonlyArray<TeamDeployRow>): Press | null {
  if (!target || d.status !== "live" || !d.sha) return null;
  const n = targetNow(target, deploys);
  if (n.open || d._id === n.live?._id || d.sha === n.live?.sha) return null;
  if (!target.can_redeploy_sha && !target.can_rollback) return null;
  return { target, action: target.can_redeploy_sha ? "redeploy" : "rollback", of: d };
}
