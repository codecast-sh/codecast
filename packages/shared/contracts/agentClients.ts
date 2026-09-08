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

import type { CapabilityKind } from "./capabilities";
import type { ModelOption } from "./modelOptions";
import {
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
  PI_MODEL_OPTIONS,
  GROK_MODEL_OPTIONS,
  CLAUDE_EFFORT_LEVELS,
  CODEX_EFFORT_LEVELS,
  OPENCODE_EFFORT_LEVELS,
  PI_EFFORT_LEVELS,
  GROK_EFFORT_LEVELS,
  isDynamicModelKey,
  dynamicModelOption,
} from "./modelOptions";

/** The single named union for a supported agent CLI client — the daemon's
 *  agent-type spelling and the registry key. */
export type AgentClientId = "claude" | "codex" | "cursor" | "gemini" | "opencode" | "pi" | "grok";

/** Runtime transports that may create/deliver for a fenced execution binding. */
export type AgentExecutionTransport = "tmux" | "app-server" | "external";

/**
 * How a client runs non-interactively — the `cast exec` / `claude -p` analog.
 * Data only; the CLI's `buildPrintArgs` maps unified flags onto these tokens.
 */
export interface AgentPrintMode {
  /** `flag` = `-p` on the main binary; `subcommand` = `exec` / `run`. */
  kind: "flag" | "subcommand";
  /** The print flag (`-p`) or subcommand name (`exec`, `run`). */
  token: string;
  /**
   * When true, the prompt is the flag's own value (`grok -p "…"`, `gemini -p "…"`).
   * When false, the prompt is positional (`claude -p "…"`, `codex exec "…"`).
   */
  promptAsValue?: boolean;
}

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
  | "pi"
  | "grok";

const CONVEX_BY_ID: Record<AgentClientId, ConvexAgentType> = {
  claude: "claude_code",
  codex: "codex",
  cursor: "cursor",
  gemini: "gemini",
  opencode: "opencode",
  pi: "pi",
  grok: "grok",
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
    case "grok":
      return "grok";
    default:
      return "claude";
  }
}

/**
 * Error raised when an untrusted agent identifier reaches an execution boundary.
 *
 * The legacy/display parser above intentionally preserves its historical
 * unknown-to-Claude fallback. Runtime creation and message delivery must never use
 * that behavior: silently changing agent families is an external side effect, not
 * a presentation default.
 */
export class InvalidExecutionAgentTypeError extends Error {
  readonly code = "INVALID_EXECUTION_AGENT_TYPE" as const;

  constructor(readonly agentType: unknown) {
    super(`Unsupported execution agent type: ${formatUnknownAgentType(agentType)}`);
    this.name = "InvalidExecutionAgentTypeError";
  }
}

function formatUnknownAgentType(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return typeof value;
}

/**
 * Strict wire/display spelling -> execution client parser.
 *
 * Compatibility aliases are exhaustive and explicit. In particular, `cowork`
 * remains an intentional alias for the Claude client, while nullish and unknown
 * values fail closed instead of entering the historical Claude fallback.
 */
export function parseExecutionAgentClientId(agentType: unknown): AgentClientId {
  switch (agentType) {
    case "claude":
    case "claude_code":
    case "cowork":
      return "claude";
    case "codex":
    case "cursor":
    case "gemini":
    case "opencode":
    case "pi":
    case "grok":
      return agentType;
    default:
      throw new InvalidExecutionAgentTypeError(agentType);
  }
}

/** Model/effort picker config for a client (the old `AGENT_MODEL_CONFIG` value). */
export interface AgentModelConfig {
  models: ModelOption[];
  efforts: readonly string[];
  /** The model of a RUNNING session can be switched in place by sending the
   *  client's `/model <alias>` / `/effort <level>` commands as ordinary
   *  messages (claude). codex's /model is interactive-only, so it applies at
   *  launch only. */
  midSession: boolean;
  /** The client addresses an open `provider/model` namespace whose availability
   *  is a per-device fact (opencode, pi). Any well-formed `provider/model` key is
   *  a valid wire value — findModelOption synthesizes its option — and pickers
   *  render from the device's heartbeat-reported model inventory. */
  dynamic?: boolean;
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
  /** codecast can WRITE this client's transcript from the server's message copy
   *  and resume it (claude/codex/pi JSONL writers, grok's session bundle; gemini
   *  rides claude's). This is
   *  what lets the daemon rebuild history it does not hold locally: a fork from
   *  any earlier message, a switch INTO this client mid-session, and a resume on
   *  a device that never ran the session. Absent for clients whose session state
   *  codecast cannot fabricate (cursor's SQLite store) — there a mid-history
   *  fork or a switch into the client is refused up front, never stamped on the
   *  row and left for the daemon to fail. */
  reconstitute?: boolean;
  /** The client can stream live structured events (state / permissions) over a
   *  richer transport the daemon attaches to, accelerating work-state past DB/tail
   *  polling. Opt-in and additive: the plain transcript path stays authoritative for
   *  content and keeps working when the transport is absent. For opencode this is
   *  bounded — the serve /event bus is per-process, so it accelerates only sessions
   *  DRIVEN THROUGH the sidecar, not tmux-TUI sessions (see opencodeServer.ts). */
  liveEvents?: boolean;
  /** The client's TUI enables terminal bracketed-paste mode (DECSET 2004), so
   *  pasted newlines land in its composer instead of acting as Enter/submission.
   *  This is opt-in because an unverified client must receive flattened text:
   *  preserving raw newlines there could split one prompt into several turns. */
  bracketedPaste?: boolean;
}

/* ── Agent file targets ───────────────────────────────────────────────────────
 * Where each client reads capabilities from disk, as data. Every slot below is
 * a VERIFIED fact (scratchpad research 2026-08-12/13: real CLIs driven in a
 * sandbox HOME, real files read off this machine) — a slot is present only when
 * we know the client reads that location, and absent otherwise. Same honest-
 * absence idiom as `AgentClientCapabilities.fork` above: an absent slot means
 * "this client cannot express that", never "fall back to claude's layout".
 *
 * Path rules (the invariant the tests pin):
 *  - User-level paths are home-relative TEMPLATES starting `~/` — this module
 *    is isomorphic (Convex/browser/Hermes) and cannot call `os.homedir()`; the
 *    CLI driver resolves `~` on the machine it runs on.
 *  - Project-level paths are repo-root-relative, never absolute.
 *  - No path is ever a resolved absolute path or uses a platform separator.
 */

/** A hooks config file's write schema. `unverified` records an OBSERVED path
 *  whose shape nobody has confirmed — it names the file without granting
 *  support, so `capabilitySupport` answers "unsupported" for it rather than
 *  letting a driver guess at bytes. */
export type AgentHooksShape = "claude_settings" | "json_hooks" | "unverified";

export interface AgentInstructionFileTarget {
  /** Home-relative path of the always-loaded user instruction file
   *  (`~/.claude/CLAUDE.md`). Absent when the client keeps user-level prose
   *  outside the filesystem (cursor: user rules live in app settings). */
  user?: string;
  /** Repo-root-relative instruction target in a checkout. For `markdown` this
   *  is one file; for `mdc` it is a rules DIRECTORY. */
  project?: string;
  /** `markdown` = one instruction file snippets merge into (CLAUDE.md,
   *  AGENTS.md). `mdc` = a rules directory taking one `<name>.mdc` file per
   *  snippet, with `description`/`globs`/`alwaysApply` frontmatter (cursor). */
  format: "markdown" | "mdc";
}

export interface AgentSkillsDirTarget {
  /** Client-native user-level skills dir (`~/.claude/skills`). */
  user: string;
  /** Repo-root-relative project skills dir (`.claude/skills`). */
  project?: string;
  /** The cross-client `~/.agents/skills` dir, present only when the client
   *  READS it directly (codex documents it, cursor reads it). Absent for
   *  claude, which reaches it only through a user-made symlink — listing it
   *  would tell a driver to write bytes claude never loads. */
  shared?: string;
  /** The cross-client PROJECT dir `.agents/skills`, present only when the
   *  client reads it as a second project location beside `project` (cursor
   *  reads both `.agents/skills` and `.cursor/skills`). Codex needs no slot
   *  here: its `project` slot already IS `.agents/skills`, so a driver writing
   *  codex project skills silently serves cursor too. Without this slot the
   *  fleet mirror could not attribute a repo's `.agents/skills` dir to cursor
   *  and would under-report a verified read path. */
  sharedProject?: string;
}

export interface AgentAgentsDirTarget {
  /** User-level subagent definitions dir (`~/.claude/agents`, `agents/*.md`). */
  user: string;
  /** Repo-root-relative project subagents dir. */
  project?: string;
}

export interface AgentMcpConfigTarget {
  /** User/global config file holding MCP server entries. */
  user: string;
  /** Repo-root-relative project config file. */
  project?: string;
  /** File schema: JSON with a top-level `mcpServers` object (claude `.mcp.json`,
   *  cursor `mcp.json`) or TOML `[mcp_servers.<name>]` tables (codex
   *  `config.toml` — a shared user-owned file with unrelated content, so a
   *  driver must edit surgically, never rewrite). */
  shape: "json_mcpservers" | "toml_mcp_servers";
}

/** Claude Code's declarative plugin manifest. `claude plugin install --scope
 *  project` writes ONLY `enabledPlugins` + `extraKnownMarketplaces` into the
 *  settings file — no plugin bytes land in the project; Claude Code fetches and
 *  caches on its own. Rendering this file IS the install mechanism (verified in
 *  a sandbox HOME); shelling out is only a convenience for immediate effect. */
export interface AgentPluginSettingsTarget {
  /** User settings file carrying `enabledPlugins`. */
  user: string;
  /** Project settings file carrying `enabledPlugins` + `extraKnownMarketplaces`
   *  (committable, shared via the repo). */
  project?: string;
  /** Gitignored personal overlay (`settings.local.json`), `enabledPlugins` only. */
  local?: string;
}

export interface AgentHooksConfigTarget {
  /** The hooks config file (home-relative). */
  path: string;
  shape: AgentHooksShape;
}

/** The client's per-session capability overlay: a launch flag that mounts an
 *  extra directory whose skills load for that session only (claude's
 *  `--add-dir` loads the dir's `.claude/skills`, verified). This is the
 *  session-scope materialization seam — no client file is touched. */
export interface AgentSessionOverlayTarget {
  kind: "add-dir";
  launchFlag: string;
}

/** The client's own capability-management CLI, where one exists. A present
 *  command means the client can install/enable that kind itself and the driver
 *  invokes it instead of hand-writing the client-owned file. */
export interface AgentNativeManagerCommands {
  /** e.g. `claude plugin` (install/list against marketplaces). */
  plugin?: string;
  /** e.g. `claude mcp`, `codex mcp` — the safe writer for the client-owned
   *  user config file (`~/.claude.json`, `~/.codex/config.toml`). */
  mcp?: string;
}

/** Per-client capability file targets. Every slot optional: presence is the
 *  verified claim "the client reads this", and `capabilitySupport` is DERIVED
 *  from these same slots — the one encoding a driver reads and the UI renders,
 *  so the two can never disagree. */
export interface AgentFileTargets {
  instructionFile?: AgentInstructionFileTarget;
  skillsDir?: AgentSkillsDirTarget;
  agentsDir?: AgentAgentsDirTarget;
  mcpConfig?: AgentMcpConfigTarget;
  pluginSettings?: AgentPluginSettingsTarget;
  hooksConfig?: AgentHooksConfigTarget;
  sessionOverlay?: AgentSessionOverlayTarget;
  nativeManager?: AgentNativeManagerCommands;
}

/**
 * The per-pane terminal modes tmux exposes as formats, read once per readiness
 * poll. tmux tracks more modes than it renders — MODE_BRACKETPASTE (`?2004h`)
 * among them — so a rule can only ask for what is in this shape.
 */
export interface PaneTerminalModes {
  /** `#{alternate_on}`: the program switched to the alternate screen (`?1049h`). */
  alternateScreen: boolean;
  /** `#{cursor_flag}`: the terminal cursor is visible (`?25h`). */
  cursorVisible: boolean;
}

/**
 * What a FRESHLY LAUNCHED pane must show before the daemon will paste into it,
 * beyond `promptReadyPattern` matching. Absent means the pattern alone decides,
 * which is the behaviour every client had before ct-49538.
 *
 * The problem this exists for: a prompt pattern answers "did the composer
 * paint", and painting is not reading. Every client here paints its composer
 * seconds before it consumes stdin, and the pane is the only witness the daemon
 * has. Where a client tells the terminal something true at the moment it goes
 * live, that fact belongs in `modes`; where it only paints, the frame has to
 * carry the evidence instead (`frameCompleteAfter`).
 *
 * Measured per client on a private tmux server, cold launches through the
 * daemon's own launch text (ct-49538). The full flag timelines are on the task.
 */
export interface AgentPaneReadiness {
  /**
   * Terminal modes that must hold WHILE the prompt pattern matches. Only the
   * listed keys are checked; an unlisted one is not asserted either way.
   *
   * grok and opencode both take the alternate screen with the cursor hidden and
   * then SHOW the cursor on the same frame their composer goes live, so for
   * them these modes are a real readiness fact rather than a paint. claude
   * hides the cursor when ready and never leaves the primary screen, and codex
   * changes no mode at all from shell to live composer — so neither client can
   * be judged this way, and neither carries a `modes` rule.
   */
  modes?: Partial<PaneTerminalModes>;
  /**
   * A pattern that must appear AFTER the prompt pattern's match — the rest of
   * the ready frame, painted below the composer. It says the frame is finished
   * rather than half drawn, which for a client that tells the terminal nothing
   * is the only ordering evidence available.
   */
  frameCompleteAfter?: RegExp;
  /**
   * Quiet time between the rule first holding and the first paste, so a
   * freshly painted frame stops redrawing. 500 ms is the value the fresh-launch
   * delivery path applied to every client before this field existed, and it
   * stays the default for a client with no entry here.
   */
  settleMs?: number;
}

/** Everything the daemon, convex, and web need to know about one client. */
export interface AgentClientDescriptor {
  /** Stable internal id — the daemon's agent-type spelling and the registry key. */
  id: AgentClientId;
  /** The spelling the Convex schema / wire protocol uses. */
  convexId: ConvexAgentType;
  /** Picker display name ("Claude", "OpenCode", "pi"). */
  displayName: string;
  /** Exact fenced transports that are valid for this agent family. */
  executionTransports: readonly AgentExecutionTransport[];
  /** Executable launched to start a fresh session. */
  binary: string;
  /** Static args always passed at launch, before the conditional permission /
   *  model / effort flags the daemon appends. Empty for every current client. */
  launchArgs: string[];
  /**
   * This client's composer must be TYPED, never pasted, and this is the tmux
   * key that puts a literal newline in it.
   *
   * A bracketed paste is a paste GESTURE to the program receiving it, not just
   * text, and a client is free to answer it by reading the machine's own
   * clipboard. That is behaviour a managed pane must not have: the pane is
   * driven by injection, so whatever the human last copied rides along.
   */
  typedComposerInput?: { newlineKey: string };
  /**
   * How this client runs non-interactively (print / exec / run). Required: a
   * new client must say how `cast exec` invokes it. `flag` is `-p` on the main
   * binary; `subcommand` is `codex exec` / `opencode run`. `promptAsValue` is
   * for flags that take the prompt as their own argument (`grok -p "…"`,
   * `gemini -p "…"`) rather than a positional after the flag.
   */
  printMode: AgentPrintMode;
  /** Base command that resumes an existing session — the daemon appends
   *  model / permission / effort flags around it. */
  resumeCmd(sessionId: string): string;
  /** Native fork: the client's own resume flags copy the parent's session state
   *  under a new id (`--resume <parent> --fork-session --session-id <new>`), so
   *  the daemon launches this instead of writing a transcript. The copy is the
   *  client's, whole and byte-exact, which is why it forks only at the TIP —
   *  there is no way to cut the copied context at an earlier message. Pairs
   *  with `capabilities.fork`; a client that also `reconstitute`s takes this at
   *  the tip and the rebuild path for a mid-history fork. */
  forkCmd?(parentSessionId: string, newSessionId: string): string;
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
  /** What else a freshly launched pane must show before the daemon pastes into
   *  it. Absent = the prompt pattern alone, plus the default settle. */
  paneReadiness?: AgentPaneReadiness;
  /** Prefix for the tmux session names the daemon's resume path creates. */
  tmuxPrefix: string;
  /** Model/effort picker config, or undefined for clients with no model UI. */
  modelConfig?: AgentModelConfig;
  /** Non-model capabilities that are opt-in per client. */
  capabilities: AgentClientCapabilities;
  /** Where this client reads capabilities from disk. Absent for clients whose
   *  layouts nobody has verified (gemini, opencode, pi) — honest absence, so
   *  `capabilitySupport` reports every kind unsupported there instead of a
   *  driver writing files the client never loads. */
  agentFileTargets?: AgentFileTargets;
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
  dynamic: true,
};
const PI_MODEL: AgentModelConfig = {
  models: PI_MODEL_OPTIONS,
  // pi's --thinking levels ride the effort slot (launch-time, like codex).
  efforts: PI_EFFORT_LEVELS,
  midSession: false,
  dynamic: true,
};
const GROK_MODEL: AgentModelConfig = {
  models: GROK_MODEL_OPTIONS,
  efforts: GROK_EFFORT_LEVELS,
  // The TUI's model/effort menus are interactive-only; model and effort are
  // launch-time flags (-m, --reasoning-effort), tracked from the transcript
  // after (_meta.modelId on user_message_chunk updates).
  midSession: false,
  // Keys are bare model ids (grok-4.6), not provider/model — dynamic would be
  // wrong by construction (isDynamicModelKey requires a slash). The catalog is
  // closed logged out (`grok models` prints exactly grok-4.6, grok-4.5); remote
  // settings could extend it post-login — revisit only with evidence.
  dynamic: false,
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
    displayName: "Claude",
    convexId: "claude_code",
    executionTransports: ["tmux"],
    binary: "claude",
    launchArgs: [],
    printMode: { kind: "flag", token: "-p" },
    resumeCmd: (sessionId) => `claude --resume ${sessionId}`,
    transcriptRoots: ["~/.claude/projects"],
    watcherKind: "jsonl-dir",
    // Fresh-launch site (daemon.ts:11989) else-branch, verbatim: /❯|⏵/ ("Claude:
    // ❯ or ⏵"). The shared readiness path (daemon.ts:11251 etc.) instead uses
    // /[❯›]/ — agrees on ❯ but not ⏵.
    promptReadyPattern: /❯|⏵/,
    tmuxPrefix: "cc",
    modelConfig: CLAUDE_MODEL,
    capabilities: { panePromptMonitoring: true, fork: true, reconstitute: true, bracketedPaste: true },
    // All verified by driving the real CLI in a sandbox HOME (2026-08-12/13).
    // Plugins live in settings.json; MCP lives in ~/.claude.json (`enabledPlugins`
    // read back null there) — the two files must not be conflated. `~/.agents/skills`
    // is reachable only via a user-made symlink, so no `shared` slot here.
    agentFileTargets: {
      instructionFile: { user: "~/.claude/CLAUDE.md", project: "CLAUDE.md", format: "markdown" },
      skillsDir: { user: "~/.claude/skills", project: ".claude/skills" },
      agentsDir: { user: "~/.claude/agents", project: ".claude/agents" },
      mcpConfig: { user: "~/.claude.json", project: ".mcp.json", shape: "json_mcpservers" },
      pluginSettings: {
        user: "~/.claude/settings.json",
        project: ".claude/settings.json",
        local: ".claude/settings.local.json",
      },
      hooksConfig: { path: "~/.claude/settings.json", shape: "claude_settings" },
      sessionOverlay: { kind: "add-dir", launchFlag: "--add-dir" },
      nativeManager: { plugin: "claude plugin", mcp: "claude mcp" },
    },
  },
  codex: {
    id: "codex",
    displayName: "Codex",
    convexId: "codex",
    executionTransports: ["tmux", "app-server"],
    binary: "codex",
    launchArgs: [],
    printMode: { kind: "subcommand", token: "exec" },
    resumeCmd: (sessionId) => `codex resume ${sessionId}`,
    transcriptRoots: ["~/.codex/sessions"],
    watcherKind: "jsonl-dir",
    // Codex renders its composer as `› Ask Codex to do anything` and then paints
    // a footer BELOW it — `<model> <effort> · <cwd>` — so the last non-space
    // character of the pane is never `>`. The old fresh-launch pattern />\s*$/
    // therefore never matched: a codex pane sitting at a live composer classified
    // "booting" on every poll for the full 120s discovery budget and the session
    // never bound by readiness (ct-49754, measured on codex 0.153.4). The `›`
    // glyph is what codex actually renders, and it agrees with the shared /[❯›]/
    // readiness path rather than disagreeing with it.
    promptReadyPattern: /›/,
    // Codex changes NO terminal mode between the shell and a live composer:
    // measured over three cold boots, #{alternate_on} stayed 0 and #{cursor_flag}
    // stayed 1 from exec through to `› Ask Codex to do anything`, and every other
    // mode tmux renders stayed 0. So there is no mode fact to require, and the
    // frame has to carry the evidence. The glyph paints first and the footer
    // after it — 1365→2926ms, 589→1015ms, 358→576ms over those three boots — so
    // requiring the footer BELOW the glyph is the ordering statement available
    // here: the ready frame is finished, not half drawn.
    //
    // Codex still paints that frame before it reads stdin, and nothing here
    // closes that window — the Enter gate does, by refusing to submit until the
    // payload renders in the composer. Measured over 24 cold deliveries across
    // four clients, no pane still held its payload 1200ms after delivery
    // returned, so a second press on top of the gate would only ever have
    // submitted an empty composer.
    paneReadiness: { frameCompleteAfter: /·/, settleMs: 500 },
    tmuxPrefix: "cx",
    modelConfig: CODEX_MODEL,
    capabilities: { panePromptMonitoring: true, fork: true, reconstitute: true, bracketedPaste: true },
    // Codex's documented user skills path IS the cross-client dir (`$HOME/.agents/
    // skills` in its lookup order), so `user` and `shared` are the same string —
    // `~/.codex/skills` exists on real machines but is undocumented legacy, treated
    // read-only. Hooks: codecast already writes ~/.codex/hooks.json (schema mirrors
    // claude's settings.json matcher groups — installStableHookCodex,
    // stableContext.ts:350). No agentsDir (subagent format unverified) and no
    // pluginSettings (marketplaces are OpenAI-operated; no third-party registration
    // found), so both kinds stay honestly unsupported.
    agentFileTargets: {
      instructionFile: { user: "~/.codex/AGENTS.md", project: "AGENTS.md", format: "markdown" },
      skillsDir: { user: "~/.agents/skills", project: ".agents/skills", shared: "~/.agents/skills" },
      // The project file loads ONLY for projects the user has marked trusted —
      // a driver writing it in an untrusted checkout writes bytes codex never
      // loads, so surfaces should prefer the user file when trust is unknown.
      mcpConfig: { user: "~/.codex/config.toml", project: ".codex/config.toml", shape: "toml_mcp_servers" },
      hooksConfig: { path: "~/.codex/hooks.json", shape: "json_hooks" },
      nativeManager: { mcp: "codex mcp" },
    },
  },
  cursor: {
    id: "cursor",
    displayName: "Cursor",
    convexId: "cursor",
    executionTransports: ["tmux"],
    binary: "cursor-agent",
    launchArgs: [],
    printMode: { kind: "flag", token: "-p" },
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
    // Cursor's project prose target is the `.cursor/rules` DIRECTORY of `.mdc`
    // files (`description`/`globs`/`alwaysApply` frontmatter); user-level rules
    // live in app settings, not a file — hence no `user` slot. `~/.cursor/hooks.json`
    // is an observed path whose write shape nobody has confirmed, recorded as
    // `unverified` so hook support stays off without losing the fact. No agentsDir:
    // cursor has subagents but their config format is unresearched.
    agentFileTargets: {
      instructionFile: { project: ".cursor/rules", format: "mdc" },
      skillsDir: {
        user: "~/.cursor/skills",
        project: ".cursor/skills",
        shared: "~/.agents/skills",
        // Cursor also discovers project skills in the cross-client dir — both
        // locations verified (ecosystem research). See sharedProject docs for
        // why codex declares no such slot.
        sharedProject: ".agents/skills",
      },
      mcpConfig: { user: "~/.cursor/mcp.json", project: ".cursor/mcp.json", shape: "json_mcpservers" },
      hooksConfig: { path: "~/.cursor/hooks.json", shape: "unverified" },
    },
  },
  gemini: {
    id: "gemini",
    displayName: "Gemini",
    convexId: "gemini",
    executionTransports: ["tmux"],
    binary: "gemini",
    launchArgs: [],
    printMode: { kind: "flag", token: "-p", promptAsValue: true },
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
    // reconstitute: the daemon has always rebuilt a missing gemini session through
    // the claude JSONL writer + `gemini --resume latest` (a sanctioned oddity, not
    // a fork mechanism — `fork` stays absent).
    capabilities: { panePromptMonitoring: false, reconstitute: true },
  },
  opencode: {
    id: "opencode",
    displayName: "OpenCode",
    convexId: "opencode",
    executionTransports: ["tmux"],
    binary: "opencode",
    launchArgs: [],
    printMode: { kind: "subcommand", token: "run" },
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
    // The footer alone is a paint. opencode also tells the terminal when it is
    // ready: it takes the alternate screen with the cursor HIDDEN while it
    // loads, and shows the cursor again on the frame its composer goes live.
    // Measured on a cold launch: shell at 253ms (alt 0, cursor 1), alternate
    // screen with the cursor hidden at 3636ms, cursor back at 9361ms on the same
    // poll that first saw the footer. Requiring both closes a 5.7s window in
    // which the footer could be read off a half-painted frame.
    paneReadiness: { modes: { alternateScreen: true, cursorVisible: true }, settleMs: 500 },
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
    capabilities: {
      panePromptMonitoring: false,
      fork: true,
      forkApi: true,
      liveEvents: true,
      bracketedPaste: true,
      // reconstitute — through the serve sidecar, not the SQLite store: the
      // daemon creates a session (`POST /session?directory=`) and appends the
      // whole history as ONE `noReply` user message (no import endpoint exists;
      // a `noReply` message starts no model turn). Verified live 2026-09-06.
      reconstitute: true,
    },
  },
  pi: {
    id: "pi",
    displayName: "pi",
    convexId: "pi",
    executionTransports: ["tmux"],
    binary: "pi",
    launchArgs: [],
    printMode: { kind: "flag", token: "-p" },
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
    // Launch-time model choice via `--model <provider/model>` plus `--thinking`
    // riding the effort slot; the picker offers the device's live inventory
    // (dynamic). Mid-session switching stays pi's own Ctrl+P / `/model` UI, which
    // codecast cannot drive without pi's RPC channel — the active model is TRACKED
    // from the transcript (model_change entries + each assistant message's `model`).
    modelConfig: PI_MODEL,
    // reconstitute: the daemon writes pi's session JSONL (header + parentId chain)
    // from the server copy and `pi --session <uuid>` loads it (live-verified
    // 2026-09-06). No `fork`: pi has no fork verb and a rebuilt copy would be a
    // plain resume of the same chain — a switch INTO pi is the supported move.
    capabilities: { panePromptMonitoring: false, bracketedPaste: true, reconstitute: true },
  },
  grok: {
    id: "grok",
    // Picker label; the product name is "Grok Build", the binary "grok".
    displayName: "Grok",
    convexId: "grok",
    // tmux TUI only; `grok agent` ACP transports (stdio/headless/serve) exist
    // but are unresearched — a follow-up, not phase 1.
    executionTransports: ["tmux"],
    // npm @xai-official/grok; the shim execs the Rust binary at ~/.grok/bin/grok
    // (ps comm basename "grok", verified live on v1.0.5).
    binary: "grok",
    launchArgs: [],
    // Why: a bracketed paste makes grok read the machine's clipboard and attach
    // any image it holds, so every injected message on a machine with a
    // screenshot copied carried that image to xAI and the transcript recorded
    // an attachment nobody sent (ct-49607, measured on 1.0.13). No env gate
    // stops it: grok's three clipboard variables are two copy routes and one
    // read gate, and the read gate leaves the paste-time attach in place. Typed
    // input is clean, and grok's composer takes Ctrl+J as a literal newline, so
    // typing keeps a multi-line message whole.
    typedComposerInput: { newlineKey: "C-j" },
    printMode: { kind: "flag", token: "-p", promptAsValue: true },
    // Always resume by UUID: a non-UUID argument matches session TITLES for the
    // cwd case-insensitively and ERRORS on duplicates (ambiguity by design), so
    // title resume is banned. `-c` (most recent) is deliberately unused — we
    // always target a specific id.
    resumeCmd: (sessionId) => `grok --resume ${sessionId}`,
    // Native fork (source: session/fork.rs; live-verified headless 2026-09-05):
    // grok copies the parent's whole session bundle under the new uuid, stamps
    // `parent_session_id` in the child's summary.json, leaves the parent
    // untouched, and starts the child's updates.jsonl FRESH — only the new
    // turn lands there, so the watcher ingests nothing the server copy already
    // holds. `--session-id` must be a UUID that does not yet exist.
    forkCmd: (parentSessionId, newSessionId) =>
      `grok --resume ${parentSessionId} --fork-session --session-id ${newSessionId}`,
    // ~/.grok/sessions/{url-encoded cwd}/{session uuid}/updates.jsonl — the
    // append-only durable transcript. chat_history.jsonl in the same dir is a
    // rewriteable model-context cache (compaction replaces it wholesale) and is
    // deliberately not watched.
    transcriptRoots: ["~/.grok/sessions"],
    watcherKind: "jsonl-dir",
    // Live-verified on a logged-in v1.0.5 pane (2026-08-26): the composer
    // renders the prompt arrow `❯ ` (U+276F + space; source: prompt_widget/
    // mod.rs:3160-3180 + glyphs.rs:22 `prompt_arrow`) — but the composer STAYS
    // VISIBLE for the whole turn, so a bare ❯ check false-positives mid-turn
    // and an injection's leading Escape would cancel the running turn. That is
    // why grok sits in the daemon's GLYPHLESS_PROMPT_CLIENTS despite having a
    // glyph: every readiness/pane site classifies it whole-pane with
    // busy-detection FIRST (spinner in the header, "Esc:cancel" / "Waiting for
    // response" / "[stop]" in the footer chrome — all from the live capture)
    // before trusting this pattern. Never move grok to the shared /[❯›]/ path.
    // CAUTION: grok has NO "esc to interrupt" string, and its IDLE states
    // contain the words "send a message to interrupt" — never add a generic
    // /interrupt/ busy heuristic for grok.
    promptReadyPattern: /❯/,
    // A bare ❯ is also what several shells prompt with (starship, pure, oh-my-zsh
    // agnoster), so on a pane whose launch has not taken yet — a mistyped binary,
    // a shell that printed its prompt before grok exec'd — the pattern matches the
    // SHELL and the daemon pastes a message into it. grok runs full screen, so the
    // alternate screen separates the two: measured on a cold launch, the shell sat
    // at alt 0 and grok took the alternate screen at 797ms, 1.5s before its ❯
    // painted at 2296ms. Nothing grok renders is ever on the primary screen.
    paneReadiness: { modes: { alternateScreen: true }, settleMs: 500 },
    // `gk-` — free: cc/cx/cu/gm/oc/pi taken.
    tmuxPrefix: "gk",
    modelConfig: GROK_MODEL,
    capabilities: {
      // Grok's permission prompt swaps the spinner for a pulsing ◆ (source:
      // views/turn_status.rs); nobody has built or verified a pane-prompt
      // matcher for it — off.
      panePromptMonitoring: false,
      // fork at the tip rides `forkCmd` (byte-exact copy, cache-warm); every
      // other rebuild — a mid-history fork, a switch INTO grok on a session
      // with history, a resume on a device that never ran it — goes through
      // `reconstitute`: the daemon writes chat_history.jsonl + summary.json
      // under the cwd's session directory and `grok --resume` answers from it
      // (live-verified 2026-09-05; grok regenerates the rest of the bundle).
      fork: true,
      reconstitute: true,
      //
      // bracketedPaste — source-verified: crossterm EnableBracketedPaste on boot
      // AND re-entry (app/mod.rs:1472, event_loop.rs:489); wrap_restore tracks
      // DECSET ?2004. Implementer B additionally live-verifies the ?2004h
      // emission before shipping — if that check fails, delete this line.
      bracketedPaste: true,
    },
    // Slots below follow the honest-absence contract (see the block comment
    // above AgentFileTargets): present only where research PROVED grok reads
    // the location.
    agentFileTargets: {
      // Project AGENTS.md and user ~/.grok/AGENTS.md both verified live via
      // `grok inspect` with planted files (2026-08-26, sandbox HOME, works
      // logged out) — inspect lists both under "Project Instructions". There
      // is NO GROK.md (a planted one was ignored; the string is absent from
      // the grok-build repo) — grok's instruction slot is the shared AGENTS.md
      // standard, not a bespoke file.
      instructionFile: { user: "~/.grok/AGENTS.md", project: "AGENTS.md", format: "markdown" },
      // All four dirs verified live by the same planted-file `grok inspect`
      // run: project .grok/skills + .agents/skills list as "project", user
      // ~/.grok/skills + ~/.agents/skills list as "user" (source:
      // xai-grok-agent/src/prompt/skills.rs:51).
      skillsDir: {
        user: "~/.grok/skills",
        project: ".grok/skills",
        shared: "~/.agents/skills",
        sharedProject: ".agents/skills",
      },
      // TOML [mcp_servers] in ~/.grok/config.toml (user) / ./.grok/config.toml
      // (project) — from `grok mcp add --help`. Same surgical-edit rule as
      // codex's config.toml: a shared user-owned file, never rewrite.
      mcpConfig: { user: "~/.grok/config.toml", project: ".grok/config.toml", shape: "toml_mcp_servers" },
      // `grok mcp add|remove|list|enable|disable|doctor` exists (help captured).
      // The native manager outranks the file write in capabilitySupport.
      nativeManager: { mcp: "grok mcp" },
      // OMITTED, honestly: hooksConfig (grok hooks are a DIRECTORY
      // ~/.grok/hooks/ of JSON plus config.toml layers — doesn't fit the
      // single-file target shape; writing guessed bytes is worse than absence),
      // agentsDir (subagent config format unresearched), pluginSettings +
      // nativeManager.plugin (`grok plugin` exists but install semantics
      // unverified — listing it would grant "native" support capabilitySupport
      // can't back), sessionOverlay (no --add-dir analog verified).
    },
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

/** One new-session agent choice: both id spellings plus the picker label, so
 *  each surface keys off whichever spelling its wire calls take. */
export interface AgentLaunchOption {
  id: AgentClientId;
  convexType: ConvexAgentType;
  label: string;
}

/** The agent row of every new-session surface (web AgentSwitcher, mobile
 *  sheet), derived from the registry in declaration order — adding a client
 *  descriptor is all it takes to appear in the pickers. */
export const AGENT_LAUNCH_OPTIONS: AgentLaunchOption[] = Object.values(AGENT_CLIENTS).map((d) => ({
  id: d.id,
  convexType: d.convexId,
  label: d.displayName,
}));

/** The launch-time model/effort rail for a blank session: effort gains the
 *  "default" stop (= omit the flag, the agent's saved default wins). One
 *  definition for the web menu, the mobile switcher chip, and the mobile
 *  new-session sheet; the live (mid-session) rail is cfg.models/cfg.efforts. */
export function launchRailOptions(cfg: AgentModelConfig): { models: ModelOption[]; efforts: string[] } {
  return {
    models: cfg.models,
    efforts: ["default", ...cfg.efforts],
  };
}

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

/** Whether codecast can rebuild this client's transcript from the server copy
 *  (`capabilities.reconstitute`). A switch INTO the client on a session that
 *  already has history, a cross-agent fork into it, and a resume on a device
 *  that never ran it all need this; refusing early keeps the row's agent_type
 *  truthful instead of stamping an agent the daemon then cannot launch. */
export function agentReconstitutes(agentType: string | undefined): boolean {
  return AGENT_CLIENTS[fromConvexAgentType(agentType)].capabilities.reconstitute === true;
}

/** Whether a fork can start from ANY message rather than only the tip. A rebuild
 *  (`reconstitute`) or a fork API that cuts at a message (`forkApi`) honors an
 *  earlier fork point; a native resume-flag fork (`forkCmd`) copies the client's
 *  whole context and so is offered only on the last message. */
export function agentForksFromAnyMessage(agentType: string | undefined): boolean {
  const caps = AGENT_CLIENTS[fromConvexAgentType(agentType)].capabilities;
  return caps.fork === true && (caps.reconstitute === true || caps.forkApi === true);
}

/** Whether a session can be switched to, or forked as, `targetAgentType`. A
 *  blank session is simply relaunched and can become anything; one with history
 *  needs the target to rebuild that history (`reconstitute`). One predicate for
 *  the switch menu, the palette, and the mutations behind them. */
export function canSessionBecomeAgent(targetAgentType: string | undefined, messageCount: number | null | undefined): boolean {
  return (messageCount ?? 0) === 0 || agentReconstitutes(targetAgentType);
}

/** Whether the daemon forks this client through its own resume flags. */
export function agentForksNatively(agentType: string | undefined): boolean {
  const d = AGENT_CLIENTS[fromConvexAgentType(agentType)];
  return d.capabilities.fork === true && typeof d.forkCmd === "function";
}

/**
 * How codecast can express one capability kind for one client:
 *
 *   native       the client's own CLI manages the kind end to end; the driver
 *                invokes it (`claude mcp add`, `codex mcp add`) instead of
 *                hand-editing the client-owned config file.
 *   write        codecast writes the bytes itself into a declared target
 *                (skills dir, instruction file, agents dir, hooks file).
 *   render       codecast renders a small declarative manifest and the client
 *                fetches/installs the bytes on its own (claude plugins:
 *                `enabledPlugins` + `extraKnownMarketplaces` in settings.json).
 *   unsupported  no verified way in — the UI must hide the control, exactly
 *                like the fork gate above.
 */
export type CapabilityKindSupport = "native" | "write" | "render" | "unsupported";

/**
 * Which `CapabilityKind`s a client can express, DERIVED from the same
 * `agentFileTargets` slots a driver reads — never a second hand-kept table,
 * because two encodings in two files eventually disagree and show the user
 * "supported" while the driver writes nothing. A client with no verified
 * targets (gemini, opencode, pi) is wholly unsupported: honest absence, same
 * idiom as `agentSupportsFork`. Strictly typed on `AgentClientId` on purpose —
 * the permissive `fromConvexAgentType` fallback would answer with claude's
 * support for an unknown client, which is exactly the false "supported" this
 * function exists to prevent.
 */
export function capabilitySupport(kind: CapabilityKind, clientId: AgentClientId): CapabilityKindSupport {
  // The `?.` guards the RUNTIME hole the strict type can't close: wire values
  // ("claude_code") reach here through unsafe casts, and an unknown client must
  // answer "unsupported" — literally true, and safer than a TypeError. Callers
  // holding a wire spelling should convert with fromConvexAgentType first.
  const targets = AGENT_CLIENTS[clientId]?.agentFileTargets;
  if (!targets) return "unsupported";
  switch (kind) {
    case "snippet":
      return targets.instructionFile ? "write" : "unsupported";
    case "skill":
      return targets.skillsDir ? "write" : "unsupported";
    case "command":
      // Read-only legacy kind: commands merged into skills upstream and a skill
      // wins a name clash, so no driver ever materializes one (see
      // MATERIALIZABLE_KINDS, capabilities.ts).
      return "unsupported";
    case "subagent":
      return targets.agentsDir ? "write" : "unsupported";
    case "mcp":
      // The user-level MCP config is a client-owned file with unrelated content
      // (~/.claude.json, ~/.codex/config.toml): where the client ships its own
      // `mcp` command that is the safe writer, so it outranks direct file edits.
      return targets.nativeManager?.mcp ? "native" : targets.mcpConfig ? "write" : "unsupported";
    case "plugin":
      // The declarative settings render outranks the native manager: `claude
      // plugin install` clones marketplaces over SSH per machine, while the
      // rendered file defers fetching to the client itself and works fleet-wide
      // (verified in a sandbox HOME — 00-plugin-scope-mechanics).
      return targets.pluginSettings
        ? "render"
        : targets.nativeManager?.plugin
          ? "native"
          : "unsupported";
    case "hook":
      // An `unverified` shape names an observed file without granting support:
      // writing guessed bytes into a hooks config is worse than absence.
      return targets.hooksConfig && targets.hooksConfig.shape !== "unverified"
        ? "write"
        : "unsupported";
  }
}

/** Strict fenced-runtime routing policy. There is no fallback transport. */
export function agentSupportsExecutionTransport(
  agent: AgentClientId,
  transport: AgentExecutionTransport,
): boolean {
  return AGENT_CLIENTS[agent].executionTransports.includes(transport);
}

export function findModelOption(agentType: string | undefined, key: string): ModelOption | undefined {
  const cfg = AGENT_MODEL_CONFIG[modelAgentKey(agentType)];
  const hit = cfg?.models.find((m) => m.key === key);
  if (hit) return hit;
  // Dynamic clients (opencode, pi): any well-formed `provider/model` key is a
  // valid wire value — synthesize its option. This one branch is what lets the
  // web picker, convex dispatch validation, and the daemon's launch flags all
  // accept inventory-sourced models without a per-layer allowlist. The key
  // charset is a subset of the daemon's SAFE_ARG_RE, so the synthesized
  // cliAlias is launch-safe by construction.
  if (cfg?.dynamic && isDynamicModelKey(key)) return dynamicModelOption(key);
  return undefined;
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
  // Dynamic clients store the full `provider/model` string as both the wire key
  // and the row's model stamp — it IS the option key.
  if (cfg.dynamic && isDynamicModelKey(model)) return model;
  const bare = model.startsWith("claude-") ? model.slice("claude-".length) : model;
  // Exact match wins over a versioned-prefix match so a longer key ("gpt-5.4-mini")
  // isn't swallowed by a shorter one that prefixes it ("gpt-5.4"); the prefix pass
  // then resolves "opus-4-8" → "opus".
  const hit =
    cfg.models.find((m) => m.key !== "default" && bare === m.key) ??
    cfg.models.find((m) => m.key !== "default" && bare.startsWith(`${m.key}-`));
  return hit?.key ?? "default";
}

/**
 * True when `model` is a stamp for THIS agent — a catalog hit, a dynamic
 * provider/model id, or an unknown id that doesn't belong to another agent's
 * catalog. False for a leftover after an in-place agent switch (claude-fable-5
 * still on the row after switching to Codex): the header chip must not keep
 * showing the previous agent's model.
 */
export function modelFitsAgent(model: string | undefined | null, agentType: string | undefined): boolean {
  if (!model) return false;
  if (modelOptionKey(model, agentType) !== "default") return true;
  const mine = modelAgentKey(agentType);
  const cfg = AGENT_MODEL_CONFIG[mine];
  if (cfg?.dynamic && isDynamicModelKey(model)) return true;
  for (const other of Object.keys(AGENT_MODEL_CONFIG)) {
    if (other === mine) continue;
    if (modelOptionKey(model, other) !== "default") return false;
  }
  return true;
}
