// Promoting a Claude Code subagent a person took over to its own process
// (pl-1134). The in-process copy and a `claude --resume` copy must never run
// at once, and only the parent's tools reach the in-process copy, so:
//   1. The agent goes on a deny list first, and for good: the PreToolUse hook
//      refuses any SendMessage to it from its old parent's session (a parent
//      resumed days later revives even a dead agent in-process).
//   2. Delivery waits while subagentRunState says the in-process copy runs,
//      or its transcript moved in the last few seconds (a SendMessage that
//      passed the hook just before step 1 lands within milliseconds).
//   3. Then the delivery resumes it under a UUID like any stopped subagent.
// Kept small: the hook's fast path loads the guard half of this file.

import * as fs from "node:fs";
import * as path from "node:path";

export const PROMOTED_AGENTS_FILE = "promoted-agents.json";
/** How long the agent's transcript must stay still before the copy. */
export const PROMOTION_SETTLE_MS = 2_000;
export const PROMOTION_HOLD_REASON = "waiting for its parent to stop it";

/** parent session id -> SendMessage address (the agent id, and a named
 *  agent's name) -> the conversation's short id and when it was written. */
export type PromotedAgents = Record<string, Record<string, { short_id: string; at: number; name?: true }>>;

export function readPromotedAgents(configDir: string): PromotedAgents {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, PROMOTED_AGENTS_FILE), "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Puts the agent's addresses on its parent's deny list (written atomically)
 *  and returns when it was first put there. Never removed. */
export function recordPromotedAgent(configDir: string, parentSessionId: string, agentId: string, name: string | null, shortId: string, now: number): number {
  const all = readPromotedAgents(configDir);
  const mine = { ...all[parentSessionId] };
  const addresses = name ? [agentId, name] : [agentId];
  const known = addresses.map((a) => mine[a]).filter(Boolean);
  if (known.length === addresses.length) return Math.min(...known.map((e) => e.at));
  mine[agentId] ??= { short_id: shortId, at: now };
  if (name) mine[name] ??= { short_id: shortId, at: now, name: true };
  all[parentSessionId] = mine;
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, PROMOTED_AGENTS_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all));
  fs.renameSync(tmp, file);
  return Math.min(now, ...known.map((e) => e.at));
}

/** A Claude Code subagent's agent id from its session id: `agent-<hex>` for
 *  a Task subagent, `agent-a<name>-<hex>` for a named one. */
export function agentIdOfSession(sessionId: string): string | null {
  return /^agent-(.+)$/.exec(sessionId)?.[1] ?? null;
}

/** The name a named agent is addressed by (SendMessage `to`, recipient_kind
 *  "name"): its meta's `name`, else the one its agent id carries. */
export function agentNameOf(agentId: string, meta: unknown): string | null {
  const name = meta && typeof meta === "object" ? (meta as { name?: unknown }).name : undefined;
  if (typeof name === "string" && name) return name;
  return /^a(.+)-[0-9a-f]{16}$/.exec(agentId)?.[1] ?? null;
}

/**
 * The PreToolUse hook's answer to a SendMessage: a deny naming the session
 * the agent now runs as, or "" to let it through. `to` (and `recipient`) is
 * the full agent id for a Task subagent; a trailing " [ref]" is dropped.
 * The payload's session_id is the root parent's even when a subagent sends.
 */
export function sendMessageGuardOutput(input: string, promoted: (parentSessionId: string) => PromotedAgents[string] | undefined): string {
  let hook: { session_id?: unknown; tool_name?: unknown; tool_input?: { to?: unknown; recipient?: unknown } };
  try {
    hook = JSON.parse(input);
  } catch {
    return "";
  }
  if (hook.tool_name !== "SendMessage" || typeof hook.session_id !== "string") return "";
  const agents = promoted(hook.session_id);
  if (!agents) return "";
  for (const raw of [hook.tool_input?.to, hook.tool_input?.recipient]) {
    if (typeof raw !== "string") continue;
    const address = raw.replace(/\s+\[[^\]]*\]\s*$/, "").trim();
    const hit = Object.hasOwn(agents, address) ? agents[address] : undefined;
    if (!hit) continue;
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        // A name outlives its agent: a later agent given the same name is
        // refused too, and is told to pick another.
        permissionDecisionReason: `This agent was taken over and now runs as its own session ${hit.short_id}. Reach it with: cast send ${hit.short_id}${hit.name ? ". A new agent needs a name of its own." : ""}`,
      },
    });
  }
  return "";
}

export interface PromotionGateDeps {
  configDir: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** subagentRunState on the agent's files as they are now. */
  runState: (jsonlPath: string) => Promise<"running" | "stopped">;
  /** The transcript's mtime, or null when it cannot be read. */
  mtimeMs: (jsonlPath: string) => number | null;
}

/**
 * Before a stopped subagent transcript is resumed as its own process: the
 * hold reason while its in-process copy may still run, or null when the
 * resume may go ahead. Records the deny entry before anything else.
 */
export async function promotionHold(jsonlPath: string, shortId: string, deps: PromotionGateDeps): Promise<string | null> {
  const parts = jsonlPath.split(path.sep);
  const idx = parts.lastIndexOf("subagents");
  const agentId = agentIdOfSession(path.basename(jsonlPath, ".jsonl"));
  if (idx < 1 || !agentId) return null;
  let meta: unknown = null;
  try {
    meta = JSON.parse(fs.readFileSync(jsonlPath.replace(/\.jsonl$/, ".meta.json"), "utf-8"));
  } catch {
    // no meta: the id still names it
  }
  const name = agentNameOf(agentId, meta);
  const deniedAt = recordPromotedAgent(deps.configDir, parts[idx - 1], agentId, name, shortId, deps.now());
  // A SendMessage the hook let through just before the deny lands within
  // milliseconds; wait out the settle once, so its line is on disk to see.
  const sinceDeny = deps.now() - deniedAt;
  if (sinceDeny < PROMOTION_SETTLE_MS) await deps.sleep(PROMOTION_SETTLE_MS - sinceDeny);
  if ((await deps.runState(jsonlPath)) === "running") return PROMOTION_HOLD_REASON;
  const mtime = deps.mtimeMs(jsonlPath);
  if (mtime !== null && deps.now() - mtime < PROMOTION_SETTLE_MS) return PROMOTION_HOLD_REASON;
  return null;
}
