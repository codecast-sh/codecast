import { useState, useCallback } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useSearchParams, useRouter } from "next/navigation";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { ActivityFeed } from "../../components/ActivityFeed";
import { reportWebVitals } from "../../lib/reportWebVitals";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../../store/inboxStore";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

export default function DashboardPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const filterParam = searchParams.get("filter");
  const [filter, setFilter] = useState<"my" | "team">(
    filterParam === "team" ? "team" : "my"
  );
  const [directoryFilter, setDirectoryFilter] = useState<string | null>(
    searchParams.get("dir")
  );
  const [memberFilter, setMemberFilter] = useState<string | null>(
    searchParams.get("member")
  );

  const user = useQuery(api.users.getCurrentUser);
  const activeTeamId = useInboxStore((s: any) => s.clientState?.ui?.active_team_id) as Id<"teams"> | undefined;
  const teamId = activeTeamId || user?.active_team_id || (user as any)?.team_id;

  const handleFilterChange = useCallback((newFilter: "my" | "team") => {
    setFilter(newFilter);
    const params = new URLSearchParams(searchParams.toString());
    if (newFilter === "team") {
      params.set("filter", "team");
      // Clear member filter when switching to team view
      params.delete("member");
      setMemberFilter(null);
    } else {
      params.delete("filter");
    }
    router.replace(`/dashboard?${params.toString()}`, { scroll: false });
  }, [searchParams, router]);

  const handleMemberFilterChange = useCallback((memberId: string | null) => {
    setMemberFilter(memberId);
    const params = new URLSearchParams(searchParams.toString());
    if (memberId) {
      params.set("member", memberId);
    } else {
      params.delete("member");
    }
    router.replace(`/dashboard?${params.toString()}`, { scroll: false });
  }, [searchParams, router]);

  const handleDirectoryFilterChange = useCallback((dir: string | null) => {
    setDirectoryFilter(dir);
    const params = new URLSearchParams(searchParams.toString());
    if (dir) {
      params.set("dir", dir);
    } else {
      params.delete("dir");
    }
    router.replace(`/dashboard?${params.toString()}`, { scroll: false });
  }, [searchParams, router]);

  useWatchEffect(() => {
    const memberParam = searchParams.get("member");
    if (memberParam !== memberFilter) {
      setMemberFilter(memberParam);
    }
  }, [searchParams]);

  useWatchEffect(() => {
    const dirParam = searchParams.get("dir");
    if (dirParam !== directoryFilter) {
      setDirectoryFilter(dirParam);
    }
  }, [searchParams]);

  useWatchEffect(() => {
    const newFilter = filterParam === "team" ? "team" : "my";
    if (newFilter !== filter) {
      setFilter(newFilter);
    }
  }, [filterParam]);

  useMountEffect(() => {
    reportWebVitals((metric) => {
      console.log(`[Dashboard Vitals] ${metric.name}:`, metric.value);
    });

    const startMark = 'dashboard-mount';
    performance.mark(startMark);

    return () => {
      performance.measure('dashboard-lifecycle', startMark);
      const measures = performance.getEntriesByName('dashboard-lifecycle');
      if (measures.length > 0) {
        console.log(`[Dashboard] Mount to unmount: ${measures[0].duration.toFixed(2)}ms`);
      }
    };
  });

  return (
    <AuthGuard>
      <DashboardLayout
        filter={filter}
        onFilterChange={handleFilterChange}
        directoryFilter={directoryFilter}
        onDirectoryFilterChange={handleDirectoryFilterChange}
      >
        <ErrorBoundary name="ActivityFeed" level="inline">
          <ActivityFeed
            mode={filter === "team" ? "team" : "personal"}
            teamId={teamId}
            directoryFilter={directoryFilter}
          />
        </ErrorBoundary>
      </DashboardLayout>
    </AuthGuard>
  );
}
