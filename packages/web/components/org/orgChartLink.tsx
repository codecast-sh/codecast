"use client";
// The ways onto the Org screen from a conversation (org-staffing.md S36): the
// chart chip in a session header and "Map" on a proposal card. Both open the
// screen beside the stage, unfocused, with the proposal in its panel, so the
// conversation stays the primary. Kept apart from the screen itself so a
// message never pulls the screen into its bundle.
import { useMemo } from "react";
import { Network } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { openIn } from "../../lib/openIntent";
import { chartPointerOfText, newestChartPointer, type ChartPointer, type ThreadPointer } from "./orgChartPointer";

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

/** The Org screen's address for a pointer: `/org?proposal=op-N`, its change lit when the focus is one. */
export function orgChartPath(pointer: ChartPointer): string {
  if (!pointer.proposal) return "/org";
  const q = new URLSearchParams({ proposal: pointer.proposal.toLowerCase() });
  if (pointer.focus && /^\d+$/.test(pointer.focus)) q.set("focus", String(Number(pointer.focus)));
  return `/org?${q}`;
}

/** Open the Org screen beside what is on stage, with the proposal in its panel. */
export function openOrgChart(pointer: ChartPointer): void {
  openIn("split", orgChartPath(pointer));
}

/** The session header's chip: there when the thread holds a proposal. */
export function OrgChartChip({ conversationId }: { conversationId: string }) {
  const pointer = useThreadChartPointer(conversationId);
  if (!pointer?.proposal) return null;
  return (
    <button
      type="button"
      onClick={() => openOrgChart(pointer)}
      className="inline-flex flex-shrink-0 items-center gap-1 rounded border border-sol-violet/30 bg-sol-violet/10 px-1.5 py-px font-mono text-[10px] text-sol-violet transition-colors hover:bg-sol-violet/20"
      title={`Open ${pointer.proposal} in the org beside this conversation`}
      data-org-chart-chip={pointer.proposal}
    >
      <Network className="h-3 w-3 flex-shrink-0" />
      <span>chart</span>
      <span className="opacity-70">{pointer.proposal}</span>
    </button>
  );
}
