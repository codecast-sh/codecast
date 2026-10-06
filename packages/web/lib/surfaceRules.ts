// The developer-only surfaces and the words hosted mode changes, decided in
// one place. Hosted mode (`client_state.ui.lane === "simple"`,
// docs/architecture/hosted-assistant.md "The mode") is codecast for
// general-purpose work: the same inbox, tasks, docs, routines, questions,
// pages, teams, search and palette, without the machinery of running code
// (repos, terminals, diffs, machines, models). Every gated place asks this
// registry, so a surface's rule is one line here and never a lane check at
// the call site. This file imports nothing, so a pure view (the sidebar's
// rows, which the marketing hero also draws) takes the mode as a prop without
// loading the store; the live readers are lib/surfaces.ts.

/** How a surface behaves in hosted mode. `developer`: hidden. `machine`:
 *  hidden unless the account has a machine, so a person in hosted mode who
 *  does run one still reaches its settings. Developer mode shows them all. */
type HostedRule = "developer" | "machine";

export const DEV_SURFACES = {
  // Sidebar rows.
  "nav.changes": "developer",
  "nav.projects": "developer",
  "nav.code": "developer",
  "nav.files": "developer",
  "nav.line": "developer",
  "nav.ops": "developer",
  "nav.windows": "developer",
  // Workflows are graphs of agent sessions; routines are the triggers.
  "nav.workflows": "developer",
  // Shell banners and first-run prompts about machines.
  "banner.setup": "developer",
  "banner.cliOffline": "developer",
  "banner.tmuxMissing": "developer",
  "banner.deviceSetup": "developer",
  "banner.resourcePressure": "developer",
  // The offer of the Mac or iPhone app, whose pitch is agents and speed. It
  // sat above a hosted person's first reply.
  "banner.nativeApp": "developer",
  // The Defer, Stash, Kill row under a conversation's composer: the verbs for
  // working through a fleet of sessions. The menus keep them.
  triageBar: "developer",
  // A conversation's working parts in its menu: the resume commands, its
  // short id, restart, the model and agent panel, and the token counts.
  "conversation.internals": "developer",
  // The top bar's "Create Team" button for an account with no team. Settings'
  // Team page keeps the way in.
  "topbar.createTeam": "developer",
  // The terminal dock, a conversation's terminal split and its tmux pill.
  terminal: "developer",
  // The diff panel beside a conversation.
  diff: "developer",
  // Project, branch, worktree and pull request chips.
  gitChips: "developer",
  // Which machine runs a session, and the daemon's status.
  machineChips: "developer",
  // Model and effort pickers on local sessions.
  modelPicker: "developer",
  // Settings' Machines group (CLI, devices, daemon, harness, keys).
  "settings.machines": "machine",
  // The inbox's "install the CLI" empty state.
  "empty.installCli": "developer",
  // The unprompted inbox tour, which teaches triaging a fleet of coding
  // agents (TriageNux). It would cover a hosted person's first reply.
  "tour.agentInbox": "developer",
  // Hints that teach a `cast` command (the triggers page's empty state).
  "hint.cli": "developer",
  // The routines page's filters by run mode, project and agent, and its
  // grouping by session or project.
  "triggers.devFilters": "developer",
  // A routine's machinery: a precheck's command and exit, a home session's
  // stash marker.
  "triggers.internals": "developer",
  // The routine form's agent, project and daemon rows and its event
  // schedules. Without them the form arms a hosted assistant routine, which
  // runs on a schedule and never on an event.
  "triggers.devForm": "developer",
  // Pages for tuning and inspecting agents (evals, agent memory).
  "pages.devTools": "developer",
  // An inbox row's working detail on the phone: the status word, the
  // generated summary bullets, the person's last words behind a shell caret,
  // and the agent, model and message count. Without them a row is its title,
  // its time and one quiet line.
  "inbox.rowInternals": "developer",
} as const satisfies Record<string, HostedRule>;

export type DevSurface = keyof typeof DEV_SURFACES;

/** The rule, over the two facts it reads: hosted mode, and whether the live
 *  machine roster has answered with no machine at all. */
export function shownFor(hosted: boolean, noMachine: boolean, name: DevSurface): boolean {
  if (!hosted) return true;
  const rule: HostedRule = DEV_SURFACES[name];
  return rule === "machine" && !noMachine;
}

/** The words that change in hosted mode, where a developer word would
 *  confuse: a conversation, not a session; the assistant, not agents; a
 *  routine, not a trigger. Every shell label that differs reads it here. */
export const MODE_WORDS = {
  developer: {
    newConversation: "New session",
    conversationsPanel: "Toggle sessions panel",
    search: "Search sessions",
    recentConversations: "Recent Sessions",
    agentsGroup: "Agents",
    conversations: "Sessions",
    conversation: "Session",
    thisConversation: "this session",
    triggers: "Triggers",
    trigger: "Trigger",
    triggersPlural: "triggers",
    newTrigger: "New trigger",
    noTriggers: "No triggers yet",
    triggersLede: "agents that run on their own, later",
    freshPerRun: "Fresh session per run",
    freshPerRunTip: "Every run starts a fresh session (--spawn)",
    skippedRun: "skipped",
    openConversation: "open session",
    triggersRecurringTip: "Standing triggers that fire on an interval: click to filter",
    triggersOnceTip: "Triggers that fire once and finish: click to filter",
    triggersFailedTip: "Triggers whose last run failed: click to filter",
    noTriggersMatch: "No triggers match these filters",
    triggersEmptyHint: "Set triggers to run agents later (check CI, review PRs, continue work) from here or any session:",
    triggerPromptLabel: "Prompt",
    triggerPromptPlaceholder: 'What should the agent do? e.g. "Check if CI is green on main and report"',
    triggerTitlePlaceholder: "Optional: named from the prompt",
    triggerReadOnly: "read-only: report, don't change anything",
    createTrigger: "Set trigger",
    creatingTrigger: "Setting…",
    triggerCreated: "Trigger set",
    triggerCreateFailed: "Failed to set trigger",
    // Putting a conversation away (the inbox's row menu, swipe and the two
    // folded lists under it): stash keeps it running out of sight, kill
    // stops it.
    stash: "Stash",
    stashed: "Stashed",
    noStashed: "No stashed sessions",
    kill: "Kill Session",
    killConfirm: "Kill",
    killAsk: "Stop the agent and move this session to Killed?",
    killed: "Killed",
    noKilled: "No killed sessions",
    killAllStashed: "Kill all stashed",
    killAllAsk: "Stop every stashed session?",
    // The Killed list's footer, which pages in older rows (hooks/killedShelf).
    loadOlderKilled: "Load older kills",
    loadingOlderKilled: "Loading older kills…",
    noOlderKilled: "No older kills",
    loadOlderKilledFailed: "Couldn't load older killed sessions",
    // The inbox's section names for whose move it is.
    sectionQuestions: "Questions",
    sectionNew: "New",
    sectionNeedsInput: "Needs Input",
    sectionDormant: "Dormant",
    noActive: "No active sessions",
    inboxAllClear: "All sessions stashed, killed, or idle",
    noMessages: "Messages will appear here as the session progresses",
    stopWorking: "Stop the agent",
    // The notification nudge (NotificationNudgeBanner): at rest, after news
    // went unshown, and after a named person's message went unshown.
    notificationsOff: "Desktop notifications are off, so messages from your team arrive silently.",
    notificationMissed: "Codecast had news for you but couldn't show a notification.",
    notificationMissedFrom: "messaged you, and Codecast couldn't show a notification.",
  },
  hosted: {
    newConversation: "New conversation",
    conversationsPanel: "Toggle conversations panel",
    search: "Search conversations",
    recentConversations: "Recent Conversations",
    agentsGroup: "Assistant",
    conversations: "Conversations",
    conversation: "Conversation",
    thisConversation: "this conversation",
    triggers: "Routines",
    trigger: "Routine",
    triggersPlural: "routines",
    newTrigger: "New routine",
    noTriggers: "No routines yet",
    triggersLede: "work the assistant does on a schedule",
    freshPerRun: "A new conversation each time",
    freshPerRunTip: "Every run starts a new conversation",
    skippedRun: "nothing new",
    openConversation: "open conversation",
    triggersRecurringTip: "Routines that repeat on a schedule: click to filter",
    triggersOnceTip: "Routines that run once: click to filter",
    triggersFailedTip: "Routines whose last run failed: click to filter",
    noTriggersMatch: "No routines match these filters",
    triggersEmptyHint: "Have the assistant do something later or on a schedule, like a morning summary of your mail.",
    triggerPromptLabel: "Ask",
    triggerPromptPlaceholder: 'What should the assistant do? e.g. "Summarize my unread mail and flag anything urgent"',
    triggerTitlePlaceholder: "Optional: named from the request",
    triggerReadOnly: "Only report back, don't change anything",
    createTrigger: "Create routine",
    creatingTrigger: "Creating…",
    triggerCreated: "Routine created",
    triggerCreateFailed: "Couldn't create the routine",
    stash: "Set aside",
    stashed: "Set aside",
    noStashed: "Nothing set aside",
    kill: "Close conversation",
    killConfirm: "Close",
    killAsk: "Close this conversation? You can still find it under Closed.",
    killed: "Closed",
    noKilled: "No closed conversations",
    killAllStashed: "Close everything set aside",
    killAllAsk: "Close every conversation you set aside?",
    loadOlderKilled: "Show older closed conversations",
    loadingOlderKilled: "Loading…",
    noOlderKilled: "Nothing older",
    loadOlderKilledFailed: "Couldn't load older closed conversations",
    sectionQuestions: "Needs your answer",
    sectionNew: "New",
    sectionNeedsInput: "Waiting on you",
    sectionDormant: "Waiting",
    noActive: "Nothing open right now",
    inboxAllClear: "Nothing needs you right now",
    noMessages: "Ask for something below to get started",
    stopWorking: "Stop",
    // The notification nudge (NotificationNudgeBanner): at rest, after news
    // went unshown, and after a named person's message went unshown.
    notificationsOff: "Notifications are off, so you won't hear when your assistant replies.",
    notificationMissed: "Your assistant replied, but notifications are off so you didn't hear it.",
    notificationMissedFrom: "messaged you, and notifications are off so you didn't hear it.",
  },
} as const;

export type ModeWords = { [K in keyof (typeof MODE_WORDS)["developer"]]: string };

/** The whole mode, for a pure view that takes it as a prop: which surfaces
 *  show and the words to use. */
export type SurfaceMode = {
  shows: (name: DevSurface) => boolean;
  words: ModeWords;
  /** The page at `path` by this mode's name (modePageLabel), else `name`. */
  page: (path: string, name: string) => string;
  /** Whether the page at `path` shows: its surface (pageSurface) does, or it
   *  belongs to none. */
  showsPage: (path: string) => boolean;
};

function buildMode(hosted: boolean, shows: (name: DevSurface) => boolean): SurfaceMode {
  return {
    shows,
    words: MODE_WORDS[hosted ? "hosted" : "developer"],
    page: (path, name) => modePageLabel(path, hosted) ?? name,
    showsPage: (path) => {
      const surface = pageSurface(path);
      return !surface || shows(surface);
    },
  };
}

/** Developer mode: every surface, the developer words. A view's default. */
export const DEVELOPER_MODE: SurfaceMode = buildMode(false, () => true);

/** The mode for these two facts. */
export function surfaceMode(hosted: boolean, noMachine: boolean): SurfaceMode {
  if (!hosted) return DEVELOPER_MODE;
  return buildMode(true, (name) => shownFor(true, noMachine, name));
}

/** The surface each developer page belongs to. A page and everything under
 *  it (/ops/issues under /ops) share one entry, and the longest match wins,
 *  so a settings page can belong to the Machines group while /settings
 *  itself belongs to none. The rail's rows and the palette's Pages rows both
 *  read it through SurfaceMode.showsPage. */
const PAGE_SURFACES: Record<string, DevSurface> = {
  "/changes": "nav.changes",
  "/projects": "nav.projects",
  "/repo": "nav.code",
  "/files": "nav.files",
  "/line": "nav.line",
  "/ops": "nav.ops",
  "/windows": "nav.windows",
  "/routines": "nav.workflows",
  "/evals": "pages.devTools",
  "/memory": "pages.devTools",
  // The pages behind settings' Machines group, and the machine views.
  "/agent-features": "settings.machines",
  "/capabilities": "settings.machines",
  "/sessions": "settings.machines",
  "/resources": "settings.machines",
  "/settings/harness": "settings.machines",
  "/settings/provider-keys": "settings.machines",
  "/settings/cli": "settings.machines",
  "/settings/agents": "settings.machines",
  "/settings/agent-library": "settings.machines",
  "/settings/claude-accounts": "settings.machines",
  "/settings/devices": "settings.machines",
  "/settings/daemon": "settings.machines",
  "/settings/migrate": "settings.machines",
};

/** The surface the page at `path` belongs to, or null for a page every mode
 *  shows. */
export function pageSurface(path: string): DevSurface | null {
  let p = path.split("?")[0].split("#")[0];
  while (p.length > 1) {
    const surface = PAGE_SURFACES[p];
    if (surface) return surface;
    p = p.slice(0, p.lastIndexOf("/"));
  }
  return null;
}

/** Pages whose name is a mode word. This map is the one place a page is
 *  named by mode: the rail rows (SurfaceMode.page), the palette's Pages rows,
 *  tabs, the window title and the recent list (pathLabel, modePathLabel) all
 *  read it. */
const MODE_PAGES: Record<string, keyof ModeWords> = { "/triggers": "triggers" };

/** The mode's name for the page at `path`, or null when the page's name is
 *  the same in both modes. */
export function modePageLabel(path: string, hosted: boolean): string | null {
  const key = MODE_PAGES[path.split("?")[0].split("#")[0]];
  return key ? MODE_WORDS[hosted ? "hosted" : "developer"][key] : null;
}
