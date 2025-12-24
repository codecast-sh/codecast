"use client";

import { useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { TimelineFeed } from "../../components/TimelineFeed";

export default function TimelinePage() {
  const [filter, setFilter] = useState<"my" | "team">("my");
  const [dateRange, setDateRange] = useState<{ start?: number; end?: number }>({});

  return (
    <AuthGuard>
      <DashboardLayout
        filter={filter}
        onFilterChange={setFilter}
        directories={[]}
        directoryFilter={null}
        onDirectoryFilterChange={() => {}}
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold text-sol-text">Timeline</h1>
          </div>
          <TimelineFeed filter={filter} dateRange={dateRange} />
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
