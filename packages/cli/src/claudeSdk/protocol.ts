// The wire between the daemon and a Claude SDK host process
// (docs/architecture/claude-sdk-backend.md). One JSON object per line over a
// unix socket. The host outlives the daemon, so every frame the host sends is
// either a state snapshot or an event the daemon can apply idempotently: a
// daemon that reconnects asks `hello` and gets the whole state again,
// pending permission prompts included.

import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

export type SdkHostStatus = "starting" | "idle" | "working" | "needs_input" | "stopped";

/** What Claude Code reported when it started: the init answer the version gate reads. */
export interface SdkInitInfo {
  version: string | null;
  model: string | null;
  permissionMode: string | null;
  accountEmail: string | null;
  subscriptionType: string | null;
  slashCommands: string[];
}

/** One prompt Claude is blocked on: a tool permission, an AskUserQuestion or an ExitPlanMode. */
export interface SdkPermissionRequest {
  requestId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  suggestions?: PermissionUpdate[];
  agentId?: string;
  createdAt: number;
  /** For an ExitPlanMode: the permission mode the session had before it entered plan mode. */
  modeBeforePlan?: string | null;
  /** The web card the daemon opened for it, so a daemon that reattaches binds to that card instead of opening another. */
  cardId?: string;
}

export type SdkPermissionAnswer =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };

/** The host's whole state, sent on every hello and after each change. */
export interface SdkHostState {
  /** The session the host was started for; its files are named after it. */
  sessionId: string;
  /** The session Claude is in now. A /clear starts a new one inside the same process. */
  claudeSessionId: string;
  conversationId: string | null;
  pid: number;
  status: SdkHostStatus;
  init: SdkInitInfo | null;
  pending: SdkPermissionRequest[];
  /** The last turn's failure, if it ended on one (limit, billing, auth). Cleared by the next send. */
  lastError: SdkTurnError | null;
  /** The latest activity, replayed to a reconnecting daemon. */
  activity: SdkActivity | null;
  startedAt: number;
  /** The launchd job the host runs as, when it runs as one. */
  launchdLabel?: string;
}

/**
 * What the status hook would have posted for the same moment, in codecast's
 * AgentStatus vocabulary, so the daemon feeds it through the sink a hook post
 * takes (handleStatusData) and every downstream reader behaves as for tmux.
 */
export interface SdkActivity {
  status: "thinking" | "working" | "compacting" | "permission_blocked" | "idle";
  /** Seconds, like a hook post's ts. */
  ts: number;
  message?: string;
  permissionMode?: string;
  /** A session start or resume landing at an idle prompt, not a turn ending. */
  sessionBoundary?: boolean;
  /** Seconds; set when a lead turn ended (the Stop hook's stamp). */
  turnCompletedAt?: number;
  /** A permission dialog is up (the PermissionRequest hook's flag). */
  dialog?: boolean;
}

export interface SdkTurnError {
  /** The SDK's assistant error kind (rate_limit, billing_error, authentication_failed, ...) or the result subtype. */
  kind: string;
  message: string;
  at: number;
}

export type SdkImage = { mediaType: string; data: string };

export type ClientFrame =
  | { op: "hello"; id?: string }
  | { op: "send"; id: string; messageId: string; text: string; images?: SdkImage[]; uuid?: string }
  | { op: "interrupt"; id: string }
  | { op: "answer"; id?: string; requestId: string; answer: SdkPermissionAnswer }
  | { op: "annotate"; id?: string; requestId: string; cardId: string }
  | { op: "set_model"; id: string; model: string | null }
  | { op: "set_permission_mode"; id: string; mode: string }
  | { op: "stop"; id?: string };

export type HostFrame =
  | { type: "state"; state: SdkHostState }
  | { type: "reply"; id: string; ok: boolean; error?: string; data?: unknown }
  | { type: "permission"; request: SdkPermissionRequest }
  | { type: "permission_settled"; requestId: string; by: "answer" | "abort" }
  | { type: "activity"; activity: SdkActivity }
  | { type: "session"; claudeSessionId: string }
  | { type: "result"; subtype: string; isError: boolean; text: string | null; error: SdkTurnError | null }
  | { type: "too_old"; version: string | null; minimum: string }
  | { type: "exit"; reason: string };

/** Splits a byte stream into JSON frames. Malformed lines are dropped and reported. */
export function frameReader<T>(onFrame: (frame: T) => void, onBad?: (line: string) => void): (chunk: Buffer | string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let parsed: T;
      try {
        parsed = JSON.parse(line) as T;
      } catch {
        onBad?.(line);
        continue;
      }
      onFrame(parsed);
    }
  };
}

export const encodeFrame = (frame: ClientFrame | HostFrame): string => JSON.stringify(frame) + "\n";
