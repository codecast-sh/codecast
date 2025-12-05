"use client";

import { useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ConversationList } from "../../components/ConversationList";

export default function DashboardPage() {
  const [filter, setFilter] = useState<"my" | "team">("my");

  return (
    <AuthGuard>
      <DashboardLayout filter={filter} onFilterChange={setFilter}>
        <ConversationList filter={filter} />
      </DashboardLayout>
    </AuthGuard>
  );
}
