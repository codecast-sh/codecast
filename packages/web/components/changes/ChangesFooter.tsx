// Provenance and privacy accounting (spec 4.8), worked out from counts alone:
// how many team-visible sessions and commits the edition was written from, and
// how many sessions the team cannot see contributed only their commit
// messages. A count, never a title. Then the keyboard, then when the notes
// were written, or why they were not.
import type { ShortcutAction } from "../../shortcuts";
import type { EditionRow } from "../../hooks/useSyncChanges";
import { MetaDot } from "../entityDisplay";
import { clockOf } from "./StoryParts";
import type { EditionStats } from "./editionModel";
import { KeyHint } from "./useChangesKeys";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const KEYS: { actions: ShortcutAction[]; label: string }[] = [
  { actions: ["changes.prevDay", "changes.nextDay"], label: "days" },
  { actions: ["changes.next", "changes.prev"], label: "stories" },
  { actions: ["changes.evidence"], label: "evidence" },
  { actions: ["changes.open"], label: "open" },
  { actions: ["changes.waiting"], label: "waiting" },
  { actions: ["changes.risks"], label: "risks" },
  { actions: ["changes.branches"], label: "branches" },
  { actions: ["changes.copyLink"], label: "link" },
];

export function ChangesFooter({ stats, edition, hasSignals }: { stats: EditionStats; edition: EditionRow | undefined; hasSignals: boolean }) {
  const notes =
    edition?.capped_at ? "Prose paused for today (daily limit)."
    : edition?.status === "failed" ? "Prose unavailable for this edition; showing commit subjects."
    : edition && (edition.status === "written" || edition.status === "final") ? `Notes written ${clockOf(edition.generated_at)}.`
    : null;
  return (
    <footer className="mt-12 space-y-2 border-t border-sol-border/20 pb-10 pt-4">
      <p className="chg-ui text-[12px] leading-[1.55] text-sol-text/55">
        Written from {plural(stats.sessions, "team-visible session")} and {plural(stats.commits, "commit")}.
        {stats.private_sessions > 0 && (
          <> {plural(stats.private_sessions, "session is", "sessions are")} not shared with the team and contributed commit messages only.</>
        )}
      </p>
      {!hasSignals && (
        <p className="chg-ui text-[12px] text-sol-text/45">Tag releases or post deploy markers to see what is live.</p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-sol-text/45">
        {KEYS.map((k) => (
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
              <MetaDot /> notes written {clockOf(edition.generated_at)}
            </>
          )}
        </p>
      )}
    </footer>
  );
}
