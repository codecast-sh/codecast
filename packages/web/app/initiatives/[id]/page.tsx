"use client";
// /initiatives/<in-N> — one initiative, opened the way a scope opens: its
// owner's conversation beside it
// (docs/architecture/initiatives-projects-role-page.md I1).
import { useParams } from "next/navigation";
import { AuthGuard } from "../../../components/AuthGuard";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { InitiativePageInner } from "../../../components/initiatives/InitiativePage";

export default function InitiativePage() {
  const params = useParams();
  const id = (params?.id as string | undefined) ?? "";
  return (
    <AuthGuard>
      <DashboardLayout>
        <InitiativePageInner id={decodeURIComponent(id)} />
      </DashboardLayout>
    </AuthGuard>
  );
}
