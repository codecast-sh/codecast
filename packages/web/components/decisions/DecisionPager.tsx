"use client";

import { useMemo, useRef } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { DECISION_SET_PARAM, decisionSetHref, parseDecisionSet, setPosition, useDecisionListOrder } from "../../lib/decisions/decisionSet";
import { arrangeDecisions, decisionView } from "../../lib/decisions/decisionRows";
import { useDecisionRows } from "../../hooks/useDecisionRows";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useInboxStore } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useTabActive } from "../../hooks/usePagePresence";
import { hasOpenModal } from "../../shortcuts";
import { keyBelongsElsewhere } from "../../shortcuts/keyOwnership";
import { KeyCap } from "../KeyCap";
import { modernButton } from "../ui/modernLook";

type Source = "named" | "list" | "mine";
type Nav = { at: number; total: number; prev: string | null; next: string | null; go: (ref: string | null) => void };

const MINE_VIEW = decisionView({ tab: "mine" });
const noLabel = () => "";

/** The viewer's open queue in Mine's own order, unfiltered: what the Decisions row counts. */
function useMineOrder(): string[] {
  const rows = useDecisionRows();
  const me = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const now = useCoarseNow(60_000);
  return useMemo(() => arrangeDecisions(rows.mine, MINE_VIEW, { me, now, label: noLabel }).items.map((d) => d.short_id ?? d._id), [rows.mine, me, now]);
}

// Where a decision page sits among the decisions it flips through: the set
// the address names, else the Decisions list's order when it holds this
// decision, else the viewer's open queue. A decision answered off its set
// keeps its slot, so › lands on the one that slid into it.
export function useDecisionNav(ids: readonly (string | undefined)[]): Nav {
  const router = useRouter();
  const params = useSearchParams();
  const named = parseDecisionSet(params?.get(DECISION_SET_PARAM));
  const listOrder = useDecisionListOrder();
  const mineOrder = useMineOrder();
  const last = useRef<{ key: string; at: number; src: Source } | null>(null);
  const key = ids.filter(Boolean).join("|");
  const sets: Record<Source, readonly string[]> = { named, list: listOrder, mine: mineOrder };

  const src: Source = named.length > 1 ? "named"
    : setPosition(listOrder, ids) ? "list"
    : setPosition(mineOrder, ids) ? "mine"
    : last.current?.key === key ? last.current.src
    : "mine";
  const set = sets[src];
  let pos = setPosition(set, ids);
  if (pos) last.current = { key, at: pos.at, src };
  else {
    const at = last.current?.key === key ? Math.min(last.current.at, set.length) : 0;
    pos = { at: -1, prev: at > 0 ? set[at - 1] : null, next: at < set.length ? set[at] : null };
  }

  const go = (ref: string | null) => {
    if (ref) router.replace(src === "named" ? decisionSetHref(ref, named) : `/decisions/${ref}`);
  };
  return { at: pos.at, total: set.length, prev: pos.prev, next: pos.next, go };
}

/** ‹ 2 of 17 › and the arrow keys, always drawn on a decision page. */
export function DecisionPager({ nav, decided = false }: { nav: Nav; decided?: boolean }) {
  const { at, total, prev, next, go } = nav;
  const active = useTabActive();
  useWatchEffect(() => {
    if (!active || (!prev && !next)) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
      const to = e.key === "ArrowLeft" ? prev : e.key === "ArrowRight" ? next : null;
      if (!to) return;
      e.preventDefault();
      go(to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, prev, next, go]);

  const btn = "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sol-text-dim hover:text-sol-text hover:bg-sol-card disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-sol-text-dim";
  return (
    <span className="inline-flex items-center gap-1 text-meta" data-decision-pager={`${at + 1}/${total}`}>
      <button type="button" className={btn} disabled={!prev} onClick={() => go(prev)} aria-label="Previous decision" title="Previous decision">
        <ChevronLeft className="w-3.5 h-3.5" /><KeyCap size="xs">←</KeyCap>
      </button>
      <span className="tabular-nums text-sol-text-dim">{at >= 0 ? `${at + 1} of ${total}` : total > 0 ? `${total} left` : "none left"}</span>
      {decided && next ? (
        <button type="button" onClick={() => go(next)} aria-label="Next decision" data-decision-pager-next
          className="ml-1 inline-flex items-center gap-1.5 rounded-md border border-sol-cyan/50 bg-sol-cyan/15 px-2 py-0.5 text-sol-cyan hover:bg-sol-cyan/25 transition-colors">
          Next decision <KeyCap size="xs">→</KeyCap>
        </button>
      ) : (
        <button type="button" className={btn} disabled={!next} onClick={() => go(next)} aria-label="Next decision" title="Next decision">
          <KeyCap size="xs">→</KeyCap><ChevronRight className="w-3.5 h-3.5" />
        </button>
      )}
    </span>
  );
}

/** Under a decision just made: the next one, or the way back to the queue when none is left. */
export function DecisionNextBar({ nav }: { nav: Nav }) {
  const left = nav.at >= 0 ? nav.total - nav.at - 1 : nav.total;
  return (
    <div className="mt-6 flex items-center gap-3 rounded-xl border border-sol-border/70 bg-sol-card/50 px-4 py-3" data-decision-next={nav.next ?? ""}>
      <span className="text-[13px] text-sol-text-dim tabular-nums">{nav.next ? `${left} left` : "None left"}</span>
      {nav.next ? (
        <button type="button" onClick={() => nav.go(nav.next)}
          className={`ml-auto inline-flex items-center gap-2 rounded-md bg-sol-cyan/15 border border-sol-cyan/50 px-3 py-1.5 text-[13px] text-sol-cyan hover:bg-sol-cyan/25 transition-colors ${modernButton({ variant: "soft", tone: "cyan", size: "sm" })}`}>
          Next decision <ArrowRight className="w-3.5 h-3.5" /><KeyCap size="xs">→</KeyCap>
        </button>
      ) : (
        <Link href="/decisions" className="ml-auto text-[13px] text-sol-text-dim hover:text-sol-text no-underline">All decisions</Link>
      )}
    </div>
  );
}
