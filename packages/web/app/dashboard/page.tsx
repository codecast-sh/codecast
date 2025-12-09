"use client";

import { useState, useCallback } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ConversationList } from "../../components/ConversationList";

export default function DashboardPage() {
  const [filter, setFilter] = useState<"my" | "team">("my");
  const [directories, setDirectories] = useState<string[]>([]);
  const [directoryFilter, setDirectoryFilter] = useState<string | null>(null);

  const handleDirectoriesChange = useCallback((dirs: string[]) => {
    setDirectories(dirs);
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
          onDirectoriesChange={handleDirectoriesChange}
        />
      </DashboardLayout>
    </AuthGuard>
  );
}
