"use client";
// /org: the company as one chart (components/org/OrgChart.tsx), or, while the
// workspace has Org off, the feature's landing.
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { OrgChart } from "../../components/org/OrgChart";
import { OrgFeatureGate } from "../../components/org/OrgFeatureGate";

export default function OrgPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <OrgFeatureGate><OrgChart /></OrgFeatureGate>
      </DashboardLayout>
    </AuthGuard>
  );
}
