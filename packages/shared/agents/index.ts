// The file form of agent definitions and chains.
//
// A definition file is markdown with frontmatter, the shape pi's subagent
// extension (`~/.pi/agent/agents/*.md`) and Claude Code (`~/.claude/agents`)
// both read: name, description, model, tools in the frontmatter and the system
// prompt as the body. `cast agent import` reads either, `cast agent export`
// writes one, and a repo may keep them under `.codecast/agents/`.
//
//   ---
//   name: reviewer
//   description: Reviews a diff for correctness and spec adherence
//   agent: codex
//   model: gpt-5.5
//   effort: high
//   tools: read, grep, bash
//   disallowedTools: Write, Edit
//   mode: propose
//   ---
//   You are a senior reviewer. ...
//
// A chain file has a frontmatter with name and description, then one `## name`
// section per step whose body is that step's prompt template:
//
//   ---
//   name: implement
//   description: scout, plan, then build
//   ---
//   ## scout
//   Find the code relevant to: {task}
//
//   ## planner
//   Plan this: {task}
//
//   {previous}
//
// Both parsers are lenient the way the vault parser is: an unknown key is
// ignored, a malformed value falls back to a string, and the validators in
// @codecast/shared/contracts decide whether the result is usable.

import {
  splitModelEffortSuffix,
  type AgentChainSpec,
  type AgentChainStep,
  type AgentClientId,
  type AgentDefinitionSpec,
  type AgentDefinitionMode,
  type AgentPromptMode,
  parseExecutionAgentClientId,
} from "@codecast/shared/contracts";
import { splitFrontmatter } from "@codecast/shared/docs";
import { parseYamlSubset, toStringList } from "@codecast/shared/vault";

function frontmatterRecord(front: string): Record<string, unknown> {
  const lines = front.split("\n");
  // Drop the opening and closing fences.
  const inner = lines.slice(1, lines.length - 1).filter((l) => l.trim() !== "---");
  return parseYamlSubset(inner);
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "yes") return true;
    if (s === "false" || s === "no") return false;
  }
  return undefined;
}

function clientId(v: unknown): AgentClientId | undefined {
  const s = str(v);
  if (!s) return undefined;
  try {
    return parseExecutionAgentClientId(s.toLowerCase());
  } catch {
    return undefined;
  }
}

/** Parse a definition file. Claude Code's `isolation: worktree` and pi's
 *  `model: id:effort` both land in the row shape. */
export function parseAgentDefinitionFile(content: string, fallbackName?: string): AgentDefinitionSpec {
  const { front, body } = splitFrontmatter(content);
  const fm = front ? frontmatterRecord(front) : {};
  const agent = clientId(fm.agent ?? fm.backend);
  const { model, effort: suffixEffort } = splitModelEffortSuffix(str(fm.model), agent);
  const effort = str(fm.effort ?? fm.reasoning_effort ?? fm.thinking) ?? suffixEffort;
  const tools = toStringList(fm.tools ?? fm["allowed-tools"] ?? fm.allowedTools);
  const disallowed = toStringList(fm.disallowedTools ?? fm["disallowed-tools"] ?? fm.disallowed_tools);
  const promptMode = str(fm.prompt_mode ?? fm.promptMode) as AgentPromptMode | undefined;
  const modeRaw = str(fm.mode);
  const mode: AgentDefinitionMode | undefined =
    modeRaw === "propose" || modeRaw === "safe" || modeRaw === "read-only" ? "propose" : modeRaw === "apply" ? "apply" : undefined;
  const isolation = str(fm.isolation);
  const isolated = bool(fm.isolated) ?? (isolation === "worktree" ? true : undefined);
  const def: AgentDefinitionSpec = {
    name: str(fm.name) ?? fallbackName ?? "",
    description: str(fm.description) ?? "",
  };
  if (agent) def.agent = agent;
  if (model) def.model = model;
  if (effort) def.effort = effort;
  if (tools.length) def.tools = tools;
  if (disallowed.length) def.disallowed_tools = disallowed;
  const prompt = body.trim();
  if (prompt) def.system_prompt = prompt;
  if (promptMode === "append" || promptMode === "replace") def.prompt_mode = promptMode;
  if (mode) def.mode = mode;
  if (isolated !== undefined) def.isolated = isolated;
  return def;
}

function yamlValue(s: string): string {
  return /[:#\[\]{}",\n]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

export function serializeAgentDefinitionFile(def: AgentDefinitionSpec): string {
  const lines: string[] = ["---", `name: ${yamlValue(def.name)}`, `description: ${yamlValue(def.description)}`];
  if (def.agent) lines.push(`agent: ${def.agent}`);
  if (def.model) lines.push(`model: ${yamlValue(def.model)}`);
  if (def.effort) lines.push(`effort: ${def.effort}`);
  if (def.tools?.length) lines.push(`tools: ${def.tools.join(", ")}`);
  if (def.disallowed_tools?.length) lines.push(`disallowedTools: ${def.disallowed_tools.join(", ")}`);
  if (def.prompt_mode && def.prompt_mode !== "append") lines.push(`prompt_mode: ${def.prompt_mode}`);
  if (def.mode && def.mode !== "apply") lines.push(`mode: ${def.mode}`);
  if (def.isolated) lines.push("isolated: true");
  lines.push("---");
  const body = def.system_prompt?.trim();
  return `${lines.join("\n")}\n${body ? `\n${body}\n` : ""}`;
}

const STEP_HEADING_RE = /^##\s+([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/;

export function parseAgentChainFile(content: string, fallbackName?: string): AgentChainSpec {
  const { front, body } = splitFrontmatter(content);
  const fm = front ? frontmatterRecord(front) : {};
  const steps: AgentChainStep[] = [];
  let current: AgentChainStep | null = null;
  const buf: string[] = [];
  const flush = () => {
    if (current) {
      current.prompt = buf.join("\n").trim();
      steps.push(current);
    }
    buf.length = 0;
  };
  for (const line of body.split("\n")) {
    const m = STEP_HEADING_RE.exec(line.trim());
    if (m) {
      flush();
      current = { agent: m[1], prompt: "" };
      continue;
    }
    if (current) buf.push(line);
  }
  flush();
  return {
    name: str(fm.name) ?? fallbackName ?? "",
    description: str(fm.description) ?? "",
    steps,
  };
}

export function serializeAgentChainFile(chain: AgentChainSpec): string {
  const head = ["---", `name: ${yamlValue(chain.name)}`, `description: ${yamlValue(chain.description)}`, "---"].join("\n");
  const body = chain.steps.map((s) => `## ${s.agent}\n\n${s.prompt.trim()}\n`).join("\n");
  return `${head}\n\n${body}`;
}

/** A file is a chain when its body is nothing but `## step` sections. */
export function isAgentChainFile(content: string): boolean {
  const { body } = splitFrontmatter(content);
  const firstLine = body.split("\n").find((l) => l.trim());
  return !!firstLine && STEP_HEADING_RE.test(firstLine.trim());
}
