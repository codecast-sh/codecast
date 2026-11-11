import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, ChartColumn } from "lucide-react";
import { navRow } from "../../lib/navRegistry";
import { SegmentedToggle } from "../SegmentedToggle";
import { PageHeader } from "../ui/page-header";
import { Button } from "../ui/button";
import type { ActivityViewState } from "./useActivityView";
import type { ActivityTab } from "./activityView";

// The Activity page's header, in every style: the page's name, its two tabs
// (Activity and Messages, each its own address), the way to the team's
// charts, and the filter row under them. Modern draws it as the shared page
// bar (components/ui/page-header); Classic and Minimal draw it at the top of
// the page's column, in the shapes their other pages use (an accent icon and
// an 18px title, the boxed segmented toggle, a quiet accent link), named as
// their sidebar names the page (lib/navRegistry classicLabel: "Feed").

const TABS = [{ key: "activity", label: "Activity" }, { key: "messages", label: "Messages" }];
const LEGACY_TITLE = navRow("activity").classicLabel ?? navRow("activity").label;

export function ActivityHeader({ tab, state, hasTeam, count, children }: {
  tab: ActivityTab;
  state: ActivityViewState;
  hasTeam: boolean;
  count?: number | null;
  children?: ReactNode;
}) {
  const router = useRouter();
  const onTab = (key: string) => { if (key !== tab) router.push(state.tabHref(key as ActivityTab)); };
  return (
    <PageHeader
      legacy={<ActivityLegacyHeader tab={tab} onTab={onTab} hasTeam={hasTeam}>{children}</ActivityLegacyHeader>}
      title="Activity"
      icon={Activity}
      count={count}
      tabs={<SegmentedToggle value={tab} onChange={onTab} items={TABS} />}
      actions={hasTeam ? (
        <Button asChild variant="ghost" size="sm">
          <Link href="/team/charts"><ChartColumn aria-hidden />Charts</Link>
        </Button>
      ) : null}
    >
      {children}
    </PageHeader>
  );
}

/** Classic and Minimal: the title row, then the filters. */
function ActivityLegacyHeader({ tab, onTab, hasTeam, children }: {
  tab: ActivityTab;
  onTab: (key: string) => void;
  hasTeam: boolean;
  children?: ReactNode;
}) {
  return (
    <header data-activity-head className="mb-5">
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2">
        <Activity aria-hidden className="size-4 shrink-0 text-sol-cyan" />
        <h1 className="text-title font-semibold text-sol-text">{LEGACY_TITLE}</h1>
        <SegmentedToggle value={tab} onChange={onTab} items={TABS} />
        {hasTeam && (
          <Link
            href="/team/charts"
            data-activity-charts
            className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-meta text-sol-cyan/70 transition-colors hover:bg-sol-bg-alt hover:text-sol-cyan"
          >
            <ChartColumn aria-hidden className="size-3.5" />
            Charts
          </Link>
        )}
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
    </header>
  );
}
