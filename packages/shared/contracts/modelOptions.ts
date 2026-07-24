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

// OpenCode addresses models as `provider/model` (its `-m` launch flag and the
// `providerID`/`modelID` pair every message stores). The picker offers "Default"
// (omit the flag; opencode uses its configured default) plus a small honest set
// of common frontier models across the providers opencode ships with. cliAlias is
// the full `provider/model` value passed to `opencode -m`. There is no scriptable
// mid-session model picker (the TUI's /models is interactive-only), so midSession
// is false — the model is chosen at launch and tracked from the transcript after.
export const OPENCODE_MODEL_OPTIONS: ModelOption[] = [
  { key: "default", label: "Default", hint: "Your opencode configured model" },
  { key: "opus", label: "Claude Opus", hint: "Anthropic's most capable model", cliAlias: "anthropic/claude-opus-4-8" },
  { key: "sonnet", label: "Claude Sonnet", hint: "Efficient for routine tasks", cliAlias: "anthropic/claude-sonnet-5" },
  { key: "gpt-5", label: "GPT-5", hint: "OpenAI frontier model", cliAlias: "openai/gpt-5" },
  { key: "gemini", label: "Gemini 2.5 Pro", hint: "Google frontier model", cliAlias: "google/gemini-2.5-pro" },
];

// OpenCode has no codex-style reasoning-effort launch flag, so the effort list is
// empty and the picker shows no effort control.
export const OPENCODE_EFFORT_LEVELS = [] as const;

// pi addresses models as `provider/model` too (`--model`, fuzzy patterns accepted
// but we always pass the exact id). Curation comes from the live inventory; the
// static list is just the "Default" stop for devices that haven't reported one.
export const PI_MODEL_OPTIONS: ModelOption[] = [
  { key: "default", label: "Default", hint: "pi's configured default model" },
];

// pi's `--thinking` levels map onto the effort slot (same launch-flag shape as
// codex's reasoning effort). "off" is a real stop, distinct from "default"
// (= omit the flag, pi decides).
export const PI_EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type PiEffortLevel = (typeof PI_EFFORT_LEVELS)[number];

// ---------------------------------------------------------------------------
// Dynamic model inventory (opencode / pi)
//
// Aggregator clients expose hundreds of `provider/model` ids whose availability
// is a per-device fact (which API keys / logins exist there). The daemon
// collects each client's own listing (`opencode models`, `pi --list-models`),
// heartbeats it up only when it changes, and the pickers render from it. The
// wire key for such a model IS the `provider/model` string — findModelOption
// synthesizes the option, so web display, convex dispatch validation, and the
// daemon's launch flags all accept it without any per-layer allowlist.
// ---------------------------------------------------------------------------

/** Per-device model inventory, heartbeat-reported and stored on the devices row. */
export interface DeviceModelInventory {
  /** Stable hash of `clients` — the daemon resends and the server rewrites only
   *  when it changes. */
  hash: string;
  collected_at: number;
  clients: { opencode?: string[]; pi?: string[] };
}

// Conservative shape for a dynamic model key: `provider/model` (aggregators nest,
// e.g. openrouter/anthropic/claude-sonnet-5). The charset is a subset of the
// daemon's SAFE_ARG_RE launch-arg allowlist, so a synthesized cliAlias can never
// smuggle shell metacharacters into the tmux launch line.
const DYNAMIC_MODEL_KEY_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-zA-Z0-9._:@-]+)+$/;

export function isDynamicModelKey(key: string): boolean {
  return (
    key.length <= 120 &&
    DYNAMIC_MODEL_KEY_RE.test(key) &&
    // No dot-only segments — the key never touches a filesystem, but a
    // traversal-shaped id has no business round-tripping as a model either.
    !key.split("/").some((s) => /^\.+$/.test(s))
  );
}

const MODEL_WORD_CASING: Record<string, string> = {
  gpt: "GPT", glm: "GLM", ai: "AI", llm: "LLM", deepseek: "DeepSeek",
  qwen: "Qwen", oss: "OSS", tts: "TTS", vl: "VL",
};

/** "claude-sonnet-5" → "Claude Sonnet 5", "gpt-5.2" → "GPT 5.2",
 * "claude-haiku-4-5-20251001" → "Claude Haiku 4.5" (dash version runs join with
 * dots, date pins drop from the label — the key keeps the exact id). */
export function prettifyModelId(id: string): string {
  const words = id.split(/[-\s]+/).filter((w) => !/^\d{8}$/.test(w));
  const merged: string[] = [];
  for (const w of words) {
    if (/^\d+$/.test(w) && /^\d+(\.\d+)*$/.test(merged[merged.length - 1] ?? "")) {
      merged[merged.length - 1] += `.${w}`;
    } else {
      merged.push(w);
    }
  }
  return merged
    .map((w) => MODEL_WORD_CASING[w.toLowerCase()] ?? (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Synthesize the picker/dispatch/launch option for a `provider/model` key. */
export function dynamicModelOption(key: string): ModelOption {
  const segments = key.split("/");
  return {
    key,
    label: prettifyModelId(segments[segments.length - 1]),
    hint: `via ${segments.slice(0, -1).join("/")}`,
    cliAlias: key,
  };
}

// Featured families for the picker head: matched against the live inventory so
// the shortlist tracks what the device can actually run. Within a family the
// best id wins: direct provider over aggregator (fewer path segments), then
// highest embedded version. Ids with pin/variant suffixes (@date, :free, -fast)
// never make the head — they stay reachable through search.
const FEATURED_MODEL_FAMILIES: { match: RegExp }[] = [
  { match: /(^|\/)claude-sonnet[-.\d]*$/ },
  { match: /(^|\/)claude-opus[-.\d]*$/ },
  { match: /(^|\/)claude-haiku[-.\d]*$/ },
  { match: /(^|\/)gpt[-.\d]+$/ },
  { match: /(^|\/)gemini[-.\d]*(-pro)?$/ },
];

/** Numeric version tokens of the model segment, for descending comparison.
 * Date pins (8-digit tokens) are ignored so "claude-sonnet-4-20250514" ranks as
 * version [4], below "claude-sonnet-4-5" ([4,5]). */
function versionScore(id: string): number[] {
  const tail = id.split("/").pop() ?? id;
  return (tail.match(/\d+/g) ?? []).filter((t) => t.length < 8).map(Number);
}

function compareVersionDesc(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? -1) - (a[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/** The curated head of a dynamic picker: best available id per featured family. */
export function featuredModelOptions(inventory: string[]): ModelOption[] {
  const clean = inventory.filter((id) => isDynamicModelKey(id) && !/[@:]|-fast$|-latest$/.test(id));
  const out: ModelOption[] = [];
  for (const family of FEATURED_MODEL_FAMILIES) {
    const best = clean
      .filter((id) => family.match.test(id))
      .sort((a, b) => {
        const depth = a.split("/").length - b.split("/").length;
        if (depth !== 0) return depth;
        const version = compareVersionDesc(versionScore(a), versionScore(b));
        if (version !== 0) return version;
        // Equal version: the shorter id wins (undated over date-pinned,
        // "google/…" over "google-vertex/…").
        return a.length - b.length || a.localeCompare(b);
      })[0];
    if (best && !out.some((o) => o.key === best)) out.push(dynamicModelOption(best));
  }
  return out;
}

// The per-client model config (AGENT_MODEL_CONFIG) and the model helpers
// (modelAgentKey / findModelOption / modelOptionKey) now live in ./agentClients
// alongside the client registry they read from. This file holds only the raw
// option arrays so the module graph stays acyclic (agentClients imports these;
// this file imports nothing back). They remain re-exported from
// @codecast/shared/contracts, so consumers are unaffected.
