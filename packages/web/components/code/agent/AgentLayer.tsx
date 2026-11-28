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
import { openBeside, sessionPanePath } from "../../../lib/stage";
import { openConversationHere } from "../../../lib/code/blame/actions";
import { computeVaultAgentState, vaultAgentSig, vaultMachineOf } from "../../../lib/code/agent/live";
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
    useAgentStore.getState().restoreOverride(vaultId);
    let lastSig = "";
    let lastOverride: unknown = undefined;
    const recompute = (force: boolean) => {
      const s = useInboxStore.getState();
      const override = useAgentStore.getState().overrides[vaultId];
      const place = { root, machine: vaultMachineOf(vaultId, s) };
      const sig = vaultAgentSig(s, place);
      if (!force && sig === lastSig && override === lastOverride) return;
      lastSig = sig;
      lastOverride = override;
      const agent = useAgentStore.getState();
      const next = computeVaultAgentState(s, place, override, agent.links[vaultId]);
      agent.setLink(vaultId, next.link);
      agent.setPresence(vaultId, root, next.index, next.digest);
    };
    recompute(true);
    const offInbox = useInboxStore.subscribe((s, prev) => {
      if (s.sessions === prev.sessions && s.messages === prev.messages && s.tabs === prev.tabs && s.activeTabId === prev.activeTabId && s.currentSessionId === prev.currentSessionId && s.localDevice === prev.localDevice) return;
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

/** Open the linked session's composer beside the editor, where its queued
 *  quotes wait in the tray. A pane that opens takes focus into its composer;
 *  one already beside is focused and its composer focused after. Where the
 *  stage has no room the conversation opens in the main view. */
function openComposerBeside(sessionId: string): void {
  if (!openBeside(sessionPanePath(sessionId))) {
    openConversationHere(sessionId);
    return;
  }
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".stage-cell--focused [data-chat-input]")?.focus());
}

/** The status bar chip: the linked session, drawn dim while it is only the
 *  folder's latest (no pick, nothing beside), and how many quotes wait in its
 *  composer, which opens it. A press on the session opens the picker. */
const AgentChip = memo(function AgentChip({ vaultId, host, newSession }: { vaultId: string; host: HTMLElement; newSession?: () => boolean }) {
  const link = useAgentStore((s) => s.links[vaultId]);
  const id = link?.sessionId ?? null;
  const queued = useInboxStore((s) => (id ? (s.reviewComments[id]?.length ?? 0) : 0));
  const guessed = link?.source === "folder";
  const how = link?.source === "picked" ? "Picked" : link?.source === "beside" ? "Open beside" : "Latest in this folder";
  return (
    <span className="inline-flex items-center gap-0.5">
      <button
        type="button"
        data-agent-chip
        data-link-source={link?.source ?? "none"}
        title={id ? how : "Pick a session"}
        onClick={() => {
          const rect = host.getBoundingClientRect();
          useAgentStore.getState().openPicker({ vaultId, anchor: { left: rect.left, top: rect.top, bottom: rect.bottom }, newSession });
        }}
        className={`inline-flex max-w-[220px] items-center gap-1.5 rounded px-1 transition-colors hover:bg-sol-bg-alt hover:text-sol-text hover:opacity-100 ${guessed ? "text-sol-text-dim opacity-60" : "text-sol-text-muted"}`}
      >
        {id ? (
          <SessionMark id={id} />
        ) : (
          <>
            <Link2Off className="h-3 w-3 shrink-0" />
            <span>No session</span>
          </>
        )}
      </button>
      {id && queued > 0 && (
        <button
          type="button"
          data-agent-queued
          onClick={() => openComposerBeside(id)}
          className="shrink-0 rounded-sm bg-sol-cyan/15 px-1 tabular-nums leading-4 text-sol-cyan transition-colors hover:bg-sol-cyan/25"
          title={`${queued} quote${queued === 1 ? "" : "s"} in its composer`}
        >
          {queued}
        </button>
      )}
    </span>
  );
});

export const AgentLayer = memo(function AgentLayer({ vaultId, root }: { vaultId: string; root: string | null }) {
  useAgentLinking(vaultId, root);
  const chips = useAgentStore((s) => s.chips);
  const picker = useAgentStore((s) => (s.picker?.vaultId === vaultId ? s.picker : null));
  const inline = useAgentStore((s) => (s.inline?.vaultId === vaultId ? s.inline : null));
  return (
    <>
      {chips.filter((c) => c.vaultId === vaultId).map((c, i) => createPortal(<AgentChip vaultId={vaultId} host={c.el} newSession={c.newSession} />, c.el, `chip${i}`))}
      {inline?.host && createPortal(<InlineInstruction key={inline.id} request={inline} />, inline.host)}
      {picker && <SessionPicker request={picker} root={root} />}
    </>
  );
});

export default AgentLayer;
