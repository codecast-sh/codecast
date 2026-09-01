// In-place agent/model switch: the transcript divider a session keeps when it
// changes provider or model without forking. One notice format, one parser —
// Convex inserts it, the web/mobile timeline renders it, reconstitution keeps
// it in the new agent's history, and slash-command `/model` echoes classify as
// the same kind so a model change looks like a provider change.
//
// PURE isomorphic data — no Node or DOM APIs.

import {
  AGENT_CLIENTS,
  findModelOption,
  fromConvexAgentType,
  modelOptionKey,
} from "./agentClients";

/** First line of every in-place switch notice. Historical rows match this too. */
export const AGENT_SWITCH_NOTICE_PREFIX = "[codecast] Now using";

const NOTICE_LINE_RE =
  /^\[codecast\] Now using (.+?)(?: \(was (.+?)\))?\.\s*$/;

export type AgentSwitchNotice = {
  /** Caption after "Now using", e.g. "Codex" or "Codex · GPT-5.6 Sol". */
  toLabel: string;
  /** Caption after "was", when the previous agent/model is known. */
  fromLabel?: string;
};

export function agentDisplayName(agentType: string | undefined | null): string {
  if (!agentType) return "the agent";
  return AGENT_CLIENTS[fromConvexAgentType(agentType)].displayName;
}

export function modelDisplayLabel(
  agentType: string | undefined | null,
  model: string | null | undefined,
): string | undefined {
  if (!model || model === "default") return undefined;
  const direct = findModelOption(agentType ?? undefined, model);
  if (direct && direct.key !== "default") return direct.label;
  const key = modelOptionKey(model, agentType ?? undefined);
  const viaKey = findModelOption(agentType ?? undefined, key);
  if (viaKey && viaKey.key !== "default") return viaKey.label;
  return model;
}

function composeLabel(agentType: string | undefined | null, model?: string | null): string {
  const agent = agentDisplayName(agentType);
  const modelLabel = modelDisplayLabel(agentType, model);
  return modelLabel ? `${agent} · ${modelLabel}` : agent;
}

/** Build the user-message body Convex inserts and the UI classifies. */
export function formatAgentSwitchNotice(opts: {
  toAgent: string;
  fromAgent?: string | null;
  toModel?: string | null;
  fromModel?: string | null;
}): string {
  const toLabel = composeLabel(opts.toAgent, opts.toModel);
  const fromChanged = (opts.fromAgent && opts.fromAgent !== opts.toAgent)
    || (opts.fromModel != null && opts.fromModel !== (opts.toModel ?? opts.fromModel));
  const fromLabel = fromChanged
    ? composeLabel(opts.fromAgent ?? opts.toAgent, opts.fromModel)
    : undefined;
  const head = fromLabel
    ? `${AGENT_SWITCH_NOTICE_PREFIX} ${toLabel} (was ${fromLabel}).`
    : `${AGENT_SWITCH_NOTICE_PREFIX} ${toLabel}.`;
  return `${head}\n\nThis session continues here. History above is the same thread.`;
}

export function isAgentSwitchNotice(content: string | null | undefined): boolean {
  if (!content) return false;
  return content.trimStart().startsWith(AGENT_SWITCH_NOTICE_PREFIX);
}

export function parseAgentSwitchNotice(content: string | null | undefined): AgentSwitchNotice | null {
  if (!isAgentSwitchNotice(content)) return null;
  const first = (content ?? "").trim().split("\n", 1)[0] ?? "";
  const m = first.match(NOTICE_LINE_RE);
  if (!m) {
    const rest = first.slice(AGENT_SWITCH_NOTICE_PREFIX.length).trim().replace(/\.$/, "");
    return rest ? { toLabel: rest } : null;
  }
  return {
    toLabel: m[1].trim(),
    ...(m[2]?.trim() ? { fromLabel: m[2].trim() } : {}),
  };
}

const MODEL_CMD_NAMES = new Set(["model", "effort"]);

/** Slash commands that are a model/effort switch, not a user prompt. */
export function isModelSwitchCommandName(cmdName: string | null | undefined): boolean {
  return !!cmdName && MODEL_CMD_NAMES.has(cmdName.toLowerCase());
}

/**
 * Claude's `/model` / `/effort` confirmation line. Used to hide the stdout
 * echo and to label the divider when the slash command itself is missing.
 */
const MODEL_STDOUT_RE =
  /<local-command-stdout>[^<]*Set model to (?:\u001b\[\d+m)*([^\u001b<]+?)(?:\u001b\[\d+m)*(?:\s+and saved|\s+for this session|<\/local-command-stdout>|$)/i;
const EFFORT_STDOUT_RE =
  /<local-command-stdout>[^<]*Set effort level to (?:\u001b\[\d+m)*(low|medium|high|xhigh|max)/i;

export function modelSwitchStdoutLabel(content: string | null | undefined): string | null {
  if (!content) return null;
  const model = content.match(MODEL_STDOUT_RE);
  if (model) {
    const name = model[1].replace(/\s+and saved.*$/i, "").replace(/\s+for this session.*$/i, "").trim();
    return name || null;
  }
  const effort = content.match(EFFORT_STDOUT_RE);
  if (effort) return `${effort[1].toLowerCase()} effort`;
  return null;
}

export function isModelSwitchStdout(content: string | null | undefined): boolean {
  return modelSwitchStdoutLabel(content) != null;
}
