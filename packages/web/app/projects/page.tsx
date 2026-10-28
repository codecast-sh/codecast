"use client";
// /projects: every project, grouped under the goal it serves, or in time
// (?view=timeline). A project opens
// on its own page (/projects/<pj-…>). Needs no org.
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { PlanningScreen } from "../../components/roadmap/PlanningScreen";
import { CompanyDocument } from "../../components/company/CompanyDocument";

export default function ProjectsPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <PlanningScreen scope="projects" base="/projects">
          <CompanyDocument filter="projects" />
        </PlanningScreen>
      </DashboardLayout>
    </AuthGuard>
  );
}
