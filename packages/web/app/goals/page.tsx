"use client";
// /goals: every goal the workspace keeps, as one document written and
// arranged in place, or in time (?view=timeline). Goals are work in their own right, so this page needs no
// org: it reads the same company document the Org screen does.
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { PlanningScreen } from "../../components/roadmap/PlanningScreen";
import { GoalsDocument } from "../../components/goals/GoalsDocument";

export default function GoalsPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <PlanningScreen scope="goals" base="/goals">
          <GoalsDocument />
        </PlanningScreen>
      </DashboardLayout>
    </AuthGuard>
  );
}
