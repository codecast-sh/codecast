"use client";
// The two ways into the chart beside a conversation (org-staffing.md S36):
// "Chart" on a proposal card and a chip in the session header. Both open the
// one reused pane beside the stage, unfocused, so the conversation stays the
// primary. Kept apart from the pane itself so a message never pulls React
// Flow into its bundle.
import { useCallback, useMemo } from "react";
import { Network } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { openIn } from "../../lib/openIntent";
import { OrgButton } from "./OrgButton";
import { chartPointerOfText, newestChartPointer, orgChartPath, type ChartPointer, type ThreadPointer } from "./orgChartPointer";

type Msg = { _id: string; content?: string };
// A message is parsed once: the store hands back the same object until it
// changes, so a streaming thread re-reads only the message being written.
const parsed = new WeakMap<Msg, ChartPointer | null>();
const pointerOfMessage = (m: Msg): ChartPointer | null => {
  let p = parsed.get(m);
  if (p === undefined) { p = chartPointerOfText(m.content); parsed.set(m, p); }
  return p;
};
const threadPointer = (messages: readonly Msg[] | undefined): ThreadPointer | null => {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) if (pointerOfMessage(messages![i])) return newestChartPointer([messages![i]]);
  return null;
};

/** The newest chart pointer in a conversation's messages, from the store. */
export function useThreadChartPointer(conversationId: string | null | undefined): ThreadPointer | null {
  const key = useInboxStore((s) => (conversationId ? threadPointer(s.messages[conversationId])?.key ?? "" : ""));
  return useMemo(() => (conversationId ? threadPointer(useInboxStore.getState().messages[conversationId]) : null), [conversationId, key]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Open the chart beside what is on stage, following `session` (default: the conversation in view). */
export function openOrgChart(pointer: ChartPointer, session: string | null | undefined = useInboxStore.getState().currentSessionId): void {
  openIn("split", orgChartPath({ ...pointer, session }));
}

/** "Chart" on a proposal card: this proposal's ghosts, beside the conversation. */
export function ProposalChartButton({ proposal }: { proposal: { short_id: string } }) {
  const open = useCallback(() => openOrgChart({ proposal: proposal.short_id }), [proposal.short_id]);
  return (
    <OrgButton size="sm" onClick={open} aria-label="Show this proposal on the chart" title="Open the chart beside this conversation" data-open-chart={proposal.short_id}>
      <Network className="h-3 w-3" /> Chart
    </OrgButton>
  );
}

/** The session header's chip: there when the thread holds a proposal. */
export function OrgChartChip({ conversationId }: { conversationId: string }) {
  const pointer = useThreadChartPointer(conversationId);
  if (!pointer?.proposal) return null;
  return (
    <button
      type="button"
      onClick={() => openOrgChart(pointer, conversationId)}
      className="inline-flex flex-shrink-0 items-center gap-1 rounded border border-sol-violet/30 bg-sol-violet/10 px-1.5 py-px font-mono text-[10px] text-sol-violet transition-colors hover:bg-sol-violet/20"
      title={`Open the org chart beside this conversation, on ${pointer.proposal}`}
      data-org-chart-chip={pointer.proposal}
    >
      <Network className="h-3 w-3 flex-shrink-0" />
      <span>chart</span>
      <span className="opacity-70">{pointer.proposal}</span>
    </button>
  );
}
