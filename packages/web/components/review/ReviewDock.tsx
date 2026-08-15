import { memo, useCallback, useEffect, useState } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import {
  countUnseenReviewItems,
  type ReviewItem,
} from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { relTimeShort } from "../../lib/utils";
import { MessageSquare, FileCode2, Globe, OctagonPause } from "lucide-react";

// The REVIEW dock: everything open and waiting on a human — comment threads on
// sessions (yours and teammates'), viewer comments on published pages, paused
// workflow gates — one line docked under the session list, the same idiom as
// the trigger dock beside it. The line is the briefing (count + "N new");
// expanding opens the roster; closing marks it read (review_seen_at). Items
// leave the roster by resolving at their source, never here — the dock is a
// projection of open work, not another pile to groom.

function kindIcon(item: ReviewItem) {
  if (item.kind === "page_comment") return <Globe className="w-3 h-3 shrink-0 text-sol-violet/80" />;
  if (item.kind === "workflow_gate") return <OctagonPause className="w-3 h-3 shrink-0 text-sol-magenta/80" />;
  if (item.anchor?.file_path) return <FileCode2 className="w-3 h-3 shrink-0 text-sol-cyan/80" />;
  return <MessageSquare className="w-3 h-3 shrink-0 text-sol-cyan/80" />;
}

function openReviewItem(item: ReviewItem) {
  if (item.kind === "page_comment") {
    if (item.artifact_url) window.open(item.artifact_url, "_blank", "noopener");
    return;
  }
  if (!item.conversation_id) return;
  const st = useInboxStore.getState();
  st.requestNavigate(item.conversation_id, {
    source: "gesture",
    ...(item.anchor?.message_id ? { scrollToMessageId: item.anchor.message_id } : {}),
  });
  if (item.kind === "comment_thread") {
    st.setCommentRailOpen(true);
    if (item.anchor?.message_id) st.openCommentThread(item.anchor.message_id);
  }
}

function ReviewRow({ item, onOpen }: { item: ReviewItem; onOpen: (item: ReviewItem) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className={`w-full flex items-start gap-2 px-3 py-1.5 text-left hover:bg-sol-bg-alt/60 transition-colors border-b border-sol-border/30${item.last_actor_is_viewer ? " opacity-55" : ""}`}
      title={item.last_actor_is_viewer ? "You spoke last — waiting on others" : "Open"}
    >
      <span className="mt-0.5">{kindIcon(item)}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="text-[11px] font-medium text-sol-text truncate">{item.title}</span>
          {(item.count ?? 1) > 1 && (
            <span className="shrink-0 text-[9px] tabular-nums text-sol-text-dim">{item.count}</span>
          )}
          <span className="ml-auto shrink-0 text-[9px] text-sol-text-dim tabular-nums">
            {relTimeShort(item.raised_at)}
          </span>
        </span>
        {(item.detail || item.actor_name) && (
          <span className="block text-[10px] text-sol-text-muted truncate">
            {item.actor_name ? <b className="font-medium">{item.actor_name}</b> : null}
            {item.actor_name && item.detail ? ": " : null}
            {item.detail}
          </span>
        )}
        {item.conversation_title && (
          <span className="block text-[9px] text-sol-text-dim truncate">{item.conversation_title}</span>
        )}
      </span>
    </button>
  );
}

function ReviewDockImpl() {
  // Enrichment-only surface: before the convex deploy lands, this must render
  // nothing — never drop the whole session panel into its ErrorBoundary.
  const { data: items } = useQueryNoThrow(api.reviewQueue.list, {}) as {
    data: ReviewItem[] | undefined;
    error: Error | undefined;
  };
  const seenAt = useInboxStore((s) => s.clientState.ui?.review_seen_at);
  const [open, setOpen] = useState(false);

  // Close marks read (not open): the per-row emphasis derives from the same
  // watermark, so stamping on open would blank "new" the moment the roster
  // appears. Every exit funnels through here — same contract as TriggerDock.
  const close = useCallback(() => {
    useInboxStore.getState().updateClientUI({ review_seen_at: Date.now() });
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!items || items.length === 0) return null;
  const unseen = countUnseenReviewItems(items, seenAt);
  const toggle = () => (open ? close() : setOpen(true));

  return (
    <div className="relative shrink-0 border-t border-sol-border/40">
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={close} aria-hidden />
          <div className="absolute bottom-full left-0 right-0 max-h-[55vh] overflow-y-auto bg-sol-bg border-t border-sol-border/60 shadow-[0_-8px_24px_rgba(0,0,0,0.18)] z-20">
            <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-sol-bg-alt/95 backdrop-blur-sm border-b border-sol-border/60 text-[10px]">
              <span className="font-medium text-sol-text-muted">
                {items.length} open · resolve at the source to clear
              </span>
            </div>
            {items.map((item) => (
              <ReviewRow key={item.key} item={item} onOpen={(i) => { close(); openReviewItem(i); }} />
            ))}
          </div>
        </>
      )}
      <button
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`Review: ${items.length} open`}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 bg-sol-bg hover:bg-sol-bg-alt/60 transition-colors"
      >
        <MessageSquare className={`w-3 h-3 shrink-0 ${unseen > 0 ? "text-sol-cyan" : "text-sol-cyan/60"}`} />
        <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wider text-sol-cyan">
          Review <span className="text-sol-cyan/60 tabular-nums">{items.length}</span>
        </span>
        {unseen > 0 && (
          <span className="ml-auto shrink-0 inline-flex items-center whitespace-nowrap px-1.5 py-0 rounded-full text-[9px] font-semibold bg-sol-cyan/15 text-sol-cyan border border-sol-cyan/30">
            {unseen} new
          </span>
        )}
      </button>
    </div>
  );
}

export const ReviewDock = memo(ReviewDockImpl);
