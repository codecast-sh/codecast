"use client";
// /org: the org screen (docs/architecture/org-staffing.md S42). The map
// beside a conversation is the screen itself under `?beside=`, so there is no
// map-only route. The org feature gates only the screen's conversation pane
// (D11, OrgFeatureGate), so a workspace without it still sees its goals,
// projects and people here. The retired health page's address lands on the
// People map with This week on (D12, healthRedirect).
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { OrgScreen } from "../../components/org/OrgPage";
import { healthRedirect } from "../../components/org/orgScreenModel";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useRouter, useSearchParams } from "next/navigation";

function OrgRoute() {
  const router = useRouter();
  const to = healthRedirect(useSearchParams().toString());
  // Through the tab's own router, so the pane's parameters move with the address.
  useWatchEffect(() => { if (to) router.replace(to); }, [to]);
  return to ? null : <OrgScreen />;
}

export default function OrgPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <OrgRoute />
      </DashboardLayout>
    </AuthGuard>
  );
}
