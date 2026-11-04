"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronLeft, Layers, X } from "lucide-react";
import { decisionAnswerLabel } from "@codecast/shared/contracts";
import { useInboxStore, type SessionDecisionItem } from "../../store/inboxStore";
import { askedOfViewer } from "../../lib/decisionQueue";
import { decisionHref } from "../../lib/decisionLinks";
import { latestDecisionNamers, messageDecisionRefs } from "../../lib/messageDecisionRefs";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useTabActive } from "../../hooks/usePagePresence";
import { hasOpenModal } from "../../shortcuts";
import { keyBelongsElsewhere } from "../../shortcuts/keyOwnership";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { DecisionCompactCard } from "./DecisionCompactCard";

// A message that names several open decisions gets one review under it: a
// bar with the count, which opens a run through them one card at a time in
// the order the message names them. Each card is the queue's compact card,
// so every answer kind works and answering is the same store action. A
// decision the conversation names again later belongs to that later message.
const REVIEW_MIN = 2;

// sessionDecisions is keyed by Convex id; a message names short ids. One
// index per collection ref, shared by every message on screen.
const byShortId = new WeakMap<object, Map<string, SessionDecisionItem>>();
function shortIdIndex(rows: Record<string, SessionDecisionItem>): Map<string, SessionDecisionItem> {
  let idx = byShortId.get(rows);
  if (!idx) {
    idx = new Map();
    for (const d of Object.values(rows)) if (d.short_id) idx.set(d.short_id.toLowerCase(), d);
    byShortId.set(rows, idx);
  }
  return idx;
}

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

function Review({ refs }: { refs: string[] }) {
  const meId = useInboxStore((s) => s.currentUser?._id as string | undefined);
  // Re-render on the named rows' identity and status only.
  const sig = useInboxStore((s) => {
    const idx = shortIdIndex(s.sessionDecisions);
    return refs.map((r) => { const d = idx.get(r); return d ? `${d._id}:${d.status}` : "-"; }).join("|");
  });
  // A row the queue drops after it is answered still belongs to this run:
  // keep the last row seen for each id so the summary can say how it went.
  const seen = useRef(new Map<string, SessionDecisionItem>());
  const members = useMemo(() => {
    const idx = shortIdIndex(useInboxStore.getState().sessionDecisions);
    const out: SessionDecisionItem[] = [];
    for (const r of refs) {
      const d = idx.get(r) ?? seen.current.get(r);
      if (!d || !askedOfViewer(d, meId)) continue;
      seen.current.set(r, d);
      out.push(d);
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs, sig, meId]);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(0);
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
  const pending = (d: SessionDecisionItem) => d.status === "pending";
  const waiting = members.filter(pending).length;
  const current = useMemo(() => {
    for (let i = pos; i < members.length; i++) if (pending(members[i]) && !skipped.has(members[i]._id)) return i;
    return -1;
  }, [members, pos, skipped]);

  const start = useCallback(() => { setSkipped(new Set()); setPos(0); setOpen(true); }, []);
  const skip = useCallback(() => {
    if (current < 0) return;
    setSkipped((s) => new Set(s).add(members[current]._id));
    setPos(current + 1);
  }, [current, members]);
  const revisit = useCallback((i: number) => {
    setSkipped((s) => { const n = new Set(s); n.delete(members[i]._id); return n; });
    setPos(i);
  }, [members]);
  const back = useCallback(() => {
    const from = current < 0 ? members.length : current;
    for (let i = from - 1; i >= 0; i--) if (pending(members[i])) return revisit(i);
  }, [current, members, revisit]);

  const paneActive = useTabActive();
  useWatchEffect(() => {
    if (!open || !paneActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
      if (e.key === "s" && current >= 0) { e.preventDefault(); skip(); }
      else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, paneActive, current, skip]);

  if (members.length < REVIEW_MIN || (!open && waiting === 0)) return null;

  if (!open) {
    const answered = members.length - waiting;
    return (
      <div data-message-decision-review="closed" className="not-prose mt-3 flex items-center gap-3 rounded-lg border border-dashed border-sol-yellow/60 bg-sol-yellow/[0.07] px-3 py-2 text-[13px]">
        <Layers className="w-4 h-4 text-sol-yellow shrink-0" />
        <span className="font-semibold text-sol-yellow">{waiting} decision{waiting === 1 ? "" : "s"}</span>
        {answered > 0 && <span className="text-sol-text-dim">{answered} answered</span>}
        <button onClick={start} className="ml-auto rounded-md bg-sol-yellow px-3 py-1 text-[12px] font-semibold text-sol-bg hover:brightness-95">
          Review
        </button>
      </div>
    );
  }

  return (
    <div data-message-decision-review="open" className="not-prose mt-3 rounded-xl border border-sol-border bg-sol-bg-alt/40 overflow-hidden">
      <div className="flex gap-1 px-4 pt-3" aria-hidden>
        {members.map((d, i) => (
          <i key={d._id} className={`h-1 flex-1 rounded-full ${i === current ? "bg-sol-yellow" : !pending(d) ? "bg-sol-green/80" : skipped.has(d._id) ? "bg-sol-text-dim/50" : "bg-sol-border"}`} />
        ))}
      </div>
      <div className="flex items-center gap-3 px-4 pt-2 text-[11.5px] text-sol-text-dim">
        <span>{current >= 0 ? `${current + 1} of ${members.length}` : `${members.length - waiting} of ${members.length} answered`}</span>
        <span className="ml-auto flex items-center gap-1">
          {current >= 0 && (
            <>
              <button onClick={back} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-sol-card hover:text-sol-text"><ChevronLeft className="w-3 h-3" />Back</button>
              <button onClick={skip} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-sol-card hover:text-sol-text">Skip<KeyCap size="xs">s</KeyCap></button>
            </>
          )}
          <button onClick={() => setOpen(false)} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-sol-card hover:text-sol-text" title="Close">
            <X className="w-3 h-3" /><KeyCap size="xs">esc</KeyCap>
          </button>
        </span>
      </div>
      <div className="p-3">
        {current >= 0 ? (
          <DecisionCompactCard key={members[current]._id} decision={members[current]} keys={paneActive} showTask />
        ) : (
          <ol className="space-y-1">
            {members.map((d, i) => (
              <li key={d._id} className="flex items-center gap-2 rounded px-2 py-1.5 text-[13px]">
                {pending(d) ? <span className="w-3.5 h-3.5 shrink-0 rounded-full border border-sol-yellow" /> : <Check className="w-3.5 h-3.5 shrink-0 text-sol-green" />}
                <Link href={decisionHref(d)} className="min-w-0 flex-1 truncate text-sol-text-muted hover:text-sol-text">{d.question}</Link>
                {pending(d) ? (
                  <button onClick={() => revisit(i)} className="shrink-0 rounded border border-sol-yellow/60 px-2 py-0.5 text-[11.5px] text-sol-yellow hover:bg-sol-yellow/10">Answer</button>
                ) : (
                  <span className="shrink-0 max-w-[14rem] truncate text-[12px] text-sol-green">{d.status === "answered" ? decisionAnswerLabel(d, d) : d.status}</span>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
