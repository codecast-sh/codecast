// Single source of truth for the installable "agent feature" snippets — the
// things `cast install` writes into your CLAUDE.md / ~/.claude config so agents
// gain a capability (memory recall, session messaging, workflows, …).
//
// One catalog, imported by THREE layers that would otherwise drift:
//   - the CLI (`cast install <slug>`, the install wizard, and `-h`) reads every
//     display field from here and only attaches the install behavior by slug,
//   - the daemon reports which are enabled on each heartbeat,
//   - the web Settings "Agent Features" page renders a per-device card for each,
//     reusing the SAME `detail`/`writesTo` text the terminal shows.
//
// The slug → config-key mapping is deliberately NOT guessable (the `scheduling`
// snippet writes `task_enabled`; the `tasks` snippet writes `work_enabled`) —
// it grew that way historically. Centralizing it here is the whole point: every
// layer looks the mapping up instead of re-deriving it (and getting it wrong).
//
// PURE isomorphic data — no Node or DOM APIs — so the Convex runtime, the Node
// daemon, and the browser can all import it.

export interface SnippetDescriptor {
  /** What you type: `cast install <slug>`. Stable, lowercase, no spaces. */
  slug: string;
  /** Alternate names accepted on the CLI (e.g. "work" → tasks). */
  aliases?: string[];
  /** Human label shown in `-h`, the wizard, and the Settings page. */
  name: string;
  /** One-line summary. */
  desc: string;
  /** The full explanation — same prose the `cast install` wizard prints. */
  detail: string;
  /** Where the snippet is written on disk (shown as a subtle note). */
  writesTo: string;
  /** Config flag this snippet toggles (e.g. "workflow_enabled"). */
  enabledKey: string;
  /** Config field holding the installed snippet version (e.g. "workflow_version"). */
  versionKey: string;
}

export const SNIPPET_CATALOG: SnippetDescriptor[] = [
  {
    slug: "memory",
    name: "Memory",
    desc: "Cross-session recall (cast search / context / feed)",
    detail:
      "Adds `cast search`, `cast context`, and `cast feed` so agents can find prior " +
      "conversations relevant to their current task. Nothing runs automatically — agents " +
      "call these when they need context.",
    writesTo: "CLAUDE.md — a ## Memory section with the command reference",
    enabledKey: "memory_enabled",
    versionKey: "memory_version",
  },
  {
    slug: "messaging",
    aliases: ["send"],
    name: "Messaging",
    desc: "Session-to-session messages (cast send)",
    detail:
      "Adds `cast send <session> \"…\"` so your sessions can message each other directly. " +
      "The text lands as a new turn in the target session, attributed to the sender, and " +
      "renders as a card in the dashboard showing who sent it.",
    writesTo: "CLAUDE.md — a ## Messaging section with the send command",
    enabledKey: "messaging_enabled",
    versionKey: "messaging_version",
  },
  {
    slug: "forks",
    aliases: ["fork", "spawn", "sessions"],
    name: "Forks & Sessions",
    desc: "Branch or spawn sessions into the inbox",
    detail:
      "Adds `cast fork` and `cast spawn` so a session can hand work to your inbox. `fork` " +
      "branches the current conversation N ways from a message point; `spawn` starts fresh " +
      "sessions. Both land in your inbox as independent threads — unlike subagents, which " +
      "report back to the agent that launched them.",
    writesTo: "CLAUDE.md — a ## Forks & Sessions section",
    enabledKey: "forks_enabled",
    versionKey: "forks_version",
  },
  {
    slug: "tasks",
    aliases: ["task", "plans", "work"],
    name: "Tasks & Plans",
    desc: "Work tracking for agents (cast task / plan)",
    detail:
      "Gives agents `cast task` and `cast plan` to track what they're working on — they " +
      "create tasks, log progress, and mark work done, and you see it on the dashboard. " +
      "Agents only use this for real work, not questions or quick lookups.",
    writesTo: "CLAUDE.md — a ## Tasks & Plans section with guidelines and commands",
    enabledKey: "work_enabled",
    versionKey: "work_version",
  },
  {
    slug: "scheduling",
    aliases: ["schedule", "async"],
    name: "Scheduling",
    desc: "Delayed and recurring agent sessions (cast schedule)",
    detail:
      "Adds `cast schedule` so agents can queue follow-up work. For example, an agent " +
      "finishes a PR and schedules \"check CI in 30m\" — a new session spawns later to " +
      "verify. Agents only schedule when they have a reason to.",
    writesTo: "CLAUDE.md — an ## Async Tasks section with schedule commands",
    enabledKey: "task_enabled",
    versionKey: "task_version",
  },
  {
    slug: "workflows",
    aliases: ["workflow"],
    name: "Workflows",
    desc: "Execution graphs with approval gates (cast workflow)",
    detail:
      "Adds `cast workflow` for running .cast files — directed graphs in DOT syntax where " +
      "each node is an agent session, a shell command, or a human approval gate. Workflows " +
      "only run when you explicitly invoke them.",
    writesTo: "CLAUDE.md — a ## Workflows section with the syntax reference",
    enabledKey: "workflow_enabled",
    versionKey: "workflow_version",
  },
  {
    slug: "visual",
    aliases: ["canvas", "visuals"],
    name: "Visual Canvas",
    desc: "Inline HTML visuals from agents (cast-canvas)",
    detail:
      "Teaches agents to render rich visuals inline with a `cast-canvas` HTML block — " +
      "charts, reports, mockups, diagrams, and small widgets render sandboxed in the " +
      "conversation, expandable to fullscreen, instead of ASCII art. Agents only reach for " +
      "it when a visual beats prose; the default stays markdown.",
    writesTo: "CLAUDE.md — a ## Visual Canvas section with the format",
    enabledKey: "visual_enabled",
    versionKey: "visual_version",
  },
  {
    slug: "orchestration",
    aliases: ["orchestrate", "orch"],
    name: "Orchestration",
    desc: "Multi-agent plan execution (/orchestrate)",
    detail:
      "Installs an /orchestrate skill and three agent types (implementer, reviewer, critic). " +
      "It only activates when you say \"orchestrate this plan\". Your agent then acts as a " +
      "conductor: decomposing the plan into tasks, spawning implementers in isolated git " +
      "worktrees, spawning reviewers to check each one, and running critics for a final " +
      "integration sweep. Also installs two lifecycle hooks that fire only during orchestration.",
    writesTo: "~/.claude/skills/, ~/.claude/agents/, and ~/.claude/settings.json (hooks)",
    enabledKey: "orch_enabled",
    versionKey: "orch_version",
  },
];

/**
 * Stable context is a SessionStart hook (not a markdown snippet), so it's a
 * tri-state rather than a boolean. Same explanations the `cast stable` command
 * prints — reused by the web control.
 */
export type StableMode = "solo" | "team" | "off";

export const STABLE_MODES: { value: StableMode; name: string; desc: string }[] = [
  { value: "solo", name: "Solo", desc: "Your recent 10 sessions (last 7 days)" },
  { value: "team", name: "Team", desc: "The team's recent 15 sessions (last 14 days)" },
  { value: "off", name: "Off", desc: "Don't inject any session history" },
];

/** Resolve a user-typed name (slug OR alias, case-insensitive) to its descriptor. */
export function snippetBySlug(input: string): SnippetDescriptor | undefined {
  const q = input.trim().toLowerCase();
  return SNIPPET_CATALOG.find(
    (s) => s.slug === q || (s.aliases?.includes(q) ?? false),
  );
}

/** Every accepted name, for help text and shell completion. */
export function allSnippetSlugs(): string[] {
  return SNIPPET_CATALOG.map((s) => s.slug);
}

/**
 * The shape the daemon reports on each heartbeat and the web renders per device:
 * one boolean per snippet (keyed by the canonical SLUG, not the config flag, so
 * the web never has to know the slug→flag mapping) plus the tri-state stable
 * mode. Everything optional — an older daemon simply omits it.
 */
export interface DeviceSnippetSettings {
  /** Keyed by snippet slug → enabled. */
  snippets?: Record<string, boolean>;
  /** Stable-context injection mode (a SessionStart hook, not a markdown snippet). */
  stable_mode?: StableMode;
  /** Whether stable mode is applied globally vs per-project. */
  stable_global?: boolean;
}
