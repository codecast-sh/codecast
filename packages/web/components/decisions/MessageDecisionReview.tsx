"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { Layers } from "lucide-react";
import { useInboxStore, type DecisionDetailItem, type SessionDecisionItem } from "../../store/inboxStore";
import { askedOfViewer } from "../../lib/decisionQueue";
import { latestDecisionNamers, messageDecisionRefs } from "../../lib/messageDecisionRefs";
import { decisionSetHref } from "../../lib/decisions/decisionSet";
import { useSyncDecisionDetail } from "../../hooks/useSyncDecisionDetail";
import { Button } from "../ui/button";

// A message that names several decisions gets one bar under it: how many are
// open and how many of those wait on the viewer, and a button that opens them
// as full decision pages, flipped with ‹ › in the order the message names
// them. Every named decision counts, whoever it is asked of. A decision the
// conversation names again later belongs to that later message.
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

function Review({ refs }: { refs: string[] }) {
  const router = useRouter();
  const meId = useInboxStore((s) => s.currentUser?._id as string | undefined);
  // Re-render on the named rows' presence, status and who they wait on only.
  const sig = useInboxStore((s) =>
    refs.map((r) => {
      const d = rowOf(s, r);
      return d ? `${queueRow(s, r) ? "q" : "d"}:${d.status}:${askedOfViewer(d, meId) ? 1 : 0}` : "-";
    }).join("|"),
  );
  const parts = sig.split("|");
  // A decision outside the viewer's queue (asked of a teammate, or answered) loads its page row.
  const feeds = refs.filter((_, i) => !parts[i].startsWith("q:"));
  const known = refs.filter((_, i) => parts[i] !== "-");
  const open = known.filter((r) => parts[refs.indexOf(r)].includes(":pending:"));
  const mine = open.filter((r) => parts[refs.indexOf(r)].endsWith(":1"));

  const feeders = feeds.map((r) => <DetailFeed key={r} id={r} />);
  if (known.length < REVIEW_MIN || open.length === 0) return <>{feeders}</>;
  const start = mine[0] ?? open[0];
  const answered = known.length - open.length;
  return (
    <>
      {feeders}
      <div data-message-decision-review={open.length} className="not-prose mt-3 flex items-center gap-3 rounded-lg border border-dashed border-sol-yellow/60 bg-sol-yellow/[0.07] px-3 py-2 text-[13px]">
        <Layers className="w-4 h-4 text-sol-yellow shrink-0" />
        <span className="font-semibold text-sol-yellow">{open.length} open decision{open.length === 1 ? "" : "s"}</span>
        {mine.length < open.length && <span className="text-sol-text-dim">{mine.length} asked of you</span>}
        {answered > 0 && <span className="text-sol-text-dim">{answered} answered</span>}
        <Button variant="yellow" size="xs" onClick={() => router.push(decisionSetHref(start, known))} className="ml-auto">
          Go through them
        </Button>
      </div>
    </>
  );
}
