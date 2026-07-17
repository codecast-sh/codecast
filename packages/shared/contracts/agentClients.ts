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
  OPENCODE_MODEL_OPTIONS,
  CLAUDE_EFFORT_LEVELS,
  CODEX_EFFORT_LEVELS,
  OPENCODE_EFFORT_LEVELS,
} from "./modelOptions";

/** The single named union for a supported agent CLI client — the daemon's
 *  agent-type spelling and the registry key. */
export type AgentClientId = "claude" | "codex" | "cursor" | "gemini" | "opencode" | "pi";

/** The spelling the Convex schema / wire protocol stores (`conversations.agent_type`).
 *  Differs from `AgentClientId` only in `claude_code`, and carries the extra
 *  `cowork` value that has no distinct client of its own. `opencode` (phase 1)
 *  and `pi` (phase 2) are first-class clients with their own descriptors. */
export type ConvexAgentType =
  | "claude_code"
  | "codex"
  | "cursor"
  | "gemini"
  | "cowork"
  | "opencode"
  | "pi";

const CONVEX_BY_ID: Record<AgentClientId, ConvexAgentType> = {
  claude: "claude_code",
  codex: "codex",
  cursor: "cursor",
  gemini: "gemini",
  opencode: "opencode",
  pi: "pi",
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
 *
 * `opencode` (phase 1) and `pi` (phase 2) are first-class clients with their own
 * descriptors and map to themselves; everything unrecognized falls through the
 * `default` case to `claude`.
 */
export function fromConvexAgentType(agentType: string | null | undefined): AgentClientId {
  switch (agentType) {
    case "codex":
      return "codex";
    case "cursor":
      return "cursor";
    case "gemini":
      return "gemini";
    case "opencode":
      return "opencode";
    case "pi":
      return "pi";
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
  /** codecast can branch a conversation from a message into a LIVE session that
   *  actually carries the copied history: claude/codex via a local JSONL copy,
   *  opencode via its serve sidecar (`forkApi`). Absent for clients with no fork
   *  mechanism (cursor, gemini, pi) — there the server-side message copy would
   *  render a full transcript the live agent has no context for, so the fork UI
   *  must be HIDDEN (honest absence), never shown as a false success. Broader than
   *  `forkApi`, which is specifically opencode's HTTP fork endpoint. */
  fork?: boolean;
  /** The client exposes a fork-by-session-id API the daemon can call to branch a
   *  session (opencode's `POST /session/:id/fork` via an `opencode serve` sidecar —
   *  see opencodeServer.ts). Gates the daemon's API-fork branch; without a reachable
   *  server the client simply can't fork here (honest degradation), NOT a fallback
   *  to claude-style transcript-file copying. */
  forkApi?: boolean;
  /** The client can stream live structured events (state / permissions) over a
   *  richer transport the daemon attaches to, accelerating work-state past DB/tail
   *  polling. Opt-in and additive: the plain transcript path stays authoritative for
   *  content and keeps working when the transport is absent. For opencode this is
   *  bounded — the serve /event bus is per-process, so it accelerates only sessions
   *  DRIVEN THROUGH the sidecar, not tmux-TUI sessions (see opencodeServer.ts). */
  liveEvents?: boolean;
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
const OPENCODE_MODEL: AgentModelConfig = {
  models: OPENCODE_MODEL_OPTIONS,
  efforts: OPENCODE_EFFORT_LEVELS,
  // The TUI's /models picker is interactive-only (no scriptable menu like
  // Claude's), so opencode's model is a launch-time choice, tracked from the
  // transcript thereafter.
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
    capabilities: { panePromptMonitoring: true, fork: true },
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
    capabilities: { panePromptMonitoring: true, fork: true },
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
    // The daemon reads cursor transcripts from a platform-specific SQLite store
    // (the Cursor app-support workspaceStorage), not a home dir, via its own
    // CursorWatcher/CursorTranscriptWatcher (watcherKind "sqlite"). Those stay their
    // own kind — only the jsonl-dir watchers (codex/gemini) share the generic
    // TranscriptDirWatcher — so this home-relative root is not consumed today.
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
  opencode: {
    id: "opencode",
    convexId: "opencode",
    binary: "opencode",
    launchArgs: [],
    // opencode resumes a session by id with `opencode -s <id>` (verified against
    // `opencode run --help`: `-s, --session  session id to continue`). Consumed by
    // buildNonClaudeResumeCommand (resumeCommand.ts).
    resumeCmd: (sessionId) => `opencode -s ${sessionId}`,
    // Current opencode (v1.2.0+; verified on v1.18.3) stores every session in one
    // SQLite database — ~/.local/share/opencode/opencode.db (session/message/part
    // tables) — NOT the legacy storage/ JSON tree older builds used. A dedicated
    // OpencodeStorageWatcher polls the DB read-only (bun:sqlite, like the cursor
    // watcher) and assembles sessions from it — see opencodeStorage.ts.
    transcriptRoots: ["~/.local/share/opencode/opencode.db"],
    watcherKind: "sqlite",
    // Fresh-launch readiness for the opencode TUI, captured from a real settled
    // pane (opencode 1.0.167): the footer hint `ctrl+p commands` and the empty
    // input placeholder `Ask anything…` are BOTH present once the prompt accepts
    // input and BOTH absent during boot (verified by diffing the loading pane
    // against the settled one). Consumed by the fresh-launch injection-readiness
    // poll (daemon.ts, tryStartedTmux) and the opencode resume-readiness poll.
    promptReadyPattern: /ctrl\+p commands|Ask anything/i,
    // `oc-` tmux prefix — distinct from claude `cc`, codex `cx`, cursor `cu`,
    // gemini `gm`. (`ct-` is a task-id prefix, not a tmux prefix; no collision.)
    tmuxPrefix: "oc",
    modelConfig: OPENCODE_MODEL,
    // opencode has no tmux-pane structured-prompt monitoring and no hook system —
    // its readiness/turn state is read from the SQLite store, not the pane. It does,
    // however, ship an `opencode serve` HTTP+SSE server the daemon can attach to as
    // an OPTIONAL richer transport (opencodeServer.ts):
    //  - forkApi: `POST /session/:id/fork` mints a real forkable `ses_*` id from the
    //    shared SQLite DB — works for any session regardless of which process created
    //    it (verified live). This is the branch codecast uses for opencode forks; a
    //    synthetic copy id would not resume, so without a reachable server opencode
    //    fork is simply unavailable rather than falling back to file copying.
    //  - liveEvents: `GET /event` streams live state/permission events, but the bus
    //    is PER-PROCESS — it only sees sessions driven through the sidecar, so it does
    //    NOT accelerate the tmux-TUI launch path; the SQLite watcher stays the
    //    authoritative state source for those. Additive, opt-in, degrades to the DB
    //    path cleanly.
    capabilities: { panePromptMonitoring: false, fork: true, forkApi: true, liveEvents: true },
  },
  pi: {
    id: "pi",
    convexId: "pi",
    binary: "pi",
    launchArgs: [],
    // pi resumes a session by file path OR partial UUID via `--session` (README:
    // `pi --session <path>`; args.js also accepts a partial UUID). We pass the
    // session UUID, so pi reattaches to the SAME .jsonl and appends to it — unlike
    // codex, pi writes no new rollout file on resume, so there is no per-resume fork
    // chain to collapse. (`--continue`/`-c` resumes the most-recent session and is
    // deliberately unused; we always target a specific id.)
    resumeCmd: (sessionId) => `pi --session ${sessionId}`,
    transcriptRoots: ["~/.pi/agent/sessions"],
    watcherKind: "jsonl-dir",
    // pi has NO prompt glyph. Its composer is a box drawn with ─ rules and the input
    // line carries only a reverse-video cursor (verified by capturing a live pane;
    // typed text appears with no ❯/› prefix). The reliable "TUI is settled at the
    // prompt" marker is the status bar's context-budget segment, e.g. `0.0%/200k`,
    // which renders only once the main view is up. The shared /[❯›]/ readiness regex
    // never matches pi, so the resume-readiness site consults this pattern for pi
    // (daemon ~11284); the fresh-launch readiness site already reads it from here.
    promptReadyPattern: /\d+(?:\.\d+)?%\//,
    tmuxPrefix: "pi",
    // No codecast-managed model picker (hence no modelConfig, like cursor/gemini). pi
    // is multi-provider and its primary model UX is mid-session switching via its own
    // Ctrl+P / `/model` UI, which codecast cannot drive without pi's RPC channel
    // (phase-2 stretch, not wired). pi DOES accept `--model <pattern>` at launch, but
    // codecast defers the model choice to pi and instead TRACKS the active model from
    // the transcript (model_change entries + each assistant message's own `model`).
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

/** Whether codecast can fork a conversation for this client into a live session
 *  that carries the copied history (claude/codex/opencode). Gates the fork UI so a
 *  client with no fork mechanism (cursor/gemini/pi) never shows a control that
 *  fabricates a context-less session. Accepts a convex agent_type (claude_code)
 *  or a registry id. */
export function agentSupportsFork(agentType: string | undefined): boolean {
  return AGENT_CLIENTS[fromConvexAgentType(agentType)].capabilities.fork === true;
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
