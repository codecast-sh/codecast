import fs from "node:fs";
import { parseSessionFile, type ParsedMessage } from "../parser.js";
type TranscriptTurnState = "idle" | "active" | "unknown";

export function recoverImagesFromBackup(
  messages: ParsedMessage[],
  bakPath: string,
  logFn: (msg: string) => void,
): ParsedMessage[] {
  const unavailableToolIds = new Set<string>();
  for (const msg of messages) {
    if (!msg.toolResults) continue;
    for (const tr of msg.toolResults) {
      if (tr.content === "[result unavailable]") {
        unavailableToolIds.add(tr.toolUseId);
      }
    }
  }
  if (unavailableToolIds.size === 0) return messages;

  let bakContent: string;
  try {
    bakContent = fs.readFileSync(bakPath, "utf-8");
  } catch {
    return messages;
  }

  const bakMessages = parseSessionFile(bakContent);
  const imageMap = new Map<string, { mediaType: string; data: string; toolUseId?: string }>();
  for (const bm of bakMessages) {
    if (!bm.images) continue;
    for (const img of bm.images) {
      if (img.data && img.toolUseId && unavailableToolIds.has(img.toolUseId)) {
        imageMap.set(img.toolUseId, {
          mediaType: img.mediaType,
          data: img.data,
          toolUseId: img.toolUseId,
        });
      }
    }
  }

  if (imageMap.size === 0) return messages;
  logFn(`Recovered ${imageMap.size} images from backup file`);

  for (const msg of messages) {
    if (!msg.toolResults) continue;
    const recovered: typeof msg.images = [];
    for (const tr of msg.toolResults) {
      const img = imageMap.get(tr.toolUseId);
      if (img) {
        recovered.push(img);
      }
    }
    if (recovered.length > 0) {
      msg.images = [...(msg.images || []), ...recovered];
    }
  }

  return messages;
}

export function classifyOpencodeTranscriptTail(tailContent: string): TranscriptTurnState {
  let parsed: any;
  try {
    parsed = JSON.parse(tailContent);
  } catch {
    return "unknown"; // partial/mid-write file -> defer
  }
  // Assembled snapshot: reduce to the newest message's info.
  const info = Array.isArray(parsed?.messages)
    ? parsed.messages[parsed.messages.length - 1]?.info
    : parsed;
  const role = info?.role;
  if (role === "assistant") {
    return info?.time?.completed ? "idle" : "active";
  }
  if (role === "user") return "active";
  return "unknown";
}

// The single client -> transcript-tail classifier mapping. Claude, codex and
// opencode have a tail classifier; cursor/gemini return undefined, which every
// caller treats as "this client's transcript format isn't classified — defer" (the
// old `agentType !== "claude" && agentType !== "codex"` gate). A new client wires
// pi writes a JSONL tree; each line is a {type,id,parentId,...} entry. Turn state is
// carried on the assistant message's `stopReason`, mirroring claude's stop_reason:
//   - toolUse                       -> mid-turn (a tool call is pending) -> active
//   - stop/length/error/aborted     -> the turn ended                    -> idle
//   - a user or toolResult entry    -> the agent's move is next          -> active
//   - a streaming/unrecognized state -> defer                            -> unknown
// We read the tail back-to-front and decide on the first `message` entry, scanning
// past non-message entries (model_change / thinking_level_change / branch_summary /
// session header). NOTE: pi only flushes a turn's entries to disk once its assistant
// message completes (session-manager `_persist` buffers until the first assistant
// arrives), so an in-flight no-tool turn shows the PRIOR turn's end here — the pane
// readiness / status hooks cover that gap, exactly as for the other clients.
export function classifyPiTranscriptTail(tailContent: string): TranscriptTurnState {
  const lines = tailContent.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let d: { type?: string; message?: { role?: string; stopReason?: string } };
    try {
      d = JSON.parse(line);
    } catch {
      continue; // partial/corrupt line (mid-write tail) -> skip
    }
    if (d.type !== "message") continue; // model_change / header / etc. -> keep scanning
    const role = d.message?.role;
    if (role === "assistant") {
      const sr = d.message?.stopReason;
      if (sr === "toolUse") return "active";
      if (sr === "stop" || sr === "length" || sr === "error" || sr === "aborted") return "idle";
      return "unknown"; // streaming / unrecognized stopReason -> defer
    }
    if (role === "user" || role === "toolResult") return "active";
    // any other role (extended message types) -> keep scanning for a real turn
  }
  return "unknown";
}

// Grok's updates.jsonl marks turn boundaries with the xAI `turn_completed` update
// — upstream calls it "the durable, replayable signal that a turn reached its
// terminal outcome" — instead of a per-message stop_reason. We read the tail back
// to front (mirroring classifyCodexTranscriptTail) and decide on the first
// meaningful update:
//   - turn_completed (ANY stop_reason: end_turn/cancelled/error/…)  -> idle
//   - pending_interaction with no later interaction_resolved        -> active
//     (the agent is parked on a question/permission — same convention as claude's
//     pending AskUserQuestion: never idle; the needs-input path owns surfacing it)
//   - user_message_chunk / tool_call / tool_call_update             -> active
//   - a streaming agent_message/thought chunk with no terminal mark -> unknown
//     (a crashed stream must defer, never read as active — claude convention)
// Housekeeping kinds appended AFTER turn_completed (last_turn_summary,
// session_summary_generated, session_recap, rewind_marker) and UI/meta kinds are
// scanned past. An unparsable line is the expected torn tail (buffered appends +
// healing) — skip it, never fail.
export function classifyGrokTranscriptTail(tailContent: string): TranscriptTurnState {
  const lines = tailContent.split("\n");
  // interaction_resolved lines sit AFTER the pending_interaction they answer, so
  // scanning backward we collect resolutions first and match them off by id
  // (falling back to a counter when the id fields are absent).
  const resolvedIds = new Set<string>();
  let resolvedAnon = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let d: { params?: { update?: Record<string, unknown> }; update?: Record<string, unknown> };
    try {
      d = JSON.parse(line);
    } catch {
      continue; // torn/partial line (mid-write tail) -> skip
    }
    const update = d.params?.update ?? d.update;
    const kind = update?.sessionUpdate;
    if (typeof kind !== "string") continue;
    switch (kind) {
      case "turn_completed":
        return "idle";
      case "interaction_resolved": {
        const key = update?.interaction_id ?? update?.id;
        if (typeof key === "string") resolvedIds.add(key);
        else resolvedAnon++;
        break; // keep scanning
      }
      case "pending_interaction": {
        const key = update?.interaction_id ?? update?.id;
        if (typeof key === "string" && resolvedIds.has(key)) break;
        if (typeof key !== "string" && resolvedAnon > 0) {
          resolvedAnon--;
          break;
        }
        return "active";
      }
      case "user_message_chunk":
      case "tool_call":
      case "tool_call_update":
        return "active";
      case "agent_message_chunk":
      case "agent_thought_chunk":
        return "unknown"; // streaming with no terminal marker -> defer
      default:
        break; // plan / meta / post-turn housekeeping -> keep scanning
    }
  }
  return "unknown";
}

