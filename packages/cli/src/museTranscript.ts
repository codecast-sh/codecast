/**
 * The Muse transcript parser, split out of parser.ts (which re-exports it) for
 * its line cap. The one value it takes from parser.ts is a function, called
 * only while parsing, so the import cycle resolves before it is used.
 */

import { isCodecastImportNotice, type ParsedMessage, type ToolCall, type ToolResult } from "./parser.js";

// ── Muse (Meta Muse Code, `muse` CLI) ─────────────────────────────────────
// session.jsonl is an event-sourced runtime log, not a message transcript:
// every line is an envelope {recorded_at: <unix-MICROSECONDS>, payload_type,
// payload} where payload.kind selects the dialect. Message-bearing records
// (all shapes live-verified against a real session.jsonl, CLI 1.3.0):
//   - payload.kind "run", event.kind "started" → user turn (event.prompt).
//     The message uuid is the run_id, stable across passes.
//   - "assistant_message_committed" {message_id, text} → assistant turn.
//   - "assistant_tool_calls_committed" {message_id, tool_calls:
//     [{id/call_id, name, args: JSON-string}]} → assistant turn carrying
//     toolCalls (args parse-failures become {}, never a throw).
//   - "tool_result_batch_committed" {batch_id, results: [{tool_call_id,
//     text}]} → the results for the calls, MERGED onto the message whose
//     message_id equals batch_id (muse reuses the id for both halves, so
//     emitting a second message would mint two rows with one uuid: the sync
//     delta keys on uuid, and the collision re-sent the call row on every
//     pass forever). A batch with no matching call stands alone.
//   - "run_retracted" → the run never produced output and muse put the prompt
//     back in the composer (an interrupt before the first token). Every
//     message of that run is dropped, so the prompt the user re-submits is
//     ONE turn, not two. Already-synced rows disappear through the daemon's
//     orphan sweep (computePiSyncDelta), which deletes uuids the parser no
//     longer emits.
//   - "reasoning_summary_committed" {text} → thinking on the turn's most
//     recent assistant message (summaries only).
//   - "model_completed" {usage: {input_tokens, output_tokens,
//     cached_tokens}} → usage on the most recent assistant message.
//   - payload.kind "run_model", record.model_id → the model for that run's
//     assistant messages (record.run_stream.id == run_id).
// Deliberately skipped: raw "reasoning_committed" (verbatim chain-of-thought
// stays out of the synced transcript — the same reason `muse export` keeps
// reasoning blobs out of its share-safe variant), streaming deltas
// (reasoning_summary_delta, tool output chunks), task/approval/scheduling
// records, and the line-1 retained_frame permission transaction.
// A torn LAST line is expected (buffered appends heal on the next write) —
// skip unparsable lines silently, never fail the parse.
interface MuseEnvelope {
  recorded_at?: number;
  payload?: {
    kind?: string;
    run_id?: string;
    event?: { kind?: string; prompt?: unknown };
    record?: { run_stream?: { id?: string }; model_id?: unknown; cwd?: unknown };
  };
}

interface MuseToolCall {
  id?: unknown;
  call_id?: unknown;
  name?: unknown;
  args?: unknown;
}

function museTimestamp(recordedAt: unknown): number {
  // recorded_at is unix MICROSECONDS (16 digits); tolerate seconds/millis.
  if (typeof recordedAt !== "number" || !Number.isFinite(recordedAt)) return Date.now();
  if (recordedAt > 1e14) return Math.floor(recordedAt / 1000);
  if (recordedAt > 1e11) return Math.floor(recordedAt);
  return Math.floor(recordedAt * 1000);
}

function museText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseMuseSessionFile(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  const runModel = new Map<string, string>();
  // Which run produced each message, so run_retracted can drop the whole run,
  // and the message each uuid belongs to, so a result batch merges onto its
  // own tool-call message instead of becoming a second row under one uuid.
  const messageRun = new Map<ParsedMessage, string | undefined>();
  const byUuid = new Map<string, ParsedMessage>();
  const retractedRuns = new Set<string>();
  let lastAssistant: ParsedMessage | null = null;

  const emit = (msg: ParsedMessage, runId: string | undefined): ParsedMessage => {
    messages.push(msg);
    messageRun.set(msg, runId);
    if (msg.uuid) byUuid.set(msg.uuid, msg);
    return msg;
  };

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let envelope: MuseEnvelope;
    try {
      envelope = JSON.parse(line) as MuseEnvelope;
    } catch {
      continue; // torn/corrupt line (mid-write tail) -> skip
    }
    const payload = envelope.payload;
    if (!payload || typeof payload !== "object") continue;
    const timestamp = museTimestamp(envelope.recorded_at);

    if (payload.kind === "run_model") {
      const runId = payload.record?.run_stream?.id;
      const modelId = payload.record?.model_id;
      if (typeof runId === "string" && typeof modelId === "string" && modelId) {
        runModel.set(runId, modelId);
      }
      continue;
    }

    if (payload.kind !== "run") continue;
    const runId = typeof payload.run_id === "string" ? payload.run_id : undefined;
    const event = payload.event;
    if (!event || typeof event !== "object" || typeof event.kind !== "string") continue;

    switch (event.kind) {
      case "started": {
        const prompt = museText(event.prompt);
        if (isCodecastImportNotice(prompt)) break;
        if (prompt.trim()) {
          emit({ uuid: runId, role: "user", content: prompt, timestamp }, runId);
          lastAssistant = null;
        }
        break;
      }
      case "assistant_message_committed": {
        const text = museText((event as { text?: unknown }).text);
        const messageId = museText((event as { message_id?: unknown }).message_id);
        if (text) {
          const msg: ParsedMessage = {
            uuid: messageId || undefined,
            role: "assistant",
            content: text,
            timestamp,
            model: runId ? runModel.get(runId) : undefined,
          };
          emit(msg, runId);
          lastAssistant = msg;
        }
        break;
      }
      case "terminal": {
        // A run that FAILED stops with no assistant turn to show for it, so
        // the transcript otherwise goes silent and the next thing in it is
        // the same prompt again (the user re-submits). muse's reason says
        // what actually happened — billing, a missing login, a keychain the
        // CLI cannot read — so carry it as the turn's last word.
        const terminal = museText((event as { terminal?: unknown }).terminal);
        const reason = museText((event as { reason?: unknown }).reason);
        if (terminal === "failed" && reason.trim()) {
          lastAssistant = emit({
            uuid: runId ? `${runId}:failed` : undefined,
            role: "assistant",
            content: reason,
            timestamp,
            model: runId ? runModel.get(runId) : undefined,
          }, runId);
        }
        break;
      }
      case "run_retracted": {
        // The run produced nothing and muse restored the prompt to the
        // composer; its records are not transcript history.
        if (runId) retractedRuns.add(runId);
        break;
      }
      case "reasoning_summary_committed": {
        const text = museText((event as { text?: unknown }).text);
        if (text && lastAssistant) {
          lastAssistant.thinking = lastAssistant.thinking ? `${lastAssistant.thinking}\n${text}` : text;
        }
        break;
      }
      case "assistant_tool_calls_committed": {
        const rawCalls = (event as { tool_calls?: unknown }).tool_calls;
        const toolCalls: ToolCall[] = [];
        if (Array.isArray(rawCalls)) {
          for (const raw of rawCalls as MuseToolCall[]) {
            if (!raw || typeof raw !== "object") continue;
            const id = museText(raw.call_id ?? raw.id);
            const name = museText(raw.name);
            let input: Record<string, unknown> = {};
            if (typeof raw.args === "string" && raw.args) {
              try {
                const parsedArgs: unknown = JSON.parse(raw.args);
                if (parsedArgs && typeof parsedArgs === "object") {
                  input = parsedArgs as Record<string, unknown>;
                }
              } catch {
                // non-JSON args string -> {} (never fail the parse)
              }
            } else if (raw.args && typeof raw.args === "object") {
              input = raw.args as Record<string, unknown>;
            }
            toolCalls.push({ id, name, input });
          }
        }
        if (toolCalls.length > 0) {
          const messageId = museText((event as { message_id?: unknown }).message_id);
          const msg: ParsedMessage = {
            uuid: messageId || undefined,
            role: "assistant",
            content: "",
            timestamp,
            toolCalls,
            model: runId ? runModel.get(runId) : undefined,
          };
          emit(msg, runId);
          lastAssistant = msg;
        }
        break;
      }
      case "tool_result_batch_committed": {
        const rawResults = (event as { results?: unknown }).results;
        const toolResults: ToolResult[] = [];
        if (Array.isArray(rawResults)) {
          for (const raw of rawResults as Array<{ tool_call_id?: unknown; text?: unknown; isError?: unknown }>) {
            if (!raw || typeof raw !== "object") continue;
            const text = museText(raw.text);
            toolResults.push({
              toolUseId: museText(raw.tool_call_id),
              content: text,
              isError: raw.isError === true ? true : undefined,
            });
          }
        }
        if (toolResults.length > 0) {
          const batchId = museText((event as { batch_id?: unknown }).batch_id);
          const callMessage = batchId ? byUuid.get(batchId) : undefined;
          if (callMessage) {
            // Same uuid, same turn step: hang the results on the calls they
            // answer. A re-emitted batch replaces a result for the same call
            // rather than appending a second copy of it.
            const merged = callMessage.toolResults ?? [];
            for (const result of toolResults) {
              const at = merged.findIndex((r) => r.toolUseId === result.toolUseId);
              if (at >= 0) merged[at] = result;
              else merged.push(result);
            }
            callMessage.toolResults = merged;
          } else {
            emit({
              uuid: batchId || undefined,
              role: "assistant",
              content: "",
              timestamp,
              toolResults,
            }, runId);
          }
        }
        break;
      }
      case "model_completed": {
        const usage = (event as { usage?: unknown }).usage as
          | { input_tokens?: unknown; output_tokens?: unknown; cached_tokens?: unknown }
          | undefined;
        if (usage && typeof usage === "object" && lastAssistant) {
          const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
          const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
          const cached = typeof usage.cached_tokens === "number" ? usage.cached_tokens : undefined;
          lastAssistant.usage = {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            ...(cached !== undefined ? { cache_read_input_tokens: cached } : {}),
          };
        }
        break;
      }
      default:
        // task_stream_linked / goal_usage_attribution / model_input_trace /
        // reminders / terminal / housekeeping — no message content.
        break;
    }
  }

  if (retractedRuns.size === 0) return messages;
  return messages.filter((msg) => {
    const runId = messageRun.get(msg);
    return !runId || !retractedRuns.has(runId);
  });
}

/** cwd of a muse session, from the session log's own `route_facts` record —
 *  the date-sharded directory names carry no cwd, so this record is the
 *  authoritative source for project mapping (same role as pi's header cwd). */
export function extractMuseCwd(content: string): string | undefined {
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const envelope = JSON.parse(line) as MuseEnvelope;
      if (envelope.payload?.kind === "route_facts") {
        const cwd = envelope.payload.record?.cwd;
        if (typeof cwd === "string" && cwd) return cwd;
      }
    } catch {}
  }
  return undefined;
}
