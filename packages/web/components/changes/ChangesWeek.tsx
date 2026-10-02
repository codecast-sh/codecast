// The week view's body (spec 3, level 4). The week edition's prose, its five
// biggest stories and its release ledger arrive with the week build (T14);
// until then the week reads as its seven day editions, each a line that opens
// its day, built only from what the day editions and stories already hold.
import { statsHeadline } from "@codecast/shared/changes";
import type { EditionRow, StoryRow, WorksRow } from "../../hooks/useSyncChanges";
import { changesDayLabel } from "../../lib/changesDay";
import { areaTouches, dayStats, storiesOfDay } from "./editionModel";
import { InTheWorks } from "./InTheWorks";

export function ChangesWeek({ days, today, editions, stories, works, branches, onDay }: {
  days: readonly string[];
  today: string;
  editions: readonly EditionRow[];
  stories: readonly StoryRow[];
  works: readonly WorksRow[];
  branches: "main" | "all";
  onDay: (day: string) => void;
}) {
  const week = days.filter((d) => d <= today);
  const weekStories = week.flatMap((d) => storiesOfDay(stories, d, branches));
  return (
    <div className="chg-grid mt-7">
      <div className="chg-span-8 chg-rise space-y-1" style={{ ["--i" as any]: 0 }}>
        {week.map((d) => {
          const edition = editions.find((e) => e.date === d);
          const day = storiesOfDay(stories, d, branches);
          const stats = dayStats(day, edition, edition?.releases ?? []);
          const prose = !!edition?.headline && (edition.status === "written" || edition.status === "final");
          const quiet = stats.stories === 0 && !edition;
          return (
            <button
              key={d}
              type="button"
              onClick={() => onDay(d)}
              className="group grid w-full grid-cols-[6.5rem_minmax(0,1fr)_auto] items-baseline gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-sol-bg-alt/60"
            >
              <span className="font-mono text-[12px] tabular-nums text-sol-text/55">{changesDayLabel(d)}</span>
              <span className={`chg-ui truncate text-[15px] ${quiet ? "text-sol-text/40" : "font-medium text-sol-text/90"}`}>
                {quiet ? "Nothing landed" : prose ? edition!.headline : statsHeadline(stats)}
              </span>
              <span className="font-mono text-[10px] tabular-nums text-sol-text/45">{quiet ? "" : `${stats.commits} commits`}</span>
            </button>
          );
        })}
      </div>
      <aside className="chg-works chg-rise" style={{ ["--i" as any]: 1 }}>
        <InTheWorks works={works} areas={areaTouches(weekStories)} areasLabel="Areas this week" />
      </aside>
    </div>
  );
}
