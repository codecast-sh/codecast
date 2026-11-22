/**
 * Google Antigravity CLI (`agy`) transcripts.
 *
 * agy writes one JSON row per finished step to
 *   ~/.gemini/antigravity-cli/brain/<conversation uuid>/.system_generated/logs/transcript_full.jsonl
 * and appends while the turn runs (a three-step turn grew the file 1 → 2 → 3
 * rows as each step finished; agy 1.5.14, 2026-11-22). Every row carries
 * step_index, source (USER_EXPLICIT | MODEL | SYSTEM), type, status and
 * created_at (ISO, seconds). The types seen on real conversations:
 *   - USER_INPUT {content}: the prompt, wrapped as <USER_REQUEST>…</USER_REQUEST>
 *     followed by agy's own <ADDITIONAL_METADATA> and settings notices. Only the
 *     request is the user's words.
 *   - PLANNER_RESPONSE {content?, thinking?, tool_calls?: [{name, args}], model,
 *     input_tokens, output_tokens, cache_read_tokens}: one model response. A
 *     response with tool calls usually has no content.
 *   - GENERIC {content}: a tool's output. A response with N tool calls is
 *     followed by exactly N GENERIC rows, in call order (eight parallel
 *     search_web calls → eight rows), and nothing else links a result to its
 *     call, so results pair by position.
 *   - SYSTEM_MESSAGE {content}: agy's own reminders and notices to the model
 *     ("not actually sent by the user"); never shown.
 *   - ERROR_MESSAGE {content, error}: e.g. "The stream was interrupted…", after
 *     which agy retries on its own.
 * transcript.jsonl beside it holds the same rows with long fields cut (it lists
 * them in truncated_fields and stringifies tool args), so only the full file is
 * read. The working directory is not in the transcript; it is the
 * conversation's workspace_uris row in conversation_summaries.db
 * (readAntigravitySummary in workers/ingestDatabase.ts).
 *
 * Uuids are per conversation (`agy-u<step>`, `agy-a<step>`, `agy-e<step>`), the
 * grok shape: a step index never moves once written, so a uuid names one row
 * on every pass. Tool results merge onto the response that made the calls, so
 * that row's signature changes as results land and the sync delta resends it.
 */

import { isCodecastImportNotice, type ParsedMessage, type ToolCall, type ToolResult } from "./parser.js";

interface AntigravityRow {
  step_index?: unknown;
  source?: unknown;
  type?: unknown;
  status?: unknown;
  created_at?: unknown;
  content?: unknown;
  thinking?: unknown;
  error?: unknown;
  model?: unknown;
  tool_calls?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_tokens?: unknown;
}

const USER_REQUEST = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;

function rows(content: string): AntigravityRow[] {
  const out: AntigravityRow[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object" && !Array.isArray(row)) out.push(row as AntigravityRow);
    } catch {
      // A torn last line heals on the next append.
    }
  }
  return out;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stepOf(row: AntigravityRow, fallback: number): number {
  return typeof row.step_index === "number" && Number.isSafeInteger(row.step_index) && row.step_index >= 0
    ? row.step_index
    : fallback;
}

function timestampOf(row: AntigravityRow): number {
  const parsed = typeof row.created_at === "string" ? Date.parse(row.created_at) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The user's own words of a USER_INPUT row: the <USER_REQUEST> body when agy
 *  wrapped it, else the whole content. */
export function antigravityUserRequest(content: string): string {
  const match = content.match(USER_REQUEST);
  return (match ? match[1] : content).trim();
}

function toolInput(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object" && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {}
  }
  return {};
}

export function parseAntigravityTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  // Calls still waiting for their GENERIC rows, oldest first, each with the
  // message it belongs to.
  let pending: { call: ToolCall; message: ParsedMessage }[] = [];

  rows(content).forEach((row, index) => {
    const step = stepOf(row, index);
    const timestamp = timestampOf(row);
    switch (row.type) {
      case "USER_INPUT": {
        const request = antigravityUserRequest(text(row.content));
        pending = [];
        if (!request || isCodecastImportNotice(request)) return;
        messages.push({ uuid: `agy-u${step}`, role: "user", content: request, timestamp });
        return;
      }
      case "PLANNER_RESPONSE": {
        const calls: ToolCall[] = Array.isArray(row.tool_calls)
          ? row.tool_calls.flatMap((raw, i) => {
              const call = raw as { name?: unknown; args?: unknown } | null;
              const name = text(call?.name);
              return name ? [{ id: `agy-t${step}-${i}`, name, input: toolInput(call?.args) }] : [];
            })
          : [];
        const body = text(row.content);
        // A response with neither words nor calls (thinking alone, before an
        // interrupted stream) has nothing to show.
        if (!body.trim() && calls.length === 0) return;
        const input = count(row.input_tokens);
        const output = count(row.output_tokens);
        const cacheRead = count(row.cache_read_tokens);
        const message: ParsedMessage = {
          uuid: `agy-a${step}`,
          role: "assistant",
          content: body,
          timestamp,
          ...(text(row.thinking) ? { thinking: text(row.thinking) } : {}),
          ...(text(row.model) ? { model: text(row.model) } : {}),
          ...(calls.length ? { toolCalls: calls } : {}),
          ...(input !== undefined || output !== undefined
            ? {
                usage: {
                  input_tokens: input ?? 0,
                  output_tokens: output ?? 0,
                  ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
                },
              }
            : {}),
        };
        messages.push(message);
        pending = calls.map((call) => ({ call, message }));
        return;
      }
      case "GENERIC": {
        const next = pending.shift();
        if (!next) return;
        const result: ToolResult = { toolUseId: next.call.id, content: text(row.content) };
        next.message.toolResults = [...(next.message.toolResults ?? []), result];
        return;
      }
      case "ERROR_MESSAGE": {
        const error = text(row.error) || text(row.content);
        pending = [];
        if (error.trim()) messages.push({ uuid: `agy-e${step}`, role: "system", content: error, timestamp });
        return;
      }
      default:
        // SYSTEM_MESSAGE and any row type agy adds later.
        return;
    }
  });
  return messages;
}

type TranscriptTurnState = "idle" | "active" | "unknown";

/**
 * Whether the conversation's last finished step ended the turn. agy writes a
 * step only once it is DONE, so the tail is always a completed step:
 *   - a response with words and no tool calls is the turn's answer → idle
 *   - an error row is the end of a failed turn unless agy retries → idle
 *   - a response that made calls, a tool result, the user's prompt or agy's
 *     own system notice all mean more steps are coming → active
 */
export function classifyAntigravityTranscriptTail(tailContent: string): TranscriptTurnState {
  const all = rows(tailContent);
  for (let i = all.length - 1; i >= 0; i--) {
    const row = all[i]!;
    switch (row.type) {
      case "PLANNER_RESPONSE": {
        const calls = Array.isArray(row.tool_calls) && row.tool_calls.length > 0;
        if (calls) return "active";
        return text(row.content).trim() ? "idle" : "active";
      }
      case "ERROR_MESSAGE":
        return "idle";
      case "GENERIC":
      case "USER_INPUT":
      case "SYSTEM_MESSAGE":
        return "active";
      default:
        continue;
    }
  }
  return "unknown";
}
