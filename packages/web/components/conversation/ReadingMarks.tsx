"use client";

import { memo, useRef, useState, type RefObject } from "react";
import { useConvexAuth } from "convex/react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { usePresenceRows, type PresenceRow } from "../../hooks/useDocPresence";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useTrackedStore } from "../../store/inboxStore";
import { HoverCard } from "../ui/HoverCard";
import { compactDuration, presenceLine } from "../presence/memberPresence";
import { composeDocId } from "../../lib/composerPresence";
import { PresenceAvatar } from "../PresenceFacepile";

// Where each other person is reading this transcript: "look at this" without
// a link, and a glance tells you whether they have read the agent's last turn
// before you answer it. The place rides their composer presence row (anchor:
// the message at the top of their screen and how far into it), written at
// most twice a second and only while someone else is here.
//
// Two halves. ReaderFaces draws their face beside the text they are on, inside
// the message row, so it scrolls with the transcript. ReadingMarks covers the
// case where that text is off screen: a pill above the composer that names
// them and the direction, and takes you there.

function useReaders(conversationId: string): PresenceRow[] {
  const { isAuthenticated } = useConvexAuth();
  return usePresenceRows(composeDocId(conversationId), isAuthenticated);
}

function firstNames(rows: readonly PresenceRow[]): string {
  const names = rows.map((r) => (r.user_name || "Someone").split(" ")[0]);
  return names.length <= 2 ? names.join(" and ") : `${names[0]} and ${names.length - 1} others`;
}

/** How long since a reader last moved through the transcript: "now", "4m ago". */
function sinceLabel(row: PresenceRow, now: number): string {
  const d = compactDuration(now - (row.anchor_at ?? now));
  return d === "now" ? "now" : `${d} ago`;
}

function ReaderCard({ row, now }: { row: PresenceRow; now: number }) {
  const st = useTrackedStore([(s) => s.teamMembers]);
  const member = (st.teamMembers as any[] | undefined)?.find((m) => String(m._id) === row.user_id);
  const moved = row.anchor_at ? now - row.anchor_at : 0;
  const draft = row.draft_text?.trim();
  return (
    <div className="flex flex-col gap-1.5 p-3 text-xs" data-reader-card>
      <div className="flex items-center gap-2">
        <PresenceAvatar person={row} size={28} ring={false} title="" />
        <div className="min-w-0">
          <div className="truncate font-medium text-sol-text">{row.user_name}</div>
          {member && <div className="text-sol-text-dim">{presenceLine(member, now)}</div>}
        </div>
      </div>
      <div className="text-sol-text-muted">
        {moved < 60_000 ? "Reading here now" : `Stopped here ${compactDuration(moved)} ago`}
      </div>
      {draft && <div className="truncate italic text-sol-text-dim">Typing: {draft}</div>}
    </div>
  );
}

/** The faces of everyone reading this message, in the row's right padding at the line they are on, each with how long ago they moved. */
export const ReaderFaces = memo(function ReaderFaces({ conversationId, messageId }: { conversationId: string; messageId: string }) {
  const here = useReaders(conversationId).filter((r) => r.anchor?.message_id === messageId);
  const now = useCoarseNow(30_000);
  if (here.length === 0) return null;
  const at = Math.min(1, Math.max(0, here[0].anchor?.offset ?? 0));
  return (
    <span
      data-sv-reader-faces
      className="absolute right-0.5 sm:right-1 z-10 flex flex-col items-end gap-1 transition-[top] duration-500 ease-out"
      style={{ top: `max(4px, calc(${at * 100}% - 9px))` }}
    >
      {here.map((r) => (
        <HoverCard key={r.user_id} card={<ReaderCard row={r} now={now} />} side="left" align="start" className="w-64" triggerClassName="flex flex-col items-end">
          <PresenceAvatar person={r} size={18} title="" />
          <span className="mt-0.5 whitespace-nowrap text-[9px] leading-none text-sol-text-dim">{sinceLabel(r, now)}</span>
        </HoverCard>
      ))}
    </span>
  );
});

type Direction = "above" | "below";

export const ReadingMarks = memo(function ReadingMarks({
  conversationId,
  scrollRef,
  messageIds,
  onJump,
  top,
  bottom,
}: {
  conversationId: string;
  scrollRef: RefObject<HTMLElement | null>;
  /** The message id of each timeline row (null for rows that are not messages). */
  messageIds: readonly (string | null)[];
  onJump: (messageId: string) => void;
  top: number;
  bottom: number;
}) {
  const idsRef = useRef(messageIds);
  idsRef.current = messageIds;
  const indexOf = (id: string) => idsRef.current.indexOf(id);
  const readers = useReaders(conversationId).filter((r) => r.anchor && indexOf(r.anchor.message_id) >= 0);
  const [away, setAway] = useState<Record<string, Direction>>({});
  const now = useCoarseNow(30_000);
  const readersSig = readers.map((r) => `${r.user_id}:${r.anchor!.message_id}:${r.anchor!.offset}`).join("|");

  // Which readers are off screen, and which way. Measured off the rendered
  // rows on scroll; listening only while someone else is here.
  useWatchEffect(() => {
    const el = scrollRef.current;
    if (!el || readers.length === 0) {
      setAway((prev) => (Object.keys(prev).length ? {} : prev));
      return;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const box = el.getBoundingClientRect();
      const viewTop = box.top + top;
      const viewBottom = box.bottom - bottom;
      const rendered = Array.from(el.querySelectorAll<HTMLElement>("[data-index]"), (n) => Number(n.dataset.index));
      const minRendered = rendered.length ? Math.min(...rendered) : Infinity;
      const next: Record<string, Direction> = {};
      for (const r of readers) {
        const i = indexOf(r.anchor!.message_id);
        const row = el.querySelector<HTMLElement>(`[data-index="${i}"]`);
        if (!row) {
          next[r.user_id] = i < minRendered ? "above" : "below";
          continue;
        }
        const rect = row.getBoundingClientRect();
        const y = rect.top + rect.height * (r.anchor!.offset ?? 0);
        if (y < viewTop) next[r.user_id] = "above";
        else if (y > viewBottom) next[r.user_id] = "below";
      }
      setAway((prev) => {
        const a = Object.entries(prev).sort().join();
        return a === Object.entries(next).sort().join() ? prev : next;
      });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    el.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [readersSig, top, bottom]);

  const groups = (["above", "below"] as const)
    .map((dir) => ({ dir, rows: readers.filter((r) => away[r.user_id] === dir) }))
    .filter((g) => g.rows.length > 0);
  if (groups.length === 0) return null;
  return (
    <div data-sv-reading-marks className="absolute inset-x-0 z-20 flex justify-center gap-2 pointer-events-none" style={{ bottom: bottom + 12 }}>
      {groups.map(({ dir, rows }) => {
        const Arrow = dir === "above" ? ArrowUp : ArrowDown;
        return (
          <button
            key={dir}
            type="button"
            onClick={() => onJump(rows[0].anchor!.message_id)}
            className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-sol-border bg-sol-bg-alt py-0.5 pl-0.5 pr-2.5 text-[11px] text-sol-text-muted shadow-lg transition-colors hover:text-sol-text animate-in fade-in"
          >
            <span className="flex -space-x-1.5">
              {rows.slice(0, 3).map((r) => <PresenceAvatar key={r.user_id} person={r} size={18} title="" />)}
            </span>
            {firstNames(rows)} {rows.length === 1 ? "is" : "are"} reading {dir}
            {rows.length === 1 && <span className="text-sol-text-dim">· {sinceLabel(rows[0], now)}</span>}
            <Arrow className="h-3 w-3" />
          </button>
        );
      })}
    </div>
  );
});
