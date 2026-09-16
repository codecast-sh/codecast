// Pure helpers for the composer "working" status line (rendered by WorkingStatusLine
// in ConversationView). Extracted so the time math and tail-derivation are unit-testable
// under `bun test` without pulling in React/DOM.
//
// Why this line exists: a working turn can go quiet for minutes — one long
// generation, or a long-running tool whose result hasn't landed yet — and a static
// "Working" reads as frozen even though the agent is busy. Surfacing a live elapsed
// clock (and the tool in flight) turns that silent stretch into something that
// visibly reads as progressing.

import { activityLine, formatToolName } from "@codecast/shared/render";

// Below this much elapsed silence we show a plain "Working"; past it the live clock
// appears. Keeps normal fast turns clean and only surfaces a ticking time for a
// genuinely long-quiet turn — the case that otherwise looks stuck.
export const WORKING_ELAPSED_GRACE_MS = 10_000;

export function shouldShowElapsed(startedAt: number | undefined, now: number): boolean {
  return !!startedAt && now - startedAt >= WORKING_ELAPSED_GRACE_MS;
}

// Live m:ss / h:mm:ss clock. Distinct from the coarse "2m" / "1h 5m" historical
// formatter (formatDuration): a second-by-second number whose job is to visibly
// prove a long-quiet turn is still progressing.
export function formatElapsedClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

type TimelineItemLike = { type: string; data: unknown };
type ToolCallLike = { name?: unknown; input?: unknown };
type MessageLike = { role?: string; tool_calls?: Array<ToolCallLike> | null };

// The tool call currently in flight (see deriveRunningTool for the rule), with
// its input, so the phrase library can name the subject.
function deriveRunningToolCall(timeline: ReadonlyArray<TimelineItemLike>): { name: string; input: string } | undefined {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.type !== "message") continue;
    const msg = item.data as MessageLike;
    if (msg.role === "system") continue;
    if (msg.role !== "assistant") return undefined;
    const tcs = msg.tool_calls;
    const tc = tcs && tcs.length ? tcs[tcs.length - 1] : undefined;
    if (!tc || typeof tc.name !== "string") return undefined;
    return { name: tc.name, input: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input ?? {}) };
  }
  return undefined;
}

// What the agent is doing now, from the loaded timeline: the present tense
// phrase the inbox activity line uses ("editing chat.ts", "running npx tsc"),
// through the same shared phrase library, so the composer and the card never
// name one tool two ways. Falls back to the tool's display name when the call
// has no phrase (unparsed input). This is the composer's fallback for a row
// whose server side activity stamp is absent or stale.
export function deriveRunningPhrase(timeline: ReadonlyArray<TimelineItemLike>): string | undefined {
  const tc = deriveRunningToolCall(timeline);
  if (!tc) return undefined;
  return activityLine(tc) || formatToolName(tc.name) || tc.name;
}

// The tool currently in flight, for the working status line. The tail being an
// assistant message that carries tool calls means its result hasn't landed yet
// (tool results arrive as the next user message), so the last call is running —
// e.g. a multi-minute deploy reads as "Working · 3:14 · Bash". Returns undefined
// when the tail isn't a tool-bearing assistant message (e.g. a long single
// generation, or a tool whose result already arrived), where the clock alone carries
// the liveness. System messages at the tail are skipped, not treated as the end.
export function deriveRunningTool(timeline: ReadonlyArray<TimelineItemLike>): string | undefined {
  return deriveRunningToolCall(timeline)?.name;
}
