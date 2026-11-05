"use client";
// Deploy, Redeploy and Roll back from wherever a target can be sent (the Deploys
// page, a session's run card): a press opens PressReview, and the confirm paints
// the requested deploy at once through the store's deployTarget.
import { useState } from "react";
import { useInboxStore } from "../store/inboxStore";
import { targetNow, type TeamDeployRow } from "../lib/deploys/targets";
import { PressReview, type Press } from "../components/deploys/DeployPress";

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
