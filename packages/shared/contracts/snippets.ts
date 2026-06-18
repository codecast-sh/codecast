// Single source of truth for the installable "agent feature" snippets — the
// things `cast install` writes into your CLAUDE.md / ~/.claude config so agents
// gain a capability (memory recall, session messaging, workflows, …).
//
// One catalog, imported by THREE layers that would otherwise drift:
//   - the CLI (`cast install <slug>`) attaches the actual install/uninstall
//     behavior keyed by slug (packages/cli/src/index.ts),
//   - the daemon reports which are enabled on each heartbeat,
//   - the web Settings page renders a per-device toggle for each.
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
    enabledKey: "memory_enabled",
    versionKey: "memory_version",
  },
  {
    slug: "messaging",
    aliases: ["send"],
    name: "Messaging",
    desc: "Session-to-session messages (cast send)",
    enabledKey: "messaging_enabled",
    versionKey: "messaging_version",
  },
  {
    slug: "forks",
    aliases: ["fork", "spawn", "sessions"],
    name: "Forks & Sessions",
    desc: "Branch or spawn sessions into the inbox",
    enabledKey: "forks_enabled",
    versionKey: "forks_version",
  },
  {
    slug: "tasks",
    aliases: ["task", "plans", "work"],
    name: "Tasks & Plans",
    desc: "Work tracking for agents (cast task / plan)",
    enabledKey: "work_enabled",
    versionKey: "work_version",
  },
  {
    slug: "scheduling",
    aliases: ["schedule", "async"],
    name: "Scheduling",
    desc: "Delayed and recurring agent sessions (cast schedule)",
    enabledKey: "task_enabled",
    versionKey: "task_version",
  },
  {
    slug: "workflows",
    aliases: ["workflow"],
    name: "Workflows",
    desc: "Execution graphs with approval gates (cast workflow)",
    enabledKey: "workflow_enabled",
    versionKey: "workflow_version",
  },
  {
    slug: "visual",
    aliases: ["canvas", "visuals"],
    name: "Visual Canvas",
    desc: "Inline HTML visuals from agents (cast-canvas)",
    enabledKey: "visual_enabled",
    versionKey: "visual_version",
  },
  {
    slug: "orchestration",
    aliases: ["orchestrate", "orch"],
    name: "Orchestration",
    desc: "Multi-agent plan execution (/orchestrate)",
    enabledKey: "orch_enabled",
    versionKey: "orch_version",
  },
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
  stable_mode?: "solo" | "team" | "off";
  /** Whether stable mode is applied globally vs per-project. */
  stable_global?: boolean;
}
