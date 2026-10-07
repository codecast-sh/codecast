"use client";
// /org: the org screen (docs/architecture/org-staffing.md S41), or the health
// page under `?view=health`. The map beside a conversation is the screen
// itself under `?beside=` (S41), so there is no map-only route.
import { AuthGuard } from "../../components/AuthGuard";
import { OrgFeatureGate } from "../../components/org/OrgFeatureGate";
import { DashboardLayout } from "../../components/DashboardLayout";
import { OrgScreen } from "../../components/org/OrgPage";
import { HealthPage } from "../../components/org/HealthPage";
import { useSearchParams } from "next/navigation";

function OrgRoute() {
  const view = useSearchParams().get("view");
  return view === "health" ? <HealthPage /> : <OrgScreen />;
}

export default function OrgPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <OrgFeatureGate>
          <OrgRoute />
        </OrgFeatureGate>
      </DashboardLayout>
    </AuthGuard>
  );
}
