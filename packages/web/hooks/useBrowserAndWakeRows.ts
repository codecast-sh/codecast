import { useRef, useMemo } from "react";
import type { ChatWakePrompt } from "../components/sessionMessage";
import { normalizeCastCategory, buildBrowserRowMap, sameBrowserRowMap, type BrowserRowInput, type BrowserRowState } from "../components/castCommand";
import { parseCastCommand } from "../components/conversation/classify";
import type { Message, ToolResult, UserMessageKind } from "../components/conversation/types";
import type { ConversationData } from "../components/conversation/types";

/**
 * Every `cast browser` row in a transcript, carried forward (buildBrowserRowMap).
 * A result can sit on a later message than its call; `results` indexes those,
 * and without it the messages are indexed here.
 */
export function browserRowMapOf(messages: readonly Pick<Message, "tool_calls" | "tool_results">[], results?: Record<string, ToolResult>): Record<string, BrowserRowState> {
  let byId = results;
  if (!byId) {
    byId = {};
    for (const msg of messages) for (const tr of msg.tool_results ?? []) byId[tr.tool_use_id] = tr;
  }
  const rows: BrowserRowInput[] = [];
  for (const msg of messages) {
    for (const tc of msg.tool_calls ?? []) {
      const cast = parseCastCommand(tc);
      if (!cast || normalizeCastCategory(cast.category) !== "browser") continue;
      const result = msg.tool_results?.find((tr) => tr.tool_use_id === tc.id) || byId[tc.id];
      rows.push({ toolCallId: tc.id, subcommand: cast.subcommand, args: cast.args, output: result?.content || "" });
    }
  }
  return buildBrowserRowMap(rows);
}

/** The page the browser was last on: what a watch pane offers to reopen when
 *  the session's tab is gone. Rows are in transcript order, so the last entry
 *  with a URL is the latest page. */
export function lastBrowserPageOf(map: Record<string, BrowserRowState>): BrowserRowState | null {
  let last: BrowserRowState | null = null;
  for (const row of Object.values(map)) if (row.url) last = row;
  return last;
}

export function useBrowserAndWakeRows({ conversation, globalToolResultMap, managedSession, userMsgKindMap }: {
  conversation: ConversationData | null | undefined;
  globalToolResultMap: Record<string, ToolResult>;
  managedSession: { agent_status: "working" | "idle" | "permission_blocked" | "compacting" | "thinking" | "connected" | "stopped" | "starting" | "resuming" | "waiting" | "dormant" | "done" | "hibernated" | undefined; permission_mode: string | null | undefined; session_id: string; is_connected: boolean | undefined; tmux_session: string | null | undefined; team_id: string | null | undefined; } | null;
  userMsgKindMap: Map<string, UserMessageKind>;
}) {
  const browserRowMapRef = useRef<Record<string, BrowserRowState>>({});
  const browserRowMap = useMemo(() => {
    const next = browserRowMapOf(conversation?.messages ?? [], globalToolResultMap);
    if (!sameBrowserRowMap(browserRowMapRef.current, next)) browserRowMapRef.current = next;
    return browserRowMapRef.current;
  }, [conversation?.messages, globalToolResultMap]);
  const lastBrowserPage = useMemo(() => lastBrowserPageOf(browserRowMap), [browserRowMap]);
  // Which session the driven browser belongs to, for the reopen (the same
  // identity the watch stream's hello carries).
  const browserSession = useMemo(
    () => ({ sessionUuid: managedSession?.session_id ?? null, tmuxSession: managedSession?.tmux_session ?? null }),
    [managedSession?.session_id, managedSession?.tmux_session],
  );

  const chatWakeMapRef = useRef<Record<string, ChatWakePrompt>>({});
  const chatWakeMap = useMemo(() => {
    const next: Record<string, ChatWakePrompt> = {};
    for (const kind of userMsgKindMap.values()) {
      if (kind.kind === 'chat_wake' && kind.wake.placeholderId) next[kind.wake.placeholderId] = kind.wake;
    }
    const prev = chatWakeMapRef.current;
    const prevKeys = Object.keys(prev);
    const same = prevKeys.length === Object.keys(next).length && prevKeys.every((k) => k in next);
    if (!same) chatWakeMapRef.current = next;
    return chatWakeMapRef.current;
  }, [userMsgKindMap]);

  return { browserRowMap, lastBrowserPage, browserSession, chatWakeMap };
}
