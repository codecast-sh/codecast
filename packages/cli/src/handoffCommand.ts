// `cast handoff --to <agent>` — hand this session's work to a NEW session on
// another agent or model. The server (handoff.start over /cli/handoff) does
// the brief, the prompt, the spawn and the link; this module holds the pure
// flag logic and the roster so index.ts stays a thin caller and tests need no
// network. Without any of the --to flags the command keeps its old shape: a
// context transfer document (formatHandoff) to stdout or -o.

import {
  AGENT_CLIENTS,
  InvalidExecutionAgentTypeError,
  parseExecutionAgentClientId,
  toConvexAgentType,
  describeAgentRun,
  type ConvexAgentType,
} from "@codecast/shared/contracts";

export interface HandoffFlags {
  to?: string;
  model?: string;
  effort?: string;
  account?: string;
  device?: string;
  message?: string;
  dryRun?: boolean;
  toFile?: string;
  session?: string;
  json?: boolean;
}

export type HandoffMode = "document" | "spawn";

/** The old document when none of the spawn flags is given; `-o` alone stays a document. */
export function handoffMode(f: HandoffFlags): HandoffMode {
  const spawnish = f.to !== undefined || f.model !== undefined || f.effort !== undefined ||
    f.account !== undefined || f.device !== undefined || f.message !== undefined || !!f.dryRun;
  return spawnish ? "spawn" : "document";
}

export const SAME_AGENT = "same";

/**
 * `--to same`, or --to omitted (a `--model`-only handoff), means the source's
 * own agent: undefined here, and the server fills it from the source row.
 * Anything else must be a known client; an unknown name fails loudly rather
 * than silently becoming Claude the way the permissive display parser would.
 */
export function resolveHandoffAgent(to: string | undefined): ConvexAgentType | undefined {
  const raw = (to ?? "").trim().toLowerCase();
  if (!raw || raw === SAME_AGENT) return undefined;
  try {
    return toConvexAgentType(parseExecutionAgentClientId(raw));
  } catch (err) {
    if (err instanceof InvalidExecutionAgentTypeError) {
      const known = [SAME_AGENT, ...Object.keys(AGENT_CLIENTS)].join(", ");
      throw new Error(`Unknown agent "${to}". One of: ${known}`);
    }
    throw err;
  }
}

/** The /cli/handoff body (api_token is added by cliPost). */
export function buildHandoffRequest(f: HandoffFlags, sourceRef: string): Record<string, unknown> {
  const body: Record<string, unknown> = { conversation_id: sourceRef };
  const agent = resolveHandoffAgent(f.to);
  if (agent) body.agent_type = agent;
  if (f.model) body.model = f.model;
  if (f.effort) body.effort = f.effort;
  if (f.account) body.cc_account = f.account;
  if (f.device) body.device = f.device;
  const direction = (f.message ?? "").trim();
  if (direction) body.direction = direction;
  if (f.dryRun) body.dry_run = true;
  return body;
}

export interface HandoffStartResult {
  source: { conversation_id: string; short_id: string; title: string | null; agent_type: string | null; model: string | null; message_count: number; project_path: string | null };
  prompt: string;
  brief: string;
  brief_source: "model" | "fallback";
  session: { conversation_id: string; short_id: string; agent_type: string; model: string | null; effort: string | null; project_path: string | null } | null;
}

type Colors = { green: string; cyan: string; dim: string; bold: string; yellow: string; reset: string };

/** The roster, in the shape `cast spawn` prints, plus the one instruction the source agent needs. */
export function formatHandoffRoster(r: HandoffStartResult, c: Colors, home: string = process.env.HOME || "~"): string {
  const s = r.session;
  if (!s) return r.prompt;
  const dir = (s.project_path ?? r.source.project_path ?? "").replace(home, "~") || "the source's directory";
  const lines = [
    `${c.green}✓${c.reset} handed off ${c.cyan}${r.source.short_id}${c.reset} → ${c.cyan}${s.short_id}${c.reset} on ${c.bold}${describeAgentRun(s.agent_type, s.model)}${c.reset} in ${c.dim}${dir}${c.reset} — in your inbox`,
    `  ${c.dim}brief: ${r.brief_source === "model" ? "model-written" : "fallback (no model brief; assembled from the pinned state and last message)"}${c.reset}`,
    `  ${c.dim}source state pinned done: "Handed off to ${s.short_id} on ${describeAgentRun(s.agent_type, s.model)}"${c.reset}`,
    `  ${c.yellow}End your turn now.${c.reset} ${s.short_id} continues the work; ${c.dim}cast read ${s.short_id}${c.reset} follows it.`,
  ];
  return lines.join("\n");
}
