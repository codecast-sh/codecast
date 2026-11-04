"use client";
// Deploy, Redeploy and Roll back, wherever a target can be sent from: the
// Deploys page and a session's run card. A press opens the consequential review
// (deployTargetLedger: what goes out, from what, its CI, how to undo it); the
// confirm paints the requested deploy at once through the store's deployTarget.
import { useState } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { rollbackTarget, targetNow, type DeployTargetRow, type TeamDeployRow } from "../../lib/deploys/targets";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { deployTargetLedger } from "../consequential/ledgers";

export type Press = { target: DeployTargetRow; action: "deploy" | "redeploy" | "rollback"; of: TeamDeployRow | null };

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "—");

export function useDeployPress(teamId: string | null, deploys: ReadonlyArray<TeamDeployRow>) {
  const me = useInboxStore((s) => (s.currentUser as { name?: string } | null)?.name ?? "You");
  const [press, setPress] = useState<Press | null>(null);
  const confirm = (p: Press) => {
    setPress(null);
    if (!teamId) return;
    const clientKey = `dp-client-${Math.random().toString(36).slice(2, 10)}`;
    const n = targetNow(p.target, deploys);
    const sessions = p.action === "deploy" ? p.target.queue.groups.flatMap((g) => (g.session ? [{ conversation_id: g.session.conversation_id, short_id: g.session.short_id, title: g.session.title }] : [])) : [];
    void useInboxStore.getState().deployTarget(clientKey, teamId, p.target.repository, p.target.name, p.action, p.of?.short_id ?? null, {
      started_by: me,
      sha: p.action === "deploy" ? p.target.queue.head_sha : p.of?.sha ?? null,
      previous_sha: n.live?.sha ?? null,
      commits: p.action === "deploy" ? p.target.queue.commits : 0,
      sessions,
    });
  };
  const review = press ? <PressReview press={press} deploys={deploys} onClose={() => setPress(null)} onConfirm={() => confirm(press)} /> : null;
  return { open: setPress, review };
}

function PressReview({ press: p, deploys, onClose, onConfirm }: { press: Press; deploys: ReadonlyArray<TeamDeployRow>; onClose: () => void; onConfirm: () => void }) {
  const n = targetNow(p.target, deploys);
  const back = rollbackTarget(n.history, n.live);
  const sessions = p.action === "deploy" ? p.target.queue.groups.flatMap((g) => (g.session ? [g.session.title || g.session.short_id || "Untitled session"] : [])) : [];
  const unlinked = p.action === "deploy" ? p.target.queue.groups.filter((g) => !g.session).reduce((n, g) => n + g.commits.length, 0) : 0;
  const ledger = deployTargetLedger({
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
  return <SwitchReview ledger={ledger} onClose={onClose} onConfirm={onConfirm} />;
}
