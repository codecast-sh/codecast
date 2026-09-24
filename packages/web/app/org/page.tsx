"use client";
// /org — the workspace's reporting structure (docs/architecture/org-roles.md).
import { AuthGuard } from "../../components/AuthGuard";
import { OrgFeatureGate } from "../../components/org/OrgFeatureGate";
import { DashboardLayout } from "../../components/DashboardLayout";
import { OrgPageInner } from "../../components/org/OrgPage";

export default function OrgPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <OrgFeatureGate>
        <OrgPageInner />
        </OrgFeatureGate>
      </DashboardLayout>
    </AuthGuard>
  );
}
