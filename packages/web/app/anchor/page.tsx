"use client";

// The workspace's agent (docs/architecture/org-staffing.md S22): the root
// role's page, which is the role page as the session page (I3): its
// conversation on the left, its scope on the right. The sidebar's entry, the
// shell's chip and the slide-over all open here. A workspace with no root
// role yet gets the onboarding, which hires one. The quick way to talk to it
// from anywhere is the slide-over; this page is where you shape it.

import { useState } from "react";
import { useSyncOrgTree } from "../../hooks/useSyncOrgTree";
import { AuthGuard } from "../../components/AuthGuard";
import { OrgFeatureGate } from "../../components/org/OrgFeatureGate";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ScopePageInner } from "../../components/org/scope/ScopePage";
import { AnchorOnboarding, CenteredNote } from "../../components/anchor/AnchorConversation";
import { CHIEF_OF_STAFF_HANDLE } from "../../components/org/orgStaffingTypes";
import { useMountEffect } from "../../hooks/useMountEffect";

export default function AnchorPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <OrgFeatureGate>
        <RootRolePage />
        </OrgFeatureGate>
      </DashboardLayout>
    </AuthGuard>
  );
}

function RootRolePage() {
  const { tree, ready } = useSyncOrgTree();
  const root = tree?.roles.find((r) => r.handle === CHIEF_OF_STAFF_HANDLE && r.status !== "retired") ?? null;

  // The Slack install completes on /slack/connect and comes back here with
  // ?slack=connected|error.
  const [slackFlash, setSlackFlash] = useState<null | "connected" | "error">(null);
  useMountEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const s = p.get("slack");
    if (s !== "connected" && s !== "error") return;
    setSlackFlash(s);
    const u = new URL(window.location.href);
    ["code", "state", "scope", "team", "slack", "reason", "error"].forEach((k) => u.searchParams.delete(k));
    window.history.replaceState({}, "", u.pathname + u.search);
    const t = setTimeout(() => setSlackFlash(null), 6000);
    return () => clearTimeout(t);
  });

  return (
    <div className="h-full flex flex-col bg-sol-bg text-sol-text">
      {slackFlash && (
        <div className={`px-6 py-2 text-sm shrink-0 ${slackFlash === "connected" ? "bg-sol-green/15 text-sol-green" : "bg-sol-red/15 text-sol-red"}`}>
          {slackFlash === "connected"
            ? "Slack connected. Invite the bot to a channel, then link it under Settings."
            : "Slack connection failed. Please try again."}
        </div>
      )}
      <div className="flex-1 min-h-0">
        {root ? (
          <ScopePageInner id={root.short_id} href="/anchor" />
        ) : !ready && !tree ? (
          <CenteredNote>Loading…</CenteredNote>
        ) : (
          <AnchorOnboarding />
        )}
      </div>
    </div>
  );
}
