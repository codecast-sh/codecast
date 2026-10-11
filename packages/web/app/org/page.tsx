"use client";
// /org: the company as one chart (components/org/OrgChart.tsx).
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { OrgChart } from "../../components/org/OrgChart";

export default function OrgPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <OrgChart />
      </DashboardLayout>
    </AuthGuard>
  );
}
