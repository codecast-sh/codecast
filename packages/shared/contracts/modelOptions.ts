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

// The per-client model config (AGENT_MODEL_CONFIG) and the model helpers
// (modelAgentKey / findModelOption / modelOptionKey) now live in ./agentClients
// alongside the client registry they read from. This file holds only the raw
// option arrays so the module graph stays acyclic (agentClients imports these;
// this file imports nothing back). They remain re-exported from
// @codecast/shared/contracts, so consumers are unaffected.
