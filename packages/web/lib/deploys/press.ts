// A Deploy, Redeploy or Roll back press, apart from how it is drawn: the
// ledger its review shows and the store write its confirm makes. The web's
// review (components/deploys/DeployPress) and the phone's deploy screen both
// read these, so the two ask with the same facts and send the same request.
// Pause, Lift and the paused Roll back (deploys.md DP17, DP19) are presses too:
// a target whose deploys run as a workflow goes back only through codecast's
// rollback, which pauses production first and says why.
// Pure of DOM: the phone imports it.
import { useInboxStore } from "../../store/inboxStore";
import { isRefusedDispatchError } from "../../store/mutativeMiddleware";
import type { ProductionPaint } from "../../store/lineSlice";
import { deployTargetLedger } from "../../components/consequential/ledgers";
import type { SwitchLedger, SwitchRow } from "../../components/consequential/ConsequentialSwitch";
import { rollbackTarget, targetNow, type DeployProductionRow, type DeployTargetRow, type TeamDeployRow } from "./targets";

export type Press = { target: DeployTargetRow; action: "deploy" | "redeploy" | "rollback"; of: TeamDeployRow | null };

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "—");

/** The confirm's word while no reason is written: a pause and a rollback both say why. */
export const SAY_WHY = "Say why first";

/** What a press sends, from what, its CI and how to undo it, as the confirm shows it. `production` is the target's
 *  repository's (productionOf): its pause blocks the press. */
export function pressLedger(p: Press, deploys: ReadonlyArray<TeamDeployRow>, production: DeployProductionRow | undefined): SwitchLedger {
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
    // A pause lets only a rollback through.
    ...(production?.pause && p.action !== "rollback" ? { blocked: "Production is paused" } : {}),
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
 *  target that can go back, while nothing else is going out there. A target whose deploys run as a workflow goes back
 *  only through codecast's rollback (rollbackOffer). */
export function rollBackHere(d: TeamDeployRow, target: DeployTargetRow | undefined, deploys: ReadonlyArray<TeamDeployRow>): Press | null {
  if (!target || target.workflow || d.status !== "live" || !d.sha) return null;
  const n = targetNow(target, deploys);
  if (n.open || d._id === n.live?._id || d.sha === n.live?.sha) return null;
  if (!target.can_redeploy_sha && !target.can_rollback) return null;
  return { target, action: target.can_redeploy_sha ? "redeploy" : "rollback", of: d };
}

// ── Pause, Lift and the paused Roll back (DP17, DP19) ──────────────────────

/** Roll back a workflow target to an earlier live deploy: it pauses production, and its task says what ends the pause. */
export type RollbackPress = { target: DeployTargetRow; of: TeamDeployRow };

/** Codecast's Roll back to `d` (the header's, with the deploy before the live one, or a row's "Roll back here"): only
 *  on a target whose deploys run as a workflow, for a viewer who holds the pause (the target's production says), to a
 *  deploy that went live on another sha. It queues behind whatever is going out, so a deploy going out does not stop it. */
export function rollbackOffer(d: TeamDeployRow | null, target: DeployTargetRow | undefined, production: DeployProductionRow | undefined, deploys: ReadonlyArray<TeamDeployRow>): RollbackPress | null {
  if (!d || !target?.workflow || !production?.can_pause || d.status !== "live" || !d.sha) return null;
  const n = targetNow(target, deploys);
  if (d._id === n.live?._id || d.sha === n.live?.sha) return null;
  return { target, of: d };
}

/** A repository's targets of one team: a pause stands on the repository, so it stops every one of them. */
const sameRepo = (targets: ReadonlyArray<DeployTargetRow>, t: DeployTargetRow) => targets.filter((x) => x.workspace === t.workspace && x.repository === t.repository && !x.record_only);
/** What a pause catches going out on the repository: a queued deploy, or a run (cancelled before its rollout). */
const goingOut = (deploys: ReadonlyArray<TeamDeployRow>, t: DeployTargetRow) => deploys.filter((d) => d.workspace === t.workspace && d.repository === t.repository && (d.status === "requested" || d.status === "running") && !!d.short_id);

/** Pausing a repository's production, as its confirm shows it: what stops, what it cancels, and how it ends. */
export function pauseLedger(t: DeployTargetRow, targets: ReadonlyArray<DeployTargetRow>, deploys: ReadonlyArray<TeamDeployRow>, reason: string): SwitchLedger {
  const stops = sameRepo(targets, t);
  const going = goingOut(deploys, t);
  return {
    name: "Pause production",
    subject: t.repository,
    shift: ["Deploying", "Paused"],
    figures: [
      { value: String(stops.length), label: stops.length === 1 ? "target stops" : "targets stop" },
      { value: String(going.length), label: going.length === 1 ? "deploy cancelled" : "deploys cancelled", ...(going.length ? { tone: "warn" as const } : {}) },
    ],
    rows: [
      { k: "Stops", v: stops.length === 1 ? stops[0].name : `${stops.length} targets`, ...(stops.length > 1 ? { list: stops.map((x) => x.name) } : {}) },
      ...(going.length ? [{ k: "Cancels", v: "Queued, or before rollout", tone: "warn" as const, list: going.map((d) => `${d.short_id} to ${d.target}`) }] : []),
      { k: "Lets through", v: "A rollback" },
    ],
    stop: "Lift: you or the Release Captain",
    confirm: "Pause production",
    keep: "Not now",
    ...(reason.trim() ? {} : { blocked: SAY_WHY }),
  };
}

/** Codecast's rollback, as its confirm shows it: what goes back live, the pause it leaves, and what ends that. */
export function rollbackLedger(p: RollbackPress, deploys: ReadonlyArray<TeamDeployRow>, reason: string): SwitchLedger {
  const t = p.target;
  const n = targetNow(t, deploys);
  const rows: SwitchRow[] = [
    { k: "Pauses", v: `Every deploy of ${t.repository}`, tone: "warn" },
    ...(n.open ? [{ k: "Going out", v: `${n.open.short_id || "A deploy"}: cancelled before rollout, else waited for`, tone: "warn" as const }] : []),
    { k: "Files", v: "A task for the Release Captain: revert, or fix forward past a migration" },
    { k: "Lifts", v: "Once that commit is green on main" },
    { k: "Goes live", v: "For everyone on it", tone: "warn" },
  ];
  return {
    name: `Roll back ${t.name}`,
    subject: t.repository,
    shift: [short(n.live?.sha), short(p.of.sha)],
    figures: [{ value: short(p.of.sha), label: `goes back live${p.of.short_id ? ` (${p.of.short_id})` : ""}` }],
    rows,
    confirm: "Roll back",
    keep: "Not now",
    ...(!t.rollback_inputs ? { blocked: `${t.workflow} names no rollback_inputs` } : !reason.trim() ? { blocked: SAY_WHY } : {}),
  };
}

// Each paints the repository's one production row (store deployProductions); its echo replaces the paint, and a
// refused write puts back the row as the press found it (lineSlice restoreProduction).

/** The repository's production row as a press found it and as it painted it. */
function paintOf(teamId: string, repository: string): ProductionPaint {
  const row = (useInboxStore.getState() as any).deployProductions?.[repository];
  return structuredClone({ pause: row?.workspace === `team:${teamId}` ? row.pause ?? null : null, can_lift: !!row?.can_lift });
}

/** Run a press that paints the repository's production row; a refusal puts back what was there before it. */
function pressProduction(teamId: string, repository: string, press: () => Promise<unknown>, refused?: () => void): void {
  const before = paintOf(teamId, repository);
  const call = press();
  const painted = paintOf(teamId, repository);
  void call.catch((e) => {
    if (!isRefusedDispatchError(e)) return;
    useInboxStore.getState().restoreProduction(teamId, repository, before, painted);
    refused?.();
  });
}

/** Pause's confirm: the repository, and so every target of it, reads paused at once. */
export function sendPause(t: DeployTargetRow, reason: string, by: string): void {
  pressProduction(t.team_id, t.repository, () => useInboxStore.getState().pauseProduction(t.team_id, t.repository, reason.trim(), by));
}

/** Lift: one press, the repository reads unpaused at once. */
export function sendLift(t: Pick<DeployTargetRow, "team_id" | "repository">): void {
  pressProduction(t.team_id, t.repository, () => useInboxStore.getState().liftProductionPause(t.team_id, t.repository));
}

/** Roll back's confirm: the rollback reads requested and production paused at once; the echo names what ends the
 *  pause (its task, a revert or a fix forward past migrations). A refused rollback takes its requested deploy back,
 *  as a refused create takes back its stub. */
export function sendRollback(p: RollbackPress, reason: string, deploys: ReadonlyArray<TeamDeployRow>, startedBy: string): void {
  const t = p.target;
  const clientKey = `dp-client-${Math.random().toString(36).slice(2, 10)}`;
  const n = targetNow(t, deploys);
  pressProduction(
    t.team_id,
    t.repository,
    () => useInboxStore.getState().rollbackProduction(clientKey, t.team_id, t.repository, t.name, p.of.short_id || null, reason.trim(), { started_by: startedBy, sha: p.of.sha, previous_sha: n.live?.sha ?? null, commits: 0, sessions: [] }),
    () => useInboxStore.getState().removeDeployStub(clientKey),
  );
}
