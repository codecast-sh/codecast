"use client";
// /projects: every project, grouped under the goal it serves. A project opens
// on its own page (/projects/<pj-…>). Needs no org.
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { CompanyDocument } from "../../components/company/CompanyDocument";

export default function ProjectsPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <CompanyDocument filter="projects" />
      </DashboardLayout>
    </AuthGuard>
  );
}
