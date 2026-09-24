"use client";
// /org/<or-N> — a role's scope page, also its role page (docs/architecture/
// scopes-and-feed.md F3, org-roles-standing.md T6). /org/workspace is the root.
import { useParams } from "next/navigation";
import { AuthGuard } from "../../../components/AuthGuard";
import { OrgFeatureGate } from "../../../components/org/OrgFeatureGate";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { ScopePageInner } from "../../../components/org/scope/ScopePage";

export default function OrgScopePage() {
  const params = useParams();
  const id = (params?.id as string | undefined) ?? "workspace";
  return (
    <AuthGuard>
      <DashboardLayout>
        <OrgFeatureGate>
        <ScopePageInner id={decodeURIComponent(id)} />
        </OrgFeatureGate>
      </DashboardLayout>
    </AuthGuard>
  );
}
