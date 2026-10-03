// Provenance and privacy accounting (spec 4.8), worked out from counts alone:
// how many team-visible sessions and commits the edition was written from, and
// how many sessions the team cannot see contributed only their commit
// messages. A count, never a title. Then the keyboard, then when the notes
// were written, or why they were not.
import type { ShortcutAction } from "../../shortcuts";
import type { EditionRow } from "../../hooks/useSyncChanges";
import { changesDayLabel, localDay } from "../../lib/changesDay";
import { MetaDot } from "../entityDisplay";
import { clockOf } from "./StoryParts";
import type { EditionStats } from "./editionModel";
import { KeyHint } from "./useChangesKeys";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

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

export function ChangesFooter({ stats, edition, hasSignals, mode = "day", date, today }: {
  /** The view's counts; null while the view is still loading. */
  stats: EditionStats | null;
  /** The day edition, or in week mode the week edition. */
  edition: EditionRow | undefined;
  hasSignals: boolean;
  mode?: "day" | "week";
  /** The day on screen; empty in week mode. */
  date: string;
  today: string;
}) {
  // A clock alone only for notes written on the day on screen; anything else
  // (a week, a day finished later) names its day too.
  const writtenAt = (t: number) => {
    const day = localDay(0, t);
    return day === date ? clockOf(t) : `${changesDayLabel(day)}, ${clockOf(t)}`;
  };
  const notes =
    edition?.capped_at ? (mode === "week" ? "Prose paused for this week (spending limit)." : `Prose paused for ${date === today ? "today" : "this day"} (daily limit).`)
    : edition?.status === "failed" ? "Prose unavailable for this edition; showing commit subjects."
    : edition && (edition.status === "written" || edition.status === "final") ? `Notes written ${writtenAt(edition.generated_at)}.`
    : null;
  return (
    <footer className="mt-12 space-y-2 border-t border-sol-border/20 pb-10 pt-4">
      {stats && (
        <p className="chg-ui text-[12px] leading-[1.55] text-sol-text/55">
          Written from {stats.sessions > 0 && <>{plural(stats.sessions, "team-visible session")} and </>}{plural(stats.commits, "commit")}.
          {stats.private_sessions > 0 ? (
            <> {plural(stats.private_sessions, "session is", "sessions are")} not shared with the team and contributed commit messages only.</>
          ) : stats.sessions === 0 && stats.commits > 0 && (
            <span className="text-sol-text/40"> None of these commits came from a session shared with the team, so reasons are taken from commit messages.</span>
          )}
        </p>
      )}
      {/* What is live is a fact about now, so only today's edition speaks of it. */}
      {!hasSignals && mode === "day" && date === today && (
        <p className="chg-ui text-[12px] text-sol-text/45">What is live is unknown: no release tag or deploy marker has been posted for this repository.</p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-sol-text/45">
        {KEYS(mode).map((k) => (
          <span key={k.label} className="inline-flex items-center gap-1">
            {k.actions.map((a) => <KeyHint key={a} action={a} />)}
            <span className="font-mono">{k.label}</span>
          </span>
        ))}
      </div>
      {notes && (
        <p className="flex items-center gap-1.5 font-mono text-[10px] text-sol-text/45">
          {notes}
          {edition?.capped_at && edition.status !== "facts" && edition.status !== "failed" && (
            <>
              <MetaDot /> notes written {writtenAt(edition.generated_at)}
            </>
          )}
        </p>
      )}
    </footer>
  );
}
