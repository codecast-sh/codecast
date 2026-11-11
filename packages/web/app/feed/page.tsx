import { useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { MessageFeed } from "../../components/MessageFeed";
import { SegmentedToggle } from "../../components/SegmentedToggle";

export default function FeedPage() {
  const [filter, setFilter] = useState<"my" | "team">("my");

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-baseline gap-3">
              <h1 className="shrink-0 text-[18px] font-semibold text-sol-text">Message feed</h1>
              <span className="hidden min-w-0 truncate text-[13px] text-sol-text-dim sm:inline">All messages across your sessions in chronological order.</span>
            </div>
            <SegmentedToggle
              value={filter}
              onChange={(k) => setFilter(k as "my" | "team")}
              items={[{ key: "my", label: "My messages" }, { key: "team", label: "Team" }]}
            />
          </div>
          <MessageFeed filter={filter} />
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
