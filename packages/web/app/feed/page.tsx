import { useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { MessageFeed } from "../../components/MessageFeed";
import { PageFrame, PageHeader } from "../../components/ui/page-header";
import { SegmentedToggle } from "../../components/SegmentedToggle";
import { useIsModernStyle } from "../../hooks/useVisualStyle";
import { ModernActivityPage } from "../../components/activity/ModernActivityPage";

const FILTERS = [
  { key: "my", label: "My Messages" },
  { key: "team", label: "Team" },
];

export default function FeedPage() {
  const [filter, setFilter] = useState<"my" | "team">("my");
  // Modern: the message feed is the Messages tab of the Activity page.
  const modern = useIsModernStyle();
  if (modern) return <AuthGuard><DashboardLayout><ModernActivityPage tab="messages" /></DashboardLayout></AuthGuard>;

  // Classic and Minimal: the page's own title row and line.
  const legacy = (
    <>
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold text-sol-text">Message Feed</h1>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setFilter("my")}
                className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                  filter === "my"
                    ? "bg-sol-blue/20 text-sol-blue border border-sol-blue/30"
                    : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt"
                }`}
              >
                My Messages
              </button>
              <button
                onClick={() => setFilter("team")}
                className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                  filter === "team"
                    ? "bg-sol-violet/20 text-sol-violet border border-sol-violet/30"
                    : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt"
                }`}
              >
                Team
              </button>
            </div>
          </div>
          <p className="text-sol-text-muted text-sm">
            All messages across your sessions in chronological order.
          </p>
    </>
  );

  return (
    <AuthGuard>
      <DashboardLayout>
        <PageFrame
          header={
            <PageHeader
              legacy={legacy}
              title="Message feed"
              tabs={<SegmentedToggle value={filter} onChange={(key) => setFilter(key as "my" | "team")} items={FILTERS} />}
            />
          }
          legacyColumn="space-y-4"
          column="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 lg:px-8"
        >
          <MessageFeed filter={filter} />
        </PageFrame>
      </DashboardLayout>
    </AuthGuard>
  );
}
