"use client";
// /goals/<in-N>: one goal on its own page.
import { useParams } from "next/navigation";
import { AuthGuard } from "../../../components/AuthGuard";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { GoalSheet } from "../../../components/org/company/sheets/GoalSheet";

export default function GoalPage() {
  const id = String(useParams()?.id ?? "");
  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="h-full overflow-y-auto" style={{ background: "var(--sol-bg)" }}>
          <div className="mx-auto max-w-[860px]">
            <GoalSheet sheet={{ kind: "initiative", ref: id }} />
          </div>
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
