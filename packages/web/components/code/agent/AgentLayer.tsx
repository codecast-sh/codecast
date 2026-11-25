// The agent integration's React side, mounted once by the code workspace:
//
//   - keeps the folder's linked session and live edit presence current in
//     agentStore, from the inbox store through a wake signature (a heartbeat
//     that moves none of the watched fields does no work),
//   - draws the status bar chip into each editor's chip host,
//   - draws the session picker and the inline instruction.
//
// Nothing here loads CodeMirror: the editor chunk registers its half
// (lib/code/agent/feature.ts) and the two meet in agentStore.

import { memo } from "react";
import { createPortal } from "react-dom";
import { Link2Off } from "lucide-react";
import { useInboxStore } from "../../../store/inboxStore";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useAgentStore } from "../../../lib/code/agent/agentStore";
import { computeVaultAgentState, vaultAgentSig } from "../../../lib/code/agent/live";
import { InlineInstruction } from "./InlineInstruction";
import { SessionMark } from "./SessionMark";
import { SessionPicker } from "./SessionPicker";

/** Ranking by recency and freshness of edit evidence are time-driven, not field
 *  changes: recompute on this clock as well. */
const COARSE_MS = 15_000;

function useAgentLinking(vaultId: string, root: string | null): void {
  useWatchEffect(() => {
    if (!root) {
      useAgentStore.getState().setLink(vaultId, { sessionId: null, source: "none" });
      return;
    }
    let lastSig = "";
    let lastOverride: unknown = undefined;
    const recompute = (force: boolean) => {
      const s = useInboxStore.getState();
      const override = useAgentStore.getState().overrides[vaultId];
      const sig = vaultAgentSig(s, root);
      if (!force && sig === lastSig && override === lastOverride) return;
      lastSig = sig;
      lastOverride = override;
      const next = computeVaultAgentState(s, root, override);
      const agent = useAgentStore.getState();
      agent.setLink(vaultId, next.link);
      agent.setPresence(vaultId, root, next.index, next.digest);
    };
    recompute(true);
    const offInbox = useInboxStore.subscribe((s, prev) => {
      if (s.sessions === prev.sessions && s.messages === prev.messages && s.tabs === prev.tabs && s.activeTabId === prev.activeTabId && s.currentSessionId === prev.currentSessionId) return;
      recompute(false);
    });
    const offAgent = useAgentStore.subscribe((s, prev) => {
      if (s.overrides[vaultId] !== prev.overrides[vaultId]) recompute(false);
    });
    const timer = setInterval(() => recompute(true), COARSE_MS);
    return () => {
      offInbox();
      offAgent();
      clearInterval(timer);
    };
  }, [vaultId, root]);
}

/** The status bar chip: the linked session, and how many quotes wait in its
 *  composer. A press opens the picker. */
const AgentChip = memo(function AgentChip({ vaultId, host }: { vaultId: string; host: HTMLElement }) {
  const link = useAgentStore((s) => s.links[vaultId]);
  const id = link?.sessionId ?? null;
  const queued = useInboxStore((s) => (id ? (s.reviewComments[id]?.length ?? 0) : 0));
  const how = link?.source === "picked" ? "picked" : link?.source === "beside" ? "open beside" : "latest in this folder";
  return (
    <button
      type="button"
      data-agent-chip
      title={id ? `Linked session (${how}). Click to change` : "No linked session. Click to pick one"}
      onClick={() => {
        const rect = host.getBoundingClientRect();
        useAgentStore.getState().openPicker({ vaultId, anchor: { left: rect.left, top: rect.top, bottom: rect.bottom } });
      }}
      className="inline-flex max-w-[220px] items-center gap-1.5 rounded px-1 text-sol-text-dim transition-colors hover:bg-sol-bg-alt hover:text-sol-text"
    >
      {id ? (
        <SessionMark id={id} />
      ) : (
        <>
          <Link2Off className="h-3 w-3 shrink-0" />
          <span>No session</span>
        </>
      )}
      {queued > 0 && (
        <span className="shrink-0 rounded-sm bg-sol-cyan/15 px-1 tabular-nums leading-4 text-sol-cyan" title={`${queued} quote${queued === 1 ? "" : "s"} waiting in its composer`}>
          {queued}
        </span>
      )}
    </button>
  );
});

export const AgentLayer = memo(function AgentLayer({ vaultId, root }: { vaultId: string; root: string | null }) {
  useAgentLinking(vaultId, root);
  const chips = useAgentStore((s) => s.chips);
  const picker = useAgentStore((s) => (s.picker?.vaultId === vaultId ? s.picker : null));
  const inline = useAgentStore((s) => (s.inline?.vaultId === vaultId ? s.inline : null));
  return (
    <>
      {chips.filter((c) => c.vaultId === vaultId).map((c, i) => createPortal(<AgentChip vaultId={vaultId} host={c.el} />, c.el, `chip${i}`))}
      {inline?.host && createPortal(<InlineInstruction key={inline.id} request={inline} />, inline.host)}
      {picker && <SessionPicker request={picker} root={root} />}
    </>
  );
});

export default AgentLayer;
