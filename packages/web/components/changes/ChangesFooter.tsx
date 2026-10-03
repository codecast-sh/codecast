// Provenance and privacy accounting (spec 4.8), worked out from counts alone:
// how many team-visible sessions and commits the edition was written from, and
// how many sessions the team cannot see contributed only their commit
// messages. A count, never a title. Then the keyboard, then why prose is
// paused or missing, when it is.
import type { ShortcutAction } from "../../shortcuts";
import type { EditionRow } from "../../hooks/useSyncChanges";
import { addDays } from "@codecast/convex/convex/lib/teamDay";
import { changesDayLabel, localDay } from "../../lib/changesDay";
import { clockOf } from "./StoryParts";
import { PROSE_STATUSES, type EditionStats } from "./editionModel";
import { plural } from "./format";
import type { WeekNotes } from "./weekModel";
import { KeyHint } from "./useChangesKeys";


const KEYS = (mode: "day" | "week"): { actions: ShortcutAction[]; label: string }[] => [
  { actions: ["changes.prevDay", "changes.nextDay"], label: mode === "week" ? "weeks" : "days" },
  { actions: ["changes.today"], label: "today" },
  { actions: ["changes.mode"], label: mode === "week" ? "day" : "week" },
  { actions: ["changes.next", "changes.prev"], label: "stories" },
  { actions: ["changes.evidence"], label: "evidence" },
  { actions: ["changes.open"], label: "open" },
  { actions: ["changes.waiting"], label: "waiting" },
  { actions: ["changes.risks"], label: "risks" },
  { actions: ["changes.branches"], label: "branches" },
  { actions: ["changes.filter"], label: "filter" },
  { actions: ["changes.copyLink"], label: "link" },
  { actions: ["changes.escape"], label: "close" },
];

/** "128 of 161 commits", or when main has since lost commits, "161 commits, 128 now". */
const notesFromText = (n: { written: number; now: number }) =>
  n.written < n.now ? `${n.written.toLocaleString()} of ${plural(n.now, "commit")}` : `${plural(n.written, "commit")}, ${n.now.toLocaleString()} now`;

/**
 * Where the notes came from, in one sentence: when they were written, how far
 * a week's notes reach, the commits and team sessions behind them, and, for
 * the week in progress, the commits still to join them.
 */
export function provenanceText({ stats, edition, week, date, today }: {
  stats: EditionStats;
  edition: EditionRow | undefined;
  week?: WeekNotes | null;
  /** The day on screen; empty in week mode. */
  date: string;
  today: string;
}): string {
  const writtenAt = (t: number) => {
    const day = localDay(0, t);
    return day === date ? clockOf(t) : `${changesDayLabel(day)}, ${clockOf(t)}`;
  };
  const written = PROSE_STATUSES.has(edition?.status ?? "");
  const commits = week ? week.written : stats.commits;
  const sessions = week ? week.sessions : stats.sessions;
  // The week in progress, while its ended days are as the notes saw them: how much of today they hold, and what is still to join.
  const split = written && week?.today != null && week.todayIn != null ? { in: week.todayIn, later: week.today - week.todayIn } : null;
  const at = written ? writtenAt(edition!.generated_at) : "";
  let text = written ? `Notes written ${at}` : "Written";
  if (split && split.in === 0) text += `, through ${changesDayLabel(addDays(today, -1))}`;
  // "Sat 3 Oct, 10:29" closes with a comma of its own; a bare clock reads straight on.
  else if (at.includes(",")) text += ",";
  text += ` from ${week && week.today == null && week.written !== week.ended ? notesFromText({ written: week.written, now: week.ended }) : plural(commits, "commit")}`;
  if (split && split.in > 0) text += ` (${split.in.toLocaleString()} of them today's)`;
  if (sessions > 0) text += ` and ${plural(sessions, "team session")}`;
  if (split && split.later > 0) {
    text += split.in > 0
      ? `; today's ${plural(split.later, "later commit joins", "later commits join")} when the day ends`
      : `; today's ${plural(split.later, "commit joins", "commits join")} when the day ends`;
  }
  return `${text}.`;
}

export function ChangesFooter({ stats, edition, week, hasSignals, mode = "day", date, today }: {
  /** The view's counts; null while the view is still loading, or for a day where nothing landed. */
  stats: EditionStats | null;
  /** The day edition, or in week mode the week edition. */
  edition: EditionRow | undefined;
  /** What the week's written notes stand on (weekModel.weekNotes); week mode only. */
  week?: WeekNotes | null;
  hasSignals: boolean;
  mode?: "day" | "week";
  /** The day on screen; empty in week mode. */
  date: string;
  today: string;
}) {
  const status =
    edition?.capped_at ? (mode === "week" ? "Prose paused for this week (spending limit)." : `Prose paused for ${date === today ? "today" : "this day"} (daily limit).`)
    : edition?.status === "failed" ? "Prose unavailable for this edition; showing commit subjects."
    : null;
  return (
    <footer className="mt-12 space-y-2 border-t border-sol-border/20 pb-10 pt-4">
      {stats && stats.commits > 0 && (
        <p className="chg-ui text-[12px] leading-[1.55] text-sol-text/55">
          {provenanceText({ stats, edition, week, date, today })}
          {stats.private_sessions > 0 ? (
            <> {plural(stats.private_sessions, "session is", "sessions are")} not shared with the team and contributed commit messages only.</>
          ) : stats.sessions === 0 && stats.commits > 0 && (
            <span className="text-sol-text/40"> Reasons come from commit messages and PRs.</span>
          )}
        </p>
      )}
      {/* What is live is a fact about now, so only today's edition speaks of it, and only when something landed to be live. */}
      {!hasSignals && mode === "day" && date === today && !!stats?.commits && (
        <p className="chg-ui text-[12px] text-sol-text/45">No deploy marker for this repository, so live status is not shown.</p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-sol-text/45">
        {KEYS(mode).map((k) => (
          <span key={k.label} className="inline-flex items-center gap-1">
            {k.actions.map((a) => <KeyHint key={a} action={a} />)}
            <span className="font-mono">{k.label}</span>
          </span>
        ))}
      </div>
      {status && <p className="font-mono text-[10px] text-sol-text/45">{status}</p>}
    </footer>
  );
}
