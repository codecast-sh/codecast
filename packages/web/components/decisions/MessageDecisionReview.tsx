"use client";

import { useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Layers, X } from "lucide-react";
import { useInboxStore, type DecisionDetailItem, type SessionDecisionItem } from "../../store/inboxStore";
import { heldByViewer } from "../../lib/decisionQueue";
import { latestDecisionNamers, messageDecisionRefs } from "../../lib/messageDecisionRefs";
import { useSyncDecisionDetail } from "../../hooks/useSyncDecisionDetail";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useTabActive } from "../../hooks/usePagePresence";
import { hasOpenModal } from "../../shortcuts";
import { keyBelongsElsewhere } from "../../shortcuts/keyOwnership";
import { KeyCap } from "../KeyCap";
import { Button } from "../ui/button";
import { DecisionCompactCard } from "./DecisionCompactCard";

// A message that names several decisions gets one bar under it: how many are
// open and how many of those wait on the viewer, and a button that walks
// through them right there under the message, one card at a time, in the
// order the message names them, without leaving the conversation. Every named
// decision counts, whoever it is asked of. A decision the conversation names
// again later belongs to that later message.
const REVIEW_MIN = 2;

// Both homes a decision row lives in are keyed by Convex id; a message names short ids.
const queueIndex = new WeakMap<object, Map<string, SessionDecisionItem>>();
const detailIndex = new WeakMap<object, Map<string, SessionDecisionItem>>();
function byShortId<T>(cache: WeakMap<object, Map<string, SessionDecisionItem>>, rows: Record<string, T>, row: (r: T) => SessionDecisionItem | undefined): Map<string, SessionDecisionItem> {
  let idx = cache.get(rows);
  if (!idx) {
    idx = new Map();
    for (const r of Object.values(rows)) {
      const d = row(r);
      if (d?.short_id) idx.set(d.short_id.toLowerCase(), d);
    }
    cache.set(rows, idx);
  }
  return idx;
}
type State = ReturnType<typeof useInboxStore.getState>;
const queueRow = (s: State, ref: string) => byShortId(queueIndex, s.sessionDecisions, (d) => d).get(ref);
const detailRow = (s: State, ref: string) => byShortId(detailIndex, s.decisionDetails as Record<string, DecisionDetailItem>, (d) => d?.decision).get(ref);
const rowOf = (s: State, ref: string) => queueRow(s, ref) ?? detailRow(s, ref);

export function MessageDecisionReview({ content, conversationId, messageId }: { content: string; conversationId?: string; messageId: string }) {
  const named = useMemo(() => messageDecisionRefs(content), [content]);
  if (named.length < REVIEW_MIN) return null;
  return <OwnedRefs named={named} conversationId={conversationId} messageId={messageId} />;
}

function OwnedRefs({ named, conversationId, messageId }: { named: string[]; conversationId?: string; messageId: string }) {
  const owned = useInboxStore((s) => {
    const messages = conversationId ? s.messages[conversationId] : undefined;
    if (!messages) return named.join(",");
    const latest = latestDecisionNamers(messages);
    return named.filter((r) => (latest.get(r) ?? messageId) === messageId).join(",");
  });
  const refs = useMemo(() => (owned ? owned.split(",") : []), [owned]);
  if (refs.length < REVIEW_MIN) return null;
  return <Review refs={refs} />;
}

function DetailFeed({ id }: { id: string }) {
  useSyncDecisionDetail(id);
  return null;
}

// One review owns the arrow keys and Esc at a time: the one opened last.
let keyOwner: object | null = null;

function Review({ refs }: { refs: string[] }) {
  const meId = useInboxStore((s) => s.currentUser?._id as string | undefined);
  // Re-render on the named rows' presence, status and who they wait on only.
  const sig = useInboxStore((s) =>
    refs.map((r) => {
      const d = rowOf(s, r);
      return d ? `${queueRow(s, r) ? "q" : "d"}:${d.status}:${heldByViewer(d, meId) ? 1 : 0}` : "-";
    }).join("|"),
  );
  const parts = sig.split("|");
  // A decision outside the viewer's queue (asked of a teammate, or answered) loads its page row.
  const feeds = refs.filter((_, i) => !parts[i].startsWith("q:"));
  const known = refs.filter((_, i) => parts[i] !== "-");
  const isOpen = (r: string) => parts[refs.indexOf(r)].includes(":pending:");
  const open = known.filter(isOpen);
  const mine = open.filter((r) => parts[refs.indexOf(r)].endsWith(":1"));

  const [at, setAt] = useState<string | null>(null);
  const feeders = feeds.map((r) => <DetailFeed key={r} id={r} />);
  if (known.length < REVIEW_MIN || (open.length === 0 && !at)) return <>{feeders}</>;
  const answered = known.length - open.length;
  return (
    <>
      {feeders}
      {at ? (
        <Walk refs={known} at={known.includes(at) ? at : known[0]} isOpen={isOpen} meId={meId} onMove={setAt} onClose={() => setAt(null)} />
      ) : (
        <div data-message-decision-review={open.length} className="not-prose mt-3 flex items-center gap-3 rounded-lg border border-dashed border-sol-yellow/60 bg-sol-yellow/[0.07] px-3 py-2 text-[13px]">
          <Layers className="w-4 h-4 text-sol-yellow shrink-0" />
          <span className="font-semibold text-sol-yellow">{open.length} open decision{open.length === 1 ? "" : "s"}</span>
          {mine.length < open.length && <span className="text-sol-text-dim">{mine.length} asked of you</span>}
          {answered > 0 && <span className="text-sol-text-dim">{answered} answered</span>}
          <Button variant="yellow" size="xs" onClick={() => setAt(mine[0] ?? open[0])} className="ml-auto">
            Go through them
          </Button>
        </div>
      )}
    </>
  );
}

// The message's decisions one at a time, in place under it, in the order the
// message names them. ‹ › (and the arrow keys) flip through all of them;
// answering one moves on to the next open one; Esc folds it back to the bar.
function Walk({ refs, at, isOpen, meId, onMove, onClose }: {
  refs: string[];
  at: string;
  isOpen: (r: string) => boolean;
  meId: string | undefined;
  onMove: (r: string) => void;
  onClose: () => void;
}) {
  const decision = useInboxStore((s) => rowOf(s, at));
  // Names the people it was asked of when the viewer is not one of them.
  const askedOf = useInboxStore((s) => {
    const d = rowOf(s, at);
    if (!d || heldByViewer(d, meId)) return undefined;
    const detail = (s.decisionDetails as Record<string, DecisionDetailItem>)[d._id];
    return detail?.asked_users?.map((u) => u.name).join(", ") || undefined;
  });
  const i = refs.indexOf(at);
  const prev = i > 0 ? refs[i - 1] : null;
  const next = i < refs.length - 1 ? refs[i + 1] : null;
  const allDone = refs.every((r) => !isOpen(r));

  // The one on screen settled: move to the next open one after it, else the first open one.
  // Flipping onto one already answered is not a settle, so the status is remembered per decision.
  const seen = useRef({ ref: at, open: isOpen(at) });
  const nowOpen = isOpen(at);
  useWatchEffect(() => {
    const settled = seen.current.ref === at && seen.current.open && !nowOpen;
    seen.current = { ref: at, open: nowOpen };
    if (!settled) return;
    const after = [...refs.slice(i + 1), ...refs.slice(0, i)].find(isOpen);
    if (after) onMove(after);
  }, [at, nowOpen]);

  const me = useRef({});
  useWatchEffect(() => {
    keyOwner = me.current;
    return () => { if (keyOwner === me.current) keyOwner = null; };
  }, []);
  const paneActive = useTabActive();
  useWatchEffect(() => {
    if (!paneActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (keyOwner !== me.current || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
      const to = e.key === "ArrowLeft" ? prev : e.key === "ArrowRight" ? next : null;
      if (to) { e.preventDefault(); onMove(to); }
      else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paneActive, prev, next]);

  const step = "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sol-text-dim hover:text-sol-text hover:bg-sol-card disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-sol-text-dim";
  return (
    <div data-message-decision-review="open" className="not-prose mt-3 rounded-xl border border-sol-yellow/40 bg-sol-bg-alt/40">
      <div className="flex items-center gap-3 px-3 pt-2.5 text-meta">
        <div className="flex flex-1 gap-1" role="tablist" aria-label="Decisions in this message">
          {refs.map((r) => (
            <button
              key={r}
              type="button"
              role="tab"
              aria-selected={r === at}
              aria-label={r}
              onClick={() => onMove(r)}
              className={`h-1.5 flex-1 rounded-full transition-colors ${r === at ? "bg-sol-yellow" : isOpen(r) ? "bg-sol-border hover:bg-sol-text-dim" : "bg-sol-green/70 hover:bg-sol-green"}`}
            />
          ))}
        </div>
        <span className="inline-flex items-center gap-1 shrink-0" data-decision-pager={`${i + 1}/${refs.length}`}>
          <button type="button" className={step} disabled={!prev} onClick={() => prev && onMove(prev)} aria-label="Previous decision" title="Previous decision">
            <ChevronLeft className="w-3.5 h-3.5" /><KeyCap size="xs">←</KeyCap>
          </button>
          <span className="tabular-nums text-sol-text-dim">{allDone ? "all answered" : `${i + 1} of ${refs.length}`}</span>
          <button type="button" className={step} disabled={!next} onClick={() => next && onMove(next)} aria-label="Next decision" title="Next decision">
            <KeyCap size="xs">→</KeyCap><ChevronRight className="w-3.5 h-3.5" />
          </button>
          <button type="button" className={step} onClick={onClose} aria-label="Close" title="Close">
            <X className="w-3.5 h-3.5" /><KeyCap size="xs">esc</KeyCap>
          </button>
        </span>
      </div>
      <div className="p-3">
        {decision ? <DecisionCompactCard key={decision._id} decision={decision} keys={paneActive && isOpen(at)} showTask askedOf={askedOf} /> : null}
      </div>
    </div>
  );
}
