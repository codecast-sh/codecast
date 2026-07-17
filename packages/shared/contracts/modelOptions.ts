// Curated model/effort options per agent — the single source of truth for the
// web pickers, the Convex dispatch payloads, and the daemon's launch-flag
// mapping and /model-picker driving. PURE isomorphic data.
//
// Keys are stable wire values (what the web sends and the conversation row
// stores as the REQUESTED value); labels are what pickers render; menuMatch is
// matched by the daemon against the live Claude Code /model picker rows (the
// menu is dynamic — rows shift and the current model gains a ✔ — so selection
// is by parsed label, never by hardcoded row number); cliAlias is the launch
// flag value (`--model`/`-m`), absent for "default" (= omit the flag and let
// the agent's own saved default win).

export interface ModelOption {
  key: string;
  label: string;
  /** One-line picker description. */
  hint?: string;
  /** Regex source matched against a /model picker row label (claude only). */
  menuMatch?: string;
  /** Launch-flag value. Undefined = omit the flag ("default"). */
  cliAlias?: string;
  /** Only reachable via the in-place /model picker — hidden from new-session
   * pickers. (Sonnet 1M's launch alias is `sonnet[1m]`, which both the daemon's
   * arg allowlist and shell globbing reject; `--model sonnet-1m` silently
   * launches a bogus "custom model".) */
  midSessionOnly?: boolean;
}

export const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
  { key: "default", label: "Default", hint: "Your saved default model", menuMatch: "^Default\\b" },
  { key: "fable", label: "Fable", hint: "Most capable, ~2× limit burn", menuMatch: "^Fable\\b", cliAlias: "fable" },
  { key: "opus", label: "Opus", hint: "Best for everyday, complex tasks", menuMatch: "^Opus\\b", cliAlias: "opus" },
  { key: "sonnet", label: "Sonnet", hint: "Efficient for routine tasks", menuMatch: "^Sonnet(?!\\s*\\(1M)", cliAlias: "sonnet" },
  { key: "sonnet-1m", label: "Sonnet 1M", hint: "Sonnet with 1M context", menuMatch: "^Sonnet\\s*\\(1M", midSessionOnly: true },
  { key: "haiku", label: "Haiku", hint: "Fastest for quick answers", menuMatch: "^Haiku\\b", cliAlias: "haiku" },
];

// Claude Code's /model picker exposes exactly these four stops (←/→, wrapping).
// `/effort` accepts more (xhigh/auto) but persists a GLOBAL default, so the
// picker path — and therefore this list — is what mid-session switching uses.
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

export const CODEX_MODEL_OPTIONS: ModelOption[] = [
  { key: "default", label: "Default", hint: "Your config.toml model" },
  { key: "gpt-5.6-sol", label: "GPT-5.6 Sol", hint: "Latest frontier coding model", cliAlias: "gpt-5.6-sol" },
  { key: "gpt-5.6-terra", label: "GPT-5.6 Terra", hint: "Balanced model for everyday work", cliAlias: "gpt-5.6-terra" },
  { key: "gpt-5.6-luna", label: "GPT-5.6 Luna", hint: "Fast, affordable coding model", cliAlias: "gpt-5.6-luna" },
  { key: "gpt-5.5", label: "GPT-5.5", hint: "Frontier model for complex work", cliAlias: "gpt-5.5" },
  { key: "gpt-5.4", label: "GPT-5.4", hint: "Strong model for everyday coding", cliAlias: "gpt-5.4" },
  { key: "gpt-5.4-mini", label: "GPT-5.4 Mini", hint: "Small, fast, cost-efficient", cliAlias: "gpt-5.4-mini" },
  { key: "gpt-5.3-codex-spark", label: "Codex Spark", hint: "Ultra-fast coding model", cliAlias: "gpt-5.3-codex-spark" },
];

export const CODEX_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type CodexEffortLevel = (typeof CODEX_EFFORT_LEVELS)[number];

// Per-agent capability map, keyed by the daemon agent type. Web agent_type
// ("claude_code") maps via modelAgentKey below. Agents without an entry
// (cursor, gemini) get no model/effort UI.
export const AGENT_MODEL_CONFIG: Record<
  string,
  { models: ModelOption[]; efforts: readonly string[]; midSession: boolean }
> = {
  // midSession: the daemon can switch a RUNNING session (claude: drive the
  // /model picker session-only). Codex's /model is interactive-only, so codex
  // model/effort apply at launch (start/restart) but not in place.
  claude: { models: CLAUDE_MODEL_OPTIONS, efforts: CLAUDE_EFFORT_LEVELS, midSession: true },
  codex: { models: CODEX_MODEL_OPTIONS, efforts: CODEX_EFFORT_LEVELS, midSession: false },
};

/** Web/conversation agent_type → AGENT_MODEL_CONFIG key (claude_code → claude). */
export function modelAgentKey(agentType: string | undefined): string {
  return agentType === "codex" || agentType === "cursor" || agentType === "gemini"
    ? agentType
    : "claude";
}

export function findModelOption(agentType: string | undefined, key: string): ModelOption | undefined {
  return AGENT_MODEL_CONFIG[modelAgentKey(agentType)]?.models.find((m) => m.key === key);
}

/**
 * Stored model id → picker option key ("claude-opus-4-8" → "opus"). The inverse
 * direction of cliAlias: the conversation row stores the full model id, but the
 * pickers, the Cmd+K menu, and the launch-flag path all key off the option key.
 * Falls back to "default" when nothing matches (e.g. a claude model id read back
 * under the codex agent after an agent switch).
 */
export function modelOptionKey(model: string | undefined | null, agentType: string | undefined): string {
  const cfg = AGENT_MODEL_CONFIG[modelAgentKey(agentType)];
  if (!model || !cfg) return "default";
  const bare = model.startsWith("claude-") ? model.slice("claude-".length) : model;
  // Exact match wins over a versioned-prefix match so a longer key ("gpt-5.4-mini")
  // isn't swallowed by a shorter one that prefixes it ("gpt-5.4"); the prefix pass
  // then resolves "opus-4-8" → "opus".
  const hit =
    cfg.models.find((m) => m.key !== "default" && bare === m.key) ??
    cfg.models.find((m) => m.key !== "default" && bare.startsWith(`${m.key}-`));
  return hit?.key ?? "default";
}
