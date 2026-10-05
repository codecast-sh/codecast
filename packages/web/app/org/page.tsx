"use client";
// /org — the workspace's reporting structure (docs/architecture/org-roles.md).
import { AuthGuard } from "../../components/AuthGuard";
import { OrgFeatureGate } from "../../components/org/OrgFeatureGate";
import { DashboardLayout } from "../../components/DashboardLayout";
import { OrgPageInner } from "../../components/org/OrgPage";
import { OrgChartPane } from "../../components/org/OrgChartPane";
import { useSearchParams } from "next/navigation";

/** `?view=chart` is the chart alone, the form the stage hosts beside a
 *  conversation (org-staffing.md S36); anything else is the page. */
function OrgRoute() {
  return useSearchParams().get("view") === "chart" ? <OrgChartPane /> : <OrgPageInner />;
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
