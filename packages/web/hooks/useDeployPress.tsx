"use client";
// Deploy, Redeploy and Roll back from wherever a target can be sent (the Deploys
// page, a session's run card): a press opens PressReview, and the confirm paints
// the requested deploy at once through the store's deployTarget.
import { useState } from "react";
import { useInboxStore } from "../store/inboxStore";
import type { TeamDeployRow } from "../lib/deploys/targets";
import { sendPress } from "../lib/deploys/press";
import { PressReview, type Press } from "../components/deploys/DeployPress";

export function useDeployPress(teamId: string | null, deploys: ReadonlyArray<TeamDeployRow>) {
  const me = useInboxStore((s) => (s.currentUser as { name?: string } | null)?.name ?? "You");
  const [press, setPress] = useState<Press | null>(null);
  const confirm = (p: Press) => {
    setPress(null);
    if (teamId) sendPress(p, teamId, deploys, me);
  };
  const review = press ? <PressReview press={press} deploys={deploys} onClose={() => setPress(null)} onConfirm={() => confirm(press)} /> : null;
  return { open: setPress, review };
}
