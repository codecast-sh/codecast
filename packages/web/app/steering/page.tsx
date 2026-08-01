"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Compass } from "lucide-react";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import {
  useSyncStrategies,
  useSyncSteeringItems,
} from "../../hooks/useSyncSteering";
import { useSyncTasks } from "../../hooks/useSyncTasks";
import { useSyncPlans } from "../../hooks/useSyncPlans";
import { StrategySection } from "../../components/steering/StrategySection";
import {
  SteeringWorkspace,
  type SteeringView,
} from "../../components/steering/SteeringWorkspace";

const VIEWS: Array<{ key: SteeringView; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "map", label: "Map" },
  { key: "strategy", label: "Strategy" },
  { key: "my-work", label: "My work" },
];

function Content() {
  const strategiesSync = useSyncStrategies();
  const itemsSync = useSyncSteeringItems();
  useSyncTasks();
  useSyncPlans();
  const params = useParams();
  const router = useRouter();
  const search = useSearchParams();
  const raw = params?.section as string | undefined;
  const view: SteeringView = VIEWS.some((v) => v.key === raw)
    ? (raw as SteeringView)
    : "overview";
  const selectedId = search.get("id");
  const navigate = (next: SteeringView) =>
    router.push(next === "overview" ? "/steering" : `/steering/${next}`);
  return (
    <div className="h-full flex flex-col bg-sol-bg">
      <header className="flex items-center gap-3 px-4 sm:px-6 py-3 border-b border-sol-border/30">
        <Compass className="w-5 h-5 text-sol-cyan" strokeWidth={1.6} />
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold text-sol-text">Steering</h1>
          <p className="text-[11px] text-sol-text-dim hidden sm:block">
            Outcomes, beliefs, learning, and initiatives in one operating map
          </p>
        </div>
        <nav className="flex gap-1 overflow-x-auto" aria-label="Steering views">
          {VIEWS.map((item) => (
            <button
              key={item.key}
              onClick={() => navigate(item.key)}
              aria-current={view === item.key ? "page" : undefined}
              className={`px-3 py-1.5 rounded-md text-xs whitespace-nowrap transition-colors ${view === item.key ? "bg-sol-cyan/12 text-sol-cyan" : "text-sol-text-muted hover:bg-sol-bg-highlight hover:text-sol-text"}`}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>
      <main data-main-scroll className="flex-1 min-h-0 overflow-y-auto">
        <ErrorBoundary name={`Steering:${view}`} level="panel">
          {strategiesSync.loading || itemsSync.loading ? (
            <div
              className="max-w-6xl mx-auto p-6 space-y-3"
              aria-label="Loading Steering"
            >
              <div className="h-7 w-48 rounded bg-sol-bg-highlight animate-pulse" />
              <div className="h-32 rounded-xl bg-sol-card animate-pulse" />
              <div className="h-32 rounded-xl bg-sol-card animate-pulse" />
            </div>
          ) : view === "strategy" ? (
            <div className="max-w-6xl mx-auto p-4 sm:p-6">
              <StrategySection />
            </div>
          ) : (
            <SteeringWorkspace view={view} selectedId={selectedId} />
          )}
        </ErrorBoundary>
      </main>
    </div>
  );
}

export default function SteeringPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <Content />
      </DashboardLayout>
    </AuthGuard>
  );
}
