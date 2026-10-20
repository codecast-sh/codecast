"use client";
// One session on the map, drawn by how close the camera is (semantic zoom).
// Far: its title, sized to read across the room. Mid: what it is doing and
// what it touches (its state line, task, pull request, branch, model). Close:
// the session itself, a working panel: its live messages through the
// conversation view's own blocks, and the app's composer to answer it. The
// canvas is the stage: zoom in on a card to work in it, zoom out to see the
// fleet.
import { memo, useRef } from "react";
import { useRouter } from "next/navigation";
import { useStore, type Node, type NodeProps } from "@xyflow/react";
import { ArrowUpRight, GitBranch, GitPullRequest, MessageSquare, Users } from "lucide-react";
import { useInboxStore, type InboxSession } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { AgentTypeIcon } from "../AgentTypeIcon";
import { EntityIdPill } from "../EntityIdPill";
import { SessionInlineThread } from "../conversation/SessionInlineThread";
import { ORG_STATE_META } from "../org/orgMeta";
import { formatRelativeTime } from "../../lib/conversationFormat";
import { CARD, HAIRLINE, type MapSession } from "./sessionMapModel";
import "./sessionMap.css";

export type MapLevel = "far" | "mid" | "close";
/** Below `mid` a card is its title; from `close` up it is the working session. */
export const MAP_STOPS = { mid: 0.28, close: 0.7 } as const;
export const mapLevelOf = (zoom: number): MapLevel => (zoom < MAP_STOPS.mid ? "far" : zoom < MAP_STOPS.close ? "mid" : "close");
/** The level the camera is at; a card re-renders when it crosses a stop, never on a zoom tick. */
export function useMapLevel(): MapLevel {
  return useStore((s) => mapLevelOf(s.transform[2]));
}

export type CardData = { s: MapSession; dim: boolean };

/** Text that keeps one size on screen while the card shrinks under it, within the card's room. */
const screenSize = (px: number, max: number) => `clamp(${px}px, calc(${px}px / var(--mapz, 1)), ${max}px)`;

/** The fields the mid card shows from the row; a heartbeat changes none of them. */
const midSig = (r: InboxSession | undefined) =>
  r ? [r.active_task?.short_id, r.active_task?.status, r.pr_status?.number, r.pr_status?.state, r.git_branch, r.worktree_branch, r.model, r.message_count, r.thread_state_status].join("\u0001") : "";

function MidBody({ s }: { s: MapSession }) {
  useInboxStore((st) => midSig(st.sessions[s.id]));
  const r = useInboxStore.getState().sessions[s.id];
  const branch = r?.worktree_branch || r?.git_branch;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[0.6em] overflow-hidden" style={{ fontSize: screenSize(12, 30) }}>
      <p className="line-clamp-3 shrink-0 leading-snug" style={{ color: "var(--sol-text-muted)" }}>{s.line || ORG_STATE_META[s.state].label}</p>
      <div className="mt-auto flex flex-wrap items-center gap-x-[0.8em] gap-y-[0.4em]" style={{ color: "var(--sol-text-dim)" }}>
        {r?.active_task && <EntityIdPill shortId={r.active_task.short_id} compact />}
        {r?.pr_status && (
          <span className="inline-flex items-center gap-[0.3em]"><GitPullRequest className="h-[1em] w-[1em]" />#{r.pr_status.number} {r.pr_status.state}</span>
        )}
        {branch && <span className="inline-flex min-w-0 max-w-full items-center gap-[0.3em] truncate"><GitBranch className="h-[1em] w-[1em] shrink-0" /><span className="truncate">{branch}</span></span>}
        {!!r?.message_count && <span className="inline-flex items-center gap-[0.3em] tabular-nums"><MessageSquare className="h-[1em] w-[1em]" />{r.message_count}</span>}
        {s.workers > 0 && <span className="inline-flex items-center gap-[0.3em] tabular-nums"><Users className="h-[1em] w-[1em]" />{s.workers}</span>}
        {r?.model && <span className="truncate">{r.model}</span>}
      </div>
    </div>
  );
}

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/** The live session: messages scroll in the card, the composer stays at its foot. */
function Stage({ id }: { id: string }) {
  const row = useInboxStore((st) => st.sessions[id]);
  const scroller = useRef<HTMLDivElement>(null);
  // Follow the tail while the reader sits at the bottom, as the conversation view does.
  useWatchEffect(() => {
    const host = scroller.current;
    if (!host) return;
    let pinned = true;
    const list = () => host.querySelector<HTMLElement>(".th-session-rows");
    const toBottom = () => { const l = list(); if (l && pinned) l.scrollTop = l.scrollHeight; };
    const onScroll = (e: Event) => { const l = e.target as HTMLElement; pinned = l.scrollHeight - l.scrollTop - l.clientHeight < 24; };
    host.addEventListener("scroll", onScroll, true);
    const mo = new MutationObserver(toBottom);
    mo.observe(host, { childList: true, subtree: true });
    toBottom();
    return () => { host.removeEventListener("scroll", onScroll, true); mo.disconnect(); };
  }, []);
  if (!row) return null;
  return (
    // Clicks here belong to the session (reading, selecting text, the composer): they never select the card or move the camera.
    <div ref={scroller} className="map-stage nodrag nowheel nopan min-h-0 flex-1 cursor-auto" onClick={stop} onDoubleClick={stop}>
      <SessionInlineThread session={row} seen={false} maxRows={30} foot={false} />
    </div>
  );
}

export const CardNode = memo(function CardNode({ data, selected }: NodeProps<Node<CardData>>) {
  const { s, dim } = data;
  const level = useMapLevel();
  const router = useRouter();
  const color = ORG_STATE_META[s.state].color;
  return (
    <div
      className="relative flex flex-col overflow-hidden rounded-xl border transition-opacity"
      style={{
        width: CARD.w, height: CARD.h,
        background: "var(--sol-card)",
        borderColor: selected ? "var(--sol-blue)" : HAIRLINE,
        boxShadow: selected ? "0 0 0 2px color-mix(in srgb, var(--sol-blue) 35%, transparent)" : "0 1px 3px rgba(0,0,0,0.1)",
        opacity: dim ? 0.18 : 1,
      }}
      data-map-card={s.id}
      data-map-level={level}
    >
      <span aria-hidden className="absolute inset-x-0 top-0 h-[4px]" style={{ background: color }} />
      {level === "far" ? (
        <div className="flex h-full items-center px-5">
          <span className="line-clamp-3 font-semibold leading-[1.1]" style={{ fontSize: screenSize(13, 64), color: "var(--sol-text)" }}>{s.title}</span>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 items-start gap-[0.5em] px-3 pb-1.5 pt-2.5" style={{ fontSize: level === "mid" ? screenSize(13, 32) : 13, cursor: "grab" }}>
            <AgentTypeIcon agentType={s.agent_type} className="mt-[0.2em] h-[1em] w-[1em] shrink-0" />
            <span className="line-clamp-2 min-w-0 flex-1 font-semibold leading-tight" style={{ color: "var(--sol-text)" }} title={s.title}>{s.title}</span>
            <span className="shrink-0 tabular-nums" style={{ fontSize: "0.8em", color: "var(--sol-text-dim)" }} title={ORG_STATE_META[s.state].label}>
              <span className="mr-[0.4em] inline-block h-[0.6em] w-[0.6em] rounded-full" style={{ background: color }} />
              {s.updated_at ? formatRelativeTime(s.updated_at) : ""}
            </span>
            {level === "close" && (
              <button type="button" className="nodrag -mr-1 shrink-0 rounded p-0.5 hover:bg-sol-bg-highlight" onClick={() => router.push(`/conversation/${s.id}`)} aria-label="Open conversation" title="Open conversation">
                <ArrowUpRight className="h-3.5 w-3.5" style={{ color: "var(--sol-text-dim)" }} />
              </button>
            )}
          </div>
          {level === "mid" ? <div className="flex min-h-0 flex-1 flex-col px-3 pb-3"><MidBody s={s} /></div> : <Stage id={s.id} />}
        </>
      )}
    </div>
  );
});
