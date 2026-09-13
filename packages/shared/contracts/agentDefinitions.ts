// Agent definitions and chains: the one named object that binds a client, a
// model, an effort, a tool policy and a system prompt, so every launch surface
// (cast exec, cast spawn, triggers, the DOT workflow runner, the web compose
// flow) can say "run this as reviewer" instead of repeating the flag triple.
//
// A definition is stored as a workspace row (convex `agent_definitions`) and
// travels as a markdown file with frontmatter, the shape pi's subagent
// extension and Claude Code's ~/.claude/agents already use (see
// @codecast/shared/agents for the file form). This module is the pure part:
// the row shape, validation, and the resolution of a definition plus caller
// overrides into the launch inputs the per-client argv builders take.
//
// A chain is an ordered list of steps, each naming a definition and a prompt
// template. `{task}` is the chain's input and `{previous}` is the prior step's
// final output; a step's prompt with neither placeholder gets the previous
// output appended, so a chain never silently drops context.

import { AGENT_MODEL_CONFIG, findModelOption, modelAgentKey, type AgentClientId } from "./agentClients";

export const AGENT_DEFINITION_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_AGENT_DEFINITION_NAME = 40;
export const MAX_AGENT_DEFINITION_DESCRIPTION = 500;
export const MAX_AGENT_SYSTEM_PROMPT = 32_000;
export const MAX_CHAIN_STEPS = 12;

/** How the definition's prompt combines with the client's own system prompt. */
export type AgentPromptMode = "append" | "replace";

/** What a definition may do in the tree: `apply` acts, `propose` is read only
 *  (the trigger `--safe` fence: write tools removed, mutating commands denied). */
export type AgentDefinitionMode = "apply" | "propose";

export interface AgentDefinitionSpec {
  /** [a-z0-9-], unique inside the workspace. The `--as` value. */
  name: string;
  description: string;
  /** Registry client id. Absent = the caller's client (the parent session's,
   *  or the surface's default). */
  agent?: AgentClientId;
  /** Picker key or raw id for that client (`opus`, `gpt-5.5`, `anthropic/x`). */
  model?: string;
  /** The client's effort stop. pi's `--thinking` levels ride this slot. */
  effort?: string;
  /** Tool allowlist by native tool name (claude `--allowedTools`, pi `--tools`). */
  tools?: string[];
  /** Tool denylist (claude `--disallowedTools`); a `propose` definition adds
   *  the safe mode deny rules on top. */
  disallowed_tools?: string[];
  /** The body of the file: the role's instructions. */
  system_prompt?: string;
  prompt_mode?: AgentPromptMode;
  mode?: AgentDefinitionMode;
  /** Start in its own git worktree. */
  isolated?: boolean;
}

export interface AgentChainStep {
  /** A definition name. */
  agent: string;
  /** Prompt template: `{task}` = the chain input, `{previous}` = prior output. */
  prompt: string;
}

export interface AgentChainSpec {
  name: string;
  description: string;
  steps: AgentChainStep[];
}

export const CHAIN_TASK_PLACEHOLDER = "{task}";
export const CHAIN_PREVIOUS_PLACEHOLDER = "{previous}";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateAgentDefinitionName(name: string): string | null {
  if (!name) return "name is required";
  if (name.length > MAX_AGENT_DEFINITION_NAME) return `name is longer than ${MAX_AGENT_DEFINITION_NAME} characters`;
  if (!AGENT_DEFINITION_NAME_RE.test(name)) return "name must be lowercase letters, digits and single hyphens";
  return null;
}

/** Every problem with a definition, in order; empty when it is launchable. */
export function validateAgentDefinition(def: AgentDefinitionSpec): string[] {
  const problems: string[] = [];
  const nameProblem = validateAgentDefinitionName(def.name);
  if (nameProblem) problems.push(nameProblem);
  if (!def.description?.trim()) problems.push("description is required");
  else if (def.description.length > MAX_AGENT_DEFINITION_DESCRIPTION) problems.push(`description is longer than ${MAX_AGENT_DEFINITION_DESCRIPTION} characters`);
  if (def.agent && !AGENT_MODEL_CONFIG[modelAgentKey(def.agent)]) problems.push(`unknown agent "${def.agent}"`);
  if (def.model && def.agent && def.model !== "default" && !findModelOption(def.agent, def.model)) {
    problems.push(`model "${def.model}" is not a ${def.agent} model`);
  }
  if (def.effort && def.agent) {
    const efforts = AGENT_MODEL_CONFIG[modelAgentKey(def.agent)]?.efforts ?? [];
    if (efforts.length > 0 && !(efforts as readonly string[]).includes(def.effort)) {
      problems.push(`effort "${def.effort}" is not a ${def.agent} level (${(efforts as readonly string[]).join(", ")})`);
    }
  }
  if (def.system_prompt && def.system_prompt.length > MAX_AGENT_SYSTEM_PROMPT) problems.push(`system prompt is longer than ${MAX_AGENT_SYSTEM_PROMPT} characters`);
  if (def.prompt_mode && def.prompt_mode !== "append" && def.prompt_mode !== "replace") problems.push(`prompt_mode must be append or replace`);
  if (def.mode && def.mode !== "apply" && def.mode !== "propose") problems.push(`mode must be apply or propose`);
  return problems;
}

export function validateAgentChain(chain: AgentChainSpec, knownDefinitions?: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const nameProblem = validateAgentDefinitionName(chain.name);
  if (nameProblem) problems.push(nameProblem);
  if (!chain.steps?.length) problems.push("a chain needs at least one step");
  else if (chain.steps.length > MAX_CHAIN_STEPS) problems.push(`a chain may have at most ${MAX_CHAIN_STEPS} steps`);
  chain.steps?.forEach((step, i) => {
    const stepName = validateAgentDefinitionName(step.agent);
    if (stepName) problems.push(`step ${i + 1}: agent ${stepName}`);
    else if (knownDefinitions && !knownDefinitions.has(step.agent)) problems.push(`step ${i + 1}: no definition named "${step.agent}"`);
    if (!step.prompt?.trim()) problems.push(`step ${i + 1}: prompt is required`);
  });
  return problems;
}

// ---------------------------------------------------------------------------
// Model strings
// ---------------------------------------------------------------------------

/** pi writes `model: claude-sonnet-4-5:high`; Claude Code writes `model: sonnet`.
 *  Split a trailing `:<effort>` off when it is a real effort stop for the
 *  client, so one string can carry both through any interface with one slot. */
export function splitModelEffortSuffix(
  raw: string | undefined,
  agent: AgentClientId | undefined,
): { model?: string; effort?: string } {
  if (!raw) return {};
  const idx = raw.lastIndexOf(":");
  if (idx <= 0) return { model: raw };
  const efforts = (AGENT_MODEL_CONFIG[modelAgentKey(agent)]?.efforts ?? []) as readonly string[];
  const suffix = raw.slice(idx + 1);
  if (efforts.includes(suffix)) return { model: raw.slice(0, idx), effort: suffix };
  return { model: raw };
}

// ---------------------------------------------------------------------------
// Resolution: definition + caller overrides -> launch inputs
// ---------------------------------------------------------------------------

export interface AgentLaunchOverrides {
  agent?: AgentClientId;
  model?: string;
  effort?: string;
}

/** The launch facts every surface consumes. Model is the picker key or raw id
 *  (each surface turns it into the client alias with resolvePrintModelAlias /
 *  findModelOption); tools are native names for the resolved client. */
export interface ResolvedAgentLaunch {
  agent: AgentClientId;
  model?: string;
  effort?: string;
  tools?: string[];
  disallowedTools?: string[];
  systemPrompt?: string;
  appendSystemPrompt?: string;
  mode: AgentDefinitionMode;
  isolated: boolean;
  /** Definition facts the resolved client cannot honor, for a one line warning. */
  dropped: string[];
}

/** Explicit flags win over the definition, the definition wins over the
 *  surface default. A model pinned by the definition is dropped when the
 *  caller forces a different client it does not fit. */
export function resolveAgentLaunch(
  def: AgentDefinitionSpec | undefined,
  overrides: AgentLaunchOverrides,
  fallbackAgent: AgentClientId,
): ResolvedAgentLaunch {
  const agent = overrides.agent ?? def?.agent ?? fallbackAgent;
  const dropped: string[] = [];
  let model = overrides.model;
  if (!model && def?.model) {
    const fits = def.model === "default" || !!findModelOption(agent, def.model);
    if (fits) model = def.model;
    else dropped.push(`model ${def.model} (not a ${agent} model)`);
  }
  let effort = overrides.effort;
  if (!effort && def?.effort) {
    const efforts = (AGENT_MODEL_CONFIG[modelAgentKey(agent)]?.efforts ?? []) as readonly string[];
    if (efforts.length === 0) dropped.push(`effort ${def.effort} (${agent} has no effort flag)`);
    else if (!efforts.includes(def.effort)) dropped.push(`effort ${def.effort} (not a ${agent} level)`);
    else effort = def.effort;
  }
  const promptMode: AgentPromptMode = def?.prompt_mode ?? "append";
  const prompt = def?.system_prompt?.trim() || undefined;
  return {
    agent,
    model: model === "default" ? undefined : model,
    effort,
    tools: def?.tools?.length ? def.tools : undefined,
    disallowedTools: def?.disallowed_tools?.length ? def.disallowed_tools : undefined,
    systemPrompt: promptMode === "replace" ? prompt : undefined,
    appendSystemPrompt: promptMode === "append" ? prompt : undefined,
    mode: def?.mode ?? "apply",
    isolated: def?.isolated === true,
    dropped,
  };
}

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------

/** Fill a step's template. A template with no `{previous}` still receives the
 *  prior output, appended under a heading, so a chain never drops a step. */
export function renderChainStepPrompt(template: string, input: { task: string; previous?: string }): string {
  let out = template.split(CHAIN_TASK_PLACEHOLDER).join(input.task);
  if (input.previous !== undefined) {
    if (out.includes(CHAIN_PREVIOUS_PLACEHOLDER)) {
      out = out.split(CHAIN_PREVIOUS_PLACEHOLDER).join(input.previous);
    } else {
      out = `${out.trimEnd()}\n\n## Previous step\n\n${input.previous}`;
    }
  } else {
    out = out.split(CHAIN_PREVIOUS_PLACEHOLDER).join("");
  }
  return out;
}
