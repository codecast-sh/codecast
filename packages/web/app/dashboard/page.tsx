"use client";

import { useState, useCallback, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ConversationList } from "../../components/ConversationList";
import { reportWebVitals } from "../../lib/reportWebVitals";

export default function DashboardPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [filter, setFilter] = useState<"my" | "team">("my");
  const [directories, setDirectories] = useState<string[]>([]);
  const [directoryFilter, setDirectoryFilter] = useState<string | null>(null);
  const [memberFilter, setMemberFilter] = useState<string | null>(
    searchParams.get("member")
  );

  const handleDirectoriesChange = useCallback((dirs: string[]) => {
    setDirectories(dirs);
  }, []);

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

  useEffect(() => {
    const memberParam = searchParams.get("member");
    if (memberParam !== memberFilter) {
      setMemberFilter(memberParam);
    }
  }, [searchParams]);

  useEffect(() => {
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
  }, []);

  return (
    <AuthGuard>
      <DashboardLayout
        filter={filter}
        onFilterChange={setFilter}
        directories={directories}
        directoryFilter={directoryFilter}
        onDirectoryFilterChange={setDirectoryFilter}
      >
        <ConversationList
          filter={filter}
          directoryFilter={directoryFilter}
          memberFilter={memberFilter}
          onDirectoriesChange={handleDirectoriesChange}
          onMemberFilterChange={handleMemberFilterChange}
        />
      </DashboardLayout>
    </AuthGuard>
  );
}
