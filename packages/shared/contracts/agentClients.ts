// The agent-client registry: one descriptor per supported CLI client, plus the
// single named id type and the one place the daemon/convex spelling translation
// lives. PURE isomorphic data (no Node or DOM APIs) so the Convex runtime, the
// Node daemon, and the browser can all import it.
//
// Before this module the daemon repeated the inline union
// `"claude" | "codex" | "cursor" | "gemini"` across ~20 signatures and translated
// the convex spelling (`claude_code` ↔ `claude`) ad hoc at each boundary. Here the
// union has one name (`AgentClientId`), the translation has one home
// (`to/fromConvexAgentType`), and every per-client fact the daemon hardcoded
// (binary, resume command, transcript root, watcher kind, tmux prefix, model
// config) is a single registry entry (`AGENT_CLIENTS`).
//
// Phase 0 is a pure extraction — no runtime branching moves here yet. The
// function-valued descriptor fields the daemon owns (`parseTranscript`,
// `classifyTail`) are typed but left unset so shared stays free of daemon types;
// later phases wire them up and fold the daemon's branch sites into registry
// lookups.

import type { ModelOption } from "./modelOptions";
import {
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  CLAUDE_EFFORT_LEVELS,
  CODEX_EFFORT_LEVELS,
} from "./modelOptions";

/** The single named union for a supported agent CLI client — the daemon's
 *  agent-type spelling and the registry key. */
export type AgentClientId = "claude" | "codex" | "cursor" | "gemini";

/** The spelling the Convex schema / wire protocol stores (`conversations.agent_type`).
 *  Differs from `AgentClientId` only in `claude_code`, and carries the extra
 *  `cowork` value that has no distinct client of its own. */
export type ConvexAgentType = "claude_code" | "codex" | "cursor" | "gemini" | "cowork";

const CONVEX_BY_ID: Record<AgentClientId, ConvexAgentType> = {
  claude: "claude_code",
  codex: "codex",
  cursor: "cursor",
  gemini: "gemini",
};

/** Client id → Convex spelling (`claude` → `claude_code`). */
export function toConvexAgentType(id: AgentClientId): ConvexAgentType {
  return CONVEX_BY_ID[id];
}

/**
 * Convex spelling → client id (`claude_code` → `claude`). Permissive: accepts the
 * daemon spelling, `cowork`, `undefined`, and any unknown value, all of which
 * normalize to `claude` — matching the historic `modelAgentKey` fallback so the
 * model helpers can route through this one function without a behavior change.
 */
export function fromConvexAgentType(agentType: string | null | undefined): AgentClientId {
  switch (agentType) {
    case "codex":
      return "codex";
    case "cursor":
      return "cursor";
    case "gemini":
      return "gemini";
    default:
      return "claude";
  }
}

/** Model/effort picker config for a client (the old `AGENT_MODEL_CONFIG` value). */
export interface AgentModelConfig {
  models: ModelOption[];
  efforts: readonly string[];
  /** The daemon can switch the model of a RUNNING session in place (claude drives
   *  the /model picker; codex's /model is interactive-only, so it applies at
   *  launch only). */
  midSession: boolean;
}

/** How the daemon tails a client's transcripts on disk. `json-store` is reserved
 *  for later clients (e.g. OpenCode's session/message/part store). */
export type AgentWatcherKind = "jsonl-dir" | "json-store" | "sqlite";

/** Opt-in, non-model capabilities. A missing capability means the feature is
 *  simply absent for that client, never that the session breaks. */
export interface AgentClientCapabilities {
  /** The daemon watches the tmux pane for structured prompts (permission /
   *  AskUserQuestion) for this client. */
  panePromptMonitoring: boolean;
}

/** Everything the daemon, convex, and web need to know about one client. */
export interface AgentClientDescriptor {
  /** Stable internal id — the daemon's agent-type spelling and the registry key. */
  id: AgentClientId;
  /** The spelling the Convex schema / wire protocol uses. */
  convexId: ConvexAgentType;
  /** Executable launched to start a fresh session. */
  binary: string;
  /** Static args always passed at launch, before the conditional permission /
   *  model / effort flags the daemon appends. Empty for every current client. */
  launchArgs: string[];
  /** Base command that resumes an existing session — the daemon appends
   *  model / permission / effort flags around it. */
  resumeCmd(sessionId: string): string;
  /** Home-relative roots the client writes transcripts under. */
  transcriptRoots: string[];
  /** How the daemon tails this client's transcripts. */
  watcherKind: AgentWatcherKind;
  /**
   * Regex that marks the interactive prompt as ready in a tmux pane. Each entry
   * carries the code-derived pattern from the daemon's PER-CLIENT fresh-launch
   * ternary (daemon.ts:11989) verbatim — that is the site ct-39077 wires from the
   * registry. BEWARE: the daemon has a SECOND, disagreeing readiness check — a
   * shared `/[❯›]/` regex used by every other path (resume readiness
   * daemon.ts:11251, picker probes daemon.ts:2754 / :8172). The two do not agree
   * (e.g. codex: shared uses the `›` glyph, fresh-launch uses ASCII `>` anchored
   * at line end), so ct-39077 must reconcile BOTH call sites, not trust this field
   * alone. Per-client verbatim values are quoted on each descriptor below.
   */
  promptReadyPattern: RegExp;
  /** Prefix for the tmux session names the daemon's resume path creates. */
  tmuxPrefix: string;
  /** Model/effort picker config, or undefined for clients with no model UI. */
  modelConfig?: AgentModelConfig;
  /** Non-model capabilities that are opt-in per client. */
  capabilities: AgentClientCapabilities;
  /** Parse a raw transcript blob into the daemon's ParsedMessage[] shape. Wired up
   *  by the daemon (cli package); typed loosely and optional so shared stays free
   *  of daemon types and the descriptor is usable without it. */
  parseTranscript?: (raw: string) => unknown[];
  /** Classify the transcript tail into the daemon's TranscriptTurnState. Wired up
   *  by the daemon; optional for the same reason. */
  classifyTail?: (raw: string) => unknown;
}

const CLAUDE_MODEL: AgentModelConfig = {
  models: CLAUDE_MODEL_OPTIONS,
  efforts: CLAUDE_EFFORT_LEVELS,
  midSession: true,
};
const CODEX_MODEL: AgentModelConfig = {
  models: CODEX_MODEL_OPTIONS,
  efforts: CODEX_EFFORT_LEVELS,
  midSession: false,
};

/**
 * The four supported clients, populated from the facts currently hardcoded across
 * the daemon (binaries, resume commands, transcript roots, watcher kinds, tmux
 * prefixes, prompt-ready glyphs). Nothing consumes the registry at runtime yet —
 * ct-39077 folds the daemon's branch sites into lookups against these entries.
 */
export const AGENT_CLIENTS: Record<AgentClientId, AgentClientDescriptor> = {
  claude: {
    id: "claude",
    convexId: "claude_code",
    binary: "claude",
    launchArgs: [],
    resumeCmd: (sessionId) => `claude --resume ${sessionId}`,
    transcriptRoots: ["~/.claude/projects"],
    watcherKind: "jsonl-dir",
    // Fresh-launch site (daemon.ts:11989) else-branch, verbatim: /❯|⏵/ ("Claude:
    // ❯ or ⏵"). The shared readiness path (daemon.ts:11251 etc.) instead uses
    // /[❯›]/ — agrees on ❯ but not ⏵.
    promptReadyPattern: /❯|⏵/,
    tmuxPrefix: "cc",
    modelConfig: CLAUDE_MODEL,
    capabilities: { panePromptMonitoring: true },
  },
  codex: {
    id: "codex",
    convexId: "codex",
    binary: "codex",
    launchArgs: [],
    resumeCmd: (sessionId) => `codex resume ${sessionId}`,
    transcriptRoots: ["~/.codex/sessions"],
    watcherKind: "jsonl-dir",
    // Fresh-launch site (daemon.ts:11989) codex branch, verbatim: />\s*$/ (ASCII
    // `>` anchored at line end). DISAGREES with the shared readiness path
    // (daemon.ts:11251 etc.), which matches the `›` glyph via /[❯›]/. ct-39077
    // must decide which codex actually renders before collapsing the two.
    promptReadyPattern: />\s*$/,
    tmuxPrefix: "cx",
    modelConfig: CODEX_MODEL,
    capabilities: { panePromptMonitoring: true },
  },
  cursor: {
    id: "cursor",
    convexId: "cursor",
    binary: "cursor-agent",
    launchArgs: [],
    // cursor-agent resumes a chat by id with its own binary (the ct-39074 fix): a
    // cursor session must never fall through to `claude --resume` + Claude's repair
    // machinery. Consumed by buildNonClaudeResumeCommand (resumeCommand.ts).
    resumeCmd: (sessionId) => `cursor-agent --resume ${sessionId}`,
    // The daemon actually reads cursor transcripts from a platform-specific SQLite
    // store (the Cursor app-support workspaceStorage), not a home dir; this root
    // is provisional pending the sqlite-watcher wire-up (ct-39077).
    transcriptRoots: ["~/.cursor/chats"],
    watcherKind: "sqlite",
    // Provisional: cursor has NO dedicated readiness pattern in the daemon. At the
    // fresh-launch site (daemon.ts:11989) it falls through the else branch and
    // reuses claude's /❯|⏵/; the shared readiness path uses /[❯›]/. Recorded here
    // as the fresh-launch else value — ct-39077 should confirm cursor's real glyph
    // when it wires readiness.
    promptReadyPattern: /❯|⏵/,
    // cursor resume panes get their own `cu-` prefix (the ct-39074 fix) so they
    // never collide with claude's `cc-`. Consumed by resumeTmuxPrefix.
    tmuxPrefix: "cu",
    capabilities: { panePromptMonitoring: false },
  },
  gemini: {
    id: "gemini",
    convexId: "gemini",
    binary: "gemini",
    launchArgs: [],
    // gemini resumes the most-recent session and ignores the id (daemon fact).
    resumeCmd: () => `gemini --resume latest`,
    transcriptRoots: ["~/.gemini/tmp"],
    watcherKind: "jsonl-dir",
    // Fresh-launch site (daemon.ts:11989) gemini branch, verbatim: />\s*$|gemini/i
    // (ASCII `>` at line end, or the word "gemini"). The shared readiness path
    // (/[❯›]/) matches NEITHER of these, so gemini launch-readiness detection
    // depends entirely on which site ct-39077 wires — this is the one the
    // per-client code actually uses at launch.
    promptReadyPattern: />\s*$|gemini/i,
    tmuxPrefix: "gm",
    capabilities: { panePromptMonitoring: false },
  },
};

// ── Model helpers ─────────────────────────────────────────────────────────────
// These live here (with the registry) rather than in modelOptions.ts so the
// registry stays the single source of truth and the module graph is acyclic
// (modelOptions.ts holds only the raw option arrays and imports nothing back).

/**
 * Per-client model/effort config — a thin view over the registry, keyed by client
 * id. Clients without a `modelConfig` (cursor, gemini) are absent, exactly as
 * before; consumers guard with `?.`. Typed `Record<string, …>` (not `Partial`) to
 * preserve the pre-existing call-site typing.
 */
export const AGENT_MODEL_CONFIG: Record<string, AgentModelConfig> = Object.fromEntries(
  (Object.entries(AGENT_CLIENTS) as [AgentClientId, AgentClientDescriptor][])
    .filter(([, d]) => d.modelConfig)
    .map(([id, d]) => [id, d.modelConfig as AgentModelConfig]),
);

/** Web/conversation agent_type → registry client id (claude_code → claude). */
export function modelAgentKey(agentType: string | undefined): AgentClientId {
  return fromConvexAgentType(agentType);
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
