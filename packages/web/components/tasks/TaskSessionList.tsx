"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Columns2, Pin } from "lucide-react";
import { AgentTypeIcon, formatAgentType } from "../AgentTypeIcon";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { LivenessDot } from "../LivenessDot";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { openConversationBeside } from "../../hooks/useOpenLinkedSession";
import { cleanTitle } from "../../lib/conversationProcessor";
import { cleanUserMessage } from "../sessionMessage";
import { getLabelColor } from "../../lib/labelColors";
import { sessionLiveAt } from "../../lib/liveness";
import {
  sortTaskLinkedConversations,
  taskSessionHref,
} from "../../lib/liveEntities";
import { sessionPanePath, startPaneDrag } from "../../lib/stage";
import { compactAge, threadStateView, THREAD_STATE_PIN_CLASS, THREAD_STATE_STATUS_META } from "../../lib/threadState";
import { getProjectName, useInboxStore } from "../../store/inboxStore";
import { LivePulseDot } from "../SessionActivityLine";

export type TaskLinkedSession = {
  _id: string;
  session_id?: string;
  title?: string;
  headline?: string;
  project_path?: string;
  git_root?: string;
  git_branch?: string;
  message_count?: number;
  is_active?: boolean;
  started_at?: number;
  updated_at?: number;
  agent_type?: string;
  agent_status?: string | null;
  last_user_message?: string;
  thread_state?: string;
  thread_state_status?: string;
  thread_state_at?: number;
  thread_state_message_count?: number;
  is_idle?: boolean;
  last_heartbeat?: number | null;
  producing_until?: number | null;
  daemon_alive_until?: number | null;
  agent_status_updated_at?: number | null;
};

function rowIsLive(conv: TaskLinkedSession, now: number): boolean {
  // Heartbeat facts come from the store; the detail snapshot only has is_active.
  if (conv.last_heartbeat != null || conv.producing_until != null || conv.daemon_alive_until != null) {
    return sessionLiveAt(conv, now);
  }
  return !!conv.is_active;
}

function liveRowSig(row: any | undefined): string {
  if (!row) return "";
  return [
    row.title, row.subtitle, row.headline, row.is_idle, row.updated_at, row.message_count,
    row.agent_type, row.agent_status, row.git_branch, row.git_root, row.project_path,
    row.thread_state, row.thread_state_status, row.thread_state_at, row.last_user_message,
  ].join("\u0001");
}

function overlayLive(snapshot: TaskLinkedSession, live: any | undefined): TaskLinkedSession {
  if (!live) return snapshot;
  return {
    ...snapshot,
    ...live,
    _id: snapshot._id,
    is_active: live.is_idle === false,
  };
}

function TaskSessionRow({
  snapshot,
  origin,
  onOpen,
  now,
}: {
  snapshot: TaskLinkedSession;
  origin: boolean;
  onOpen: (conv: TaskLinkedSession) => void;
  now: number;
}) {
  const liveSig = useInboxStore((s) => liveRowSig(s.sessions[snapshot._id]));
  const conv = useMemo(
    () => overlayLive(snapshot, useInboxStore.getState().sessions[snapshot._id]),
    // liveSig stands in for the churny sessions ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, liveSig],
  );
  const href = taskSessionHref(conv);
  if (!href) return null;

  const live = rowIsLive(conv, now);
  const stateView = threadStateView(conv as any, conv.message_count ?? 0, now);
  const named = (conv.title || conv.headline || "").trim();
  const title = cleanTitle(named || stateView?.headline || "Untitled");
  const project = getProjectName(conv.git_root, conv.project_path);
  const msgs = conv.message_count ?? 0;
  const age = conv.updated_at ? compactAge(now - conv.updated_at) : null;
  const line = stateView?.cardLine && stateView.cardLine !== title
    ? stateView.cardLine
    : (!stateView ? (cleanUserMessage(conv.last_user_message) || "") : "");
  const branch = conv.git_branch && conv.git_branch !== "main" && conv.git_branch !== "master" ? conv.git_branch : null;

  return (
    <div
      data-session-id={conv._id}
      draggable
      onDragStart={(e) => startPaneDrag(e, { path: sessionPanePath(conv._id), title })}
      className={`group relative rounded-md transition-colors hover:bg-sol-bg-alt/70 ${
        live
          ? "border-l-2 border-l-sol-green/50 bg-sol-green/[0.03]"
          : origin
            ? "border-l-2 border-l-sol-violet/40"
            : "border-l-2 border-l-transparent"
      }`}
    >
      <Link
        href={href}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.button === 1) return;
          e.preventDefault();
          onOpen(conv);
        }}
        className="flex items-start gap-2 px-2 py-1.5 pr-7"
      >
        <span className="flex-shrink-0 mt-0.5" title={formatAgentType(conv.agent_type)}>
          <AgentTypeIcon agentType={conv.agent_type || "claude_code"} className="w-3.5 h-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={`truncate text-xs leading-tight ${live ? "text-sol-text font-medium" : "text-sol-text"}`}>
              {title}
            </span>
            {origin && (
              <span className="flex-shrink-0 text-[9px] font-medium px-1 py-px rounded bg-sol-violet/10 text-sol-violet border border-sol-violet/25">
                from
              </span>
            )}
            {live && (
              <span className="flex items-center gap-1 flex-shrink-0">
                <LivenessDot state="active" size="xs" />
                <span className="text-[8px] font-medium uppercase tracking-wider text-sol-green/70">live</span>
              </span>
            )}
          </div>
          {stateView && ((stateView.status && stateView.status !== "working") || line) ? (
            <div className="mt-0.5 flex items-start gap-1 min-w-0" title={stateView.text}>
              <Pin
                className={`w-2 h-2 mt-[3px] shrink-0 ${stateView.status ? THREAD_STATE_STATUS_META[stateView.status].dot : THREAD_STATE_PIN_CLASS[stateView.freshness]}`}
                strokeWidth={2.4}
              />
              {stateView.status && stateView.status !== "working" && (
                <span className={`shrink-0 mt-px px-1 py-0 rounded border text-[9px] font-semibold uppercase tracking-wide ${THREAD_STATE_STATUS_META[stateView.status].chip}`}>
                  {THREAD_STATE_STATUS_META[stateView.status].label}
                </span>
              )}
              {line ? <span className="text-[11px] text-sol-text-secondary truncate leading-snug">{line}</span> : null}
            </div>
          ) : line ? (
            <p className="mt-0.5 text-[11px] text-sol-text-muted truncate leading-snug">{line}</p>
          ) : null}
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-sol-text-dim/70 min-w-0">
            {project !== "unknown" && (
              <span className={`flex items-center gap-1 min-w-0 font-medium ${getLabelColor(project).text}`}>
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${getLabelColor(project).dot}`} />
                <span className="truncate">{project}</span>
              </span>
            )}
            {msgs > 0 && <span className="tabular-nums flex-shrink-0">{msgs} msg{msgs === 1 ? "" : "s"}</span>}
            {branch && <span className="font-mono truncate max-w-[7rem]">{branch}</span>}
            {age && <span className="tabular-nums flex-shrink-0 ml-auto">{age}</span>}
          </div>
        </div>
      </Link>
      <ShortcutTooltip label="Open beside">
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openConversationBeside(conv._id);
          }}
          className="absolute right-1.5 top-1.5 z-10 p-0.5 rounded text-sol-text-dim opacity-0 group-hover:opacity-100 hover:text-sol-cyan hover:bg-sol-bg-alt transition-opacity"
          aria-label="Open beside"
        >
          <Columns2 className="w-3 h-3" />
        </button>
      </ShortcutTooltip>
    </div>
  );
}

export function TaskSessionList({
  sessions,
  originId,
  onOpen,
}: {
  sessions: TaskLinkedSession[];
  originId?: string | null;
  onOpen: (conv: TaskLinkedSession) => void;
}) {
  const now = useCoarseNow(30_000);
  const liveSig = useInboxStore((s) => sessions.map((c) => `${c._id}:${liveRowSig(s.sessions[c._id])}`).join("|"));
  const rows = useMemo(() => {
    // The task's conversation ids and its comment trail can name one session
    // twice; one row per id keeps React keys unique.
    const seen = new Set<string>();
    const unique = sessions.filter((c) => (seen.has(String(c._id)) ? false : (seen.add(String(c._id)), true)));
    const overlaid = unique.map((c) => overlayLive(c, useInboxStore.getState().sessions[c._id]));
    return sortTaskLinkedConversations(overlaid, originId);
    // liveSig stands in for the churny sessions ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, originId, liveSig]);
  const liveCount = rows.filter((c) => rowIsLive(c, now)).length;

  if (rows.length === 0) return null;

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-1.5">
        <div className="text-xs font-medium text-sol-text-dim">Sessions</div>
        <span className="text-[11px] font-mono text-sol-text-muted">{rows.length}</span>
        {liveCount > 0 && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-sol-green/15 text-sol-green text-[10px]">
            <LivePulseDot className="w-1.5 h-1.5" />
            {liveCount} live
          </span>
        )}
      </div>
      <div className="space-y-0.5 -mx-1">
        {rows.map((conv) => (
          <TaskSessionRow
            key={conv._id}
            snapshot={conv}
            origin={!!originId && conv._id === originId}
            onOpen={onOpen}
            now={now}
          />
        ))}
      </div>
    </div>
  );
}
