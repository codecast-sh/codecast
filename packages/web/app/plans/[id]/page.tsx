"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { AuthGuard } from "../../../components/AuthGuard";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { PlanDetailPanel } from "../../../components/PlanDetailPanel";
import { ArrowLeft } from "lucide-react";

export default function PlanDetailPage() {
  const params = useParams();
  const id = params?.id as string;

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="h-full overflow-y-auto">
          <div className="max-w-3xl mx-auto px-6 pt-4">
            <Link href="/plans" className="inline-flex items-center gap-1.5 text-xs text-sol-text-dim hover:text-sol-text transition-colors">
              <ArrowLeft className="w-3 h-3" />
              Plans
            </Link>
          </div>
          <PlanDetailPanel planId={id} />
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
