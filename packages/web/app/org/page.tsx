"use client";
// /org — the workspace's reporting structure (docs/architecture/org-roles.md).
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { OrgPageInner } from "../../components/org/OrgPage";

export default function OrgPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <OrgPageInner />
      </DashboardLayout>
    </AuthGuard>
  );
}
