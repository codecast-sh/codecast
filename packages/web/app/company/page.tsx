"use client";
// /company: the whole company as one document, top to bottom
// (docs/architecture/initiatives-projects-role-page.md I5 "Where it shows").
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { CompanyDocument } from "../../components/company/CompanyDocument";

export default function CompanyPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <CompanyDocument />
      </DashboardLayout>
    </AuthGuard>
  );
}
