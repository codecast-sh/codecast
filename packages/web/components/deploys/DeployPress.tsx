"use client";
// The review a Deploy, Redeploy or Roll back press opens (hooks/useDeployPress):
// the consequential ledger of what goes out, from what, its CI and how to undo it.
import { rollbackTarget, targetNow, type DeployTargetRow, type TeamDeployRow } from "../../lib/deploys/targets";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { deployTargetLedger } from "../consequential/ledgers";

export type Press = { target: DeployTargetRow; action: "deploy" | "redeploy" | "rollback"; of: TeamDeployRow | null };

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "—");

export function PressReview({ press: p, deploys, onClose, onConfirm }: { press: Press; deploys: ReadonlyArray<TeamDeployRow>; onClose: () => void; onConfirm: () => void }) {
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
