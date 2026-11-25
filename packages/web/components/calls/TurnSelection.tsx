import { useState } from "react";
import { Link2, Send, X } from "lucide-react";
import { callPathRef, lineFrameMs } from "@codecast/shared/contracts";
import { useMountEffect } from "../../hooks/useMountEffect";
import { copyCallLink } from "../../lib/calls/callLinks";
import { turnsAnchor, type Turn } from "./transcriptTurnModel";
import { openFeedTargetPicker, useSendExcerpt, type FeedTarget } from "./useCallFeed";

/** A range of speaker turns, like text selection snapped to turns: an anchor
 *  and an end. The call page and the stage rail select the same way, so a
 *  turn does the same thing wherever the thread shows it. */
export function useTurnSelection() {
  const [anchor, setAnchor] = useState<number | null>(null);
  const [end, setEnd] = useState<number | null>(null);
  const lo = anchor === null ? null : end === null ? anchor : Math.min(anchor, end);
  const hi = anchor === null ? null : end === null ? anchor : Math.max(anchor, end);
  const count = lo === null ? 0 : (hi as number) - lo + 1;
  const clear = () => {
    setAnchor(null);
    setEnd(null);
  };
  useMountEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return {
    anchor,
    lo,
    hi,
    count,
    clear,
    isSelected: (i: number) => lo !== null && i >= lo && i <= (hi as number),
    /** A finger held on a turn starts a selection there. */
    hold: (i: number) => {
      setAnchor(i);
      setEnd(null);
    },
    /** A click: starts a selection, extends it, or clears a lone anchor. */
    pick: (i: number) => {
      if (anchor === null) return setAnchor(i);
      if (i === anchor && end === null) return clear();
      setEnd(i);
    },
    /** A link that opens on a range of turns. */
    setRange: (from: number, to: number) => {
      setAnchor(from);
      setEnd(to);
    },
  };
}

export type TurnSelection = ReturnType<typeof useTurnSelection>;

/** The bar under a thread with turns selected: how many, send them to an
 *  agent, copy a link that opens the call on them, clear. */
export function TurnSelectionBar({
  call,
  turns,
  selection,
  live,
  video,
  onSent,
}: {
  call: { _id: string; short_id?: string | null; title?: string | null; started_at: number };
  turns: Turn[];
  selection: TurnSelection;
  live: boolean;
  /** The call has video: the copied link also waits at the first line's moment. */
  video?: boolean;
  onSent: (what: string) => void;
}) {
  const sendExcerpt = useSendExcerpt();
  const { lo, hi, count } = selection;
  if (lo === null || count === 0) return null;
  const chosen = turns.slice(lo, (hi as number) + 1);
  const onPick = (t: FeedTarget, note?: string) => {
    const excerpt = {
      segments: chosen.flatMap((t) => t.segments),
      transcriptId: String(call._id),
      title: call.title,
      startedAt: call.started_at,
      live,
      partial: count < turns.length,
    };
    void sendExcerpt(t, excerpt, note).then(() =>
      onSent(t.kind === "new-doc" ? "saved to doc" : "sent. The agent replies in the side panel."),
    );
    selection.clear();
  };
  const first = chosen[0]?.segments[0];
  return (
    <div className="z-20 flex shrink-0 justify-center border-t border-sol-border/20 px-2 py-2.5">
      <div className="relative flex flex-wrap items-center justify-center gap-2 rounded-xl border border-sol-border bg-sol-bg-alt px-3 py-2 shadow-2xl">
        <span className="text-[12px] text-sol-text-muted">
          {count} turn{count === 1 ? "" : "s"} selected
        </span>
        <button
          type="button"
          onClick={() =>
            openFeedTargetPicker({
              title: `Send ${count} turn${count === 1 ? "" : "s"} to…`,
              gesture: "send",
              withNote: true,
              onPick,
            })
          }
          className="flex items-center gap-1.5 rounded-md bg-sol-violet/15 px-2.5 py-1 text-[12px] font-medium text-sol-violet transition-colors hover:bg-sol-violet/25"
        >
          <Send className="h-3 w-3" /> Send to agent
        </button>
        <button
          type="button"
          onClick={() => copyCallLink(callPathRef(call), turnsAnchor(chosen), video && first ? lineFrameMs(first) : undefined)}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium text-sol-text-muted transition-colors hover:bg-sol-bg/60 hover:text-sol-text"
          title={
            video
              ? "Copy a link that opens the call on these turns, the video waiting at the first"
              : "Copy a link that opens the call on these turns"
          }
        >
          <Link2 className="h-3 w-3" /> Copy link
        </button>
        <button
          type="button"
          onClick={selection.clear}
          className="rounded p-1 text-sol-text-dim transition-colors hover:text-sol-text"
          title="Clear selection (Esc)"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
