"use client";
// /initiatives — the goals the company is trying to reach
// (docs/architecture/initiatives-projects-role-page.md I1).
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { InitiativesList } from "../../components/initiatives/InitiativesList";

export default function InitiativesPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <InitiativesList />
      </DashboardLayout>
    </AuthGuard>
  );
}
