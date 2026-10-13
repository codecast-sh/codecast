"use client";
// /goals: every goal the workspace keeps, read top to bottom. Goals are work in
// their own right, so this page needs no org: it reads the same document the
// Org screen does, narrowed to its goals.
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { CompanyDocument } from "../../components/company/CompanyDocument";

export default function GoalsPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <CompanyDocument filter="goals" />
      </DashboardLayout>
    </AuthGuard>
  );
}
