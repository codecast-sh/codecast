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
  // The rail's Threads and Feed rows, and Work's Initiatives: a team's
  // activity and goals, not one person's errands.
  "nav.threads": "developer",
  "nav.feed": "developer",
  "nav.initiatives": "developer",
  // The rail's Agents group (workflows, the line, ops, the org and the
  // workspace's agent). In hosted mode Routines moves into Work and the
  // group goes, so the usage meter never sits under an empty heading.
  "nav.agentsGroup": "developer",
  // Shell banners and first-run prompts about machines.
  "banner.setup": "developer",
  "banner.cliOffline": "developer",
  "banner.tmuxMissing": "developer",
  "banner.deviceSetup": "developer",
  "banner.resourcePressure": "developer",
  // The notice that local saving is stalling. Sends are unaffected, so hosted
  // mode says only the blocked case, which the person can fix with a reload.
  "notice.storageStall": "developer",
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
  // The routines page as a fleet console: the overview line of counts, the
  // ±24h timeline, the up-next kicker, run counts, the health rail down each
  // row's edge and the countdown chips. Hosted mode lists each routine as its
  // name, its schedule in words and its next run.
  "triggers.fleetChrome": "developer",
  // The routine form's agent, project and daemon rows and its event
  // schedules. Without them the form arms a hosted assistant routine, which
  // runs on a schedule and never on an event.
  "triggers.devForm": "developer",
  // Pages for tuning and inspecting agents (evals, agent memory).
  "pages.devTools": "developer",
  // A company's pages (plans, team charts, the public community rooms, the
  // company document): the palette's Pages rows that are about running a
  // team of agents rather than one person's errands.
  "pages.company": "developer",
  // An inbox row's working detail on the phone: the status word, the
  // generated summary bullets, the person's last words behind a shell caret,
  // and the agent, model and message count. Without them a row is its title,
  // its time and one quiet line.
  "inbox.rowInternals": "developer",
  // The conversations panel's head toggles for working a fleet: the team
  // board, old sessions and the favorites shelf. The view menu stays.
  "inbox.internals": "developer",
  // The routines strip at the foot of the conversations panel: counts,
  // running, overdue and needs-attention chips. Hosted mode shows one quiet
  // line naming the next routine instead.
  triageFooter: "developer",
  // Integrations' services that only code work uses (GitHub, Linear, Sentry,
  // PostHog, a product's own routes: AppDescriptor.developerOnly) and the
  // product sources Ops reads.
  "settings.devIntegrations": "developer",
  // Integrations' Chrome extension block, which pairs the extension with the CLI.
  "settings.browserExtension": "machine",
  // What mods add to the rail (an "Open bugs" list) and to the palette (a
  // "Bug Desk" group): a workspace's own tooling, not one person's errands.
  "mods.sidebar": "developer",
  // The composer's hand-off-to-a-teammate button.
  "composer.handoff": "developer",
  // The browser-style tab strip over the main pane. Tabs inside a web page
  // mean nothing to a person who isn't running a fleet of sessions; the rail
  // and back and forward cover navigation, and the page keeps its one title.
  tabStrip: "developer",
  // The approvals page's stacking, ids and single-key hints.
  "questions.internals": "developer",
  // The rail's approvals row hiding while nothing waits. Developer mode keeps
  // an empty queue out of sight; hosted mode keeps the row in place, so the
  // promise "I always ask first" has a fixed place to look and the rail never
  // shifts when an approval arrives.
  "rail.questionsOnlyWhenWaiting": "developer",
  // A task row's working detail: its id, issue link, line chip, origin
  // glyph, session links and counts, plan chip, labels and every priority
  // arrow short of urgent. Hosted mode reads a task as its status, title,
  // assignee and age.
  "tasks.internals": "developer",
  // A list page's view machinery in its header and filter bar: the palette
  // chip, and copying, sending and saving a view.
  "lists.internals": "developer",
  // A search result's working detail: the role chip on a hit, "user only",
  // the team picker, how many worker sessions matched too, and the match or
  // title tag. Hosted mode shows the conversation, the words found and when.
  "search.internals": "developer",
  // The verbs for driving a fleet of sessions from the keyboard and the
  // palette: tabs, split panes, saved layouts, inbox views, the defer, dormant
  // and hide variants of triage, forks, queueing, the docked composer.
  // ACTION_SURFACES files each action under this or a narrower surface.
  "actions.fleet": "developer",
  // The ownership chip on a person's own conversation (their face beside the
  // title). It shows once someone else owns it too.
  "conversation.ownChip": "developer",
  // The message rail beside a short conversation. With a question or two
  // there is nothing to navigate and a lone tick reads as a stray mark; hosted
  // mode draws the rail from MIN_HOSTED_RAIL asks on.
  "conversation.shortRail": "developer",
  // A crash's working detail: the component's name, the stack, "Copy stack"
  // and "Just fix" (which starts a coding session on the trace). Hosted mode
  // says the page hit a problem, offers a reload, and logs the detail.
  "errors.developer": "developer",
  // A note's writing machinery in its header: the type picker, Watch, Review
  // and its chord, the drafting lab (LAB, word count, its rails), copying as
  // markdown and the split and close controls. Hosted mode keeps back, the
  // title, when it changed, share, star and the overflow.
  "docs.internals": "developer",
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
    putAway: "Put away",
    noKilled: "No killed sessions",
    killAllStashed: "Kill all stashed",
    killAllAsk: "Stop every stashed session?",
    // The Killed list's footer, which pages in older rows (hooks/killedShelf).
    loadOlderKilled: "Load older kills",
    loadingOlderKilled: "Loading older kills…",
    noOlderKilled: "No older kills",
    loadOlderKilledFailed: "Couldn't load older killed sessions",
    // The approvals page and its rail row.
    questionsPage: "Questions",
    questionsTip: "Decisions waiting on you",
    queueEmptyTitle: "Nothing needs you.",
    queueEmptyLede: "Your agents are working. New decisions appear here the moment an agent asks.",
    // The rail's names for the lists the assistant fills, matching what its
    // receipts say ("Wrote a note", "Added a to-do").
    tasksPage: "Tasks",
    docsPage: "Docs",
    // An approval's way to put it away without answering.
    dismissAsk: "Dismiss",
    dismissAskTip: "Dismiss without answering — the agent is not told",
    // The corner link that opens an approval on its own page.
    openAsk: "",
    // The composer's resting text.
    composerPlaceholder: "Send a message...",
    // The composer while an approval card waits on the person.
    composerApproval: "Approve or deny permission to continue...",
    // The palette's verb that puts a conversation back in the person's queue.
    markNeedsInput: "Mark needs input",
    // The docs page's count of what the list leaves out.
    agentDoc: "agent doc",
    agentDocs: "agent docs",
    // Integrations' subtitle.
    integrationsLede: "Mail and calendar through Whisk, the Chrome extension, Slack, GitHub, Linear, Google, Notion, and the product sources Ops reads",
    // Integrations' two ledgers.
    teamConnectionsLede: "Shared by everyone on the team picked here, for their work inside it. The keys stay with Codecast: your agents ask Codecast to act and never hold them.",
    personalConnectionsLede: "Yours alone, and they follow you: in any workspace you work in that has no connection of its own, an agent acting for you acts through these.",
    // The inbox's section names for whose move it is.
    sectionQuestions: "Questions",
    sectionNew: "New",
    sectionNeedsInput: "Needs Input",
    sectionDormant: "Dormant",
    sectionWorking: "Working",
    // The count beside the inbox title, after its number ("2 to decide").
    decisionsBadge: "to decide",
    inboxClearTitle: "Inbox zero",
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
    recentConversations: "Recent conversations",
    agentsGroup: "Assistant",
    conversations: "Conversations",
    conversation: "Conversation",
    thisConversation: "this conversation",
    triggers: "Routines",
    trigger: "Routine",
    triggersPlural: "routines",
    newTrigger: "New routine",
    noTriggers: "No routines yet",
    triggersLede: "Work your assistant does on a schedule",
    freshPerRun: "A new conversation each time",
    freshPerRunTip: "Every run starts a new conversation",
    skippedRun: "nothing new",
    openConversation: "open conversation",
    triggersRecurringTip: "Routines that repeat on a schedule: click to filter",
    triggersOnceTip: "Routines that run once: click to filter",
    triggersFailedTip: "Routines whose last run failed: click to filter",
    noTriggersMatch: "No routines match these filters",
    triggersEmptyHint: "Have the assistant do something later or on a schedule. Start from one of these, or write your own.",
    triggerPromptLabel: "Ask",
    triggerPromptPlaceholder: 'What should the assistant do? e.g. "Remind me to plan the week with a short checklist"',
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
    putAway: "Put away",
    noKilled: "No closed conversations",
    killAllStashed: "Close everything set aside",
    killAllAsk: "Close every conversation you set aside?",
    loadOlderKilled: "Show older closed conversations",
    loadingOlderKilled: "Loading…",
    noOlderKilled: "Nothing older",
    loadOlderKilledFailed: "Couldn't load older closed conversations",
    questionsPage: "Approvals",
    questionsTip: "Things waiting for your OK",
    queueEmptyTitle: "Nothing needs your OK right now.",
    queueEmptyLede: "Before I send, change or delete anything, I'll ask here first.",
    tasksPage: "To-dos",
    docsPage: "Notes",
    dismissAsk: "Not now",
    dismissAskTip: "Puts this away without an answer. The assistant isn't told, and the question stays in its conversation.",
    openAsk: "Open",
    composerPlaceholder: "Ask me anything, or tell me what to take off your plate",
    composerApproval: "Answer the card above, or tell me what to change",
    markNeedsInput: "Mark as waiting on me",
    agentDoc: "assistant note",
    agentDocs: "assistant notes",
    integrationsLede: "Mail and calendar through Whisk, and the apps your assistant can use",
    teamConnectionsLede: "Shared by everyone on the team picked here. The keys stay with Codecast: your assistant asks Codecast to act and never holds them.",
    personalConnectionsLede: "Yours alone. Your assistant uses these wherever you work, unless a team has its own.",
    sectionQuestions: "Needs your answer",
    sectionNew: "New",
    sectionNeedsInput: "Your turn to reply",
    sectionDormant: "Scheduled for later",
    sectionWorking: "Working on it",
    decisionsBadge: "to answer",
    inboxClearTitle: "All caught up",
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
  /** Hosted mode. */
  hosted: boolean;
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
    hosted,
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
  // The rail's rows that hosted mode hides, so the palette hides them too.
  "/threads": "nav.threads",
  "/feed": "nav.feed",
  // The team activity dashboard, the feed's page by another door.
  "/team/activity": "nav.feed",
  "/goals": "nav.initiatives",
  // The goals page's old address (lib/renamedPages.ts), which stored visits still carry.
  "/initiatives": "nav.initiatives",
  "/org": "nav.agentsGroup",
  "/anchor": "nav.agentsGroup",
  // A company's pages: its plans, charts, public rooms and charter.
  "/plans": "pages.company",
  "/community": "pages.company",
  "/team/charts": "pages.company",
  "/company": "pages.company",
  // Agents talking among themselves.
  "/crosstalk": "nav.feed",
  // The pages behind settings' Machines group, and the machine views.
  "/agent-features": "settings.machines",
  "/config": "settings.machines",
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

/** Keyboard and palette actions that belong to a surface: one rule for the
 *  palette's commands and the shortcuts sheet, so an action hidden in one is
 *  hidden in the other. A key ending in "." covers a family ("tab."). */
const ACTION_SURFACES: Record<string, DevSurface> = {
  "tab.": "tabStrip",
  "pane.": "actions.fleet",
  "workbench.": "actions.fleet",
  "app.section1": "actions.fleet",
  "app.section2": "actions.fleet",
  "app.section3": "actions.fleet",
  "app.section4": "actions.fleet",
  "view.switch": "actions.fleet",
  "inbox.toggleTriageBar": "triageBar",
  "session.stashHide": "actions.fleet",
  "session.deferAdvance": "actions.fleet",
  "session.dormantAdvance": "actions.fleet",
  "session.composeDock": "actions.fleet",
  "session.mruSwitch": "actions.fleet",
  "msg.fork": "actions.fleet",
  "msg.forkSend": "actions.fleet",
  "msg.queue": "actions.fleet",
  "msg.sendAdvance": "actions.fleet",
  "msg.sendDismiss": "actions.fleet",
  "msg.handoff": "composer.handoff",
  "conv.toggleTree": "actions.fleet",
  "conv.toggleThinking": "actions.fleet",
  "conv.ask": "actions.fleet",
  "compose.richToggle": "actions.fleet",
  "conv.toggleDiff": "diff",
  "terminal.toggle": "terminal",
  "anchor.toggle": "nav.agentsGroup",
  "vault.": "nav.files",
};

/** The surface an action belongs to, or null for one every mode offers. */
export function actionSurface(action: string): DevSurface | null {
  if (ACTION_SURFACES[action]) return ACTION_SURFACES[action];
  for (const [key, surface] of Object.entries(ACTION_SURFACES)) if (key.endsWith(".") && action.startsWith(key)) return surface;
  return null;
}

/** The shortcuts sheet's sections (shortcuts/sections.ts `when`) that only
 *  developer pages bind. */
const HELP_CONTEXT_SURFACES: Record<string, DevSurface> = {
  diff: "diff",
  review: "diff",
  evals: "pages.devTools",
  evalsRun: "pages.devTools",
  evalsSim: "pages.devTools",
  line: "nav.line",
  changes: "nav.changes",
  threads: "nav.threads",
};

/** The surface a shortcuts sheet section belongs to, or null. */
export function helpContextSurface(when: string | undefined): DevSurface | null {
  return when ? HELP_CONTEXT_SURFACES[when] ?? null : null;
}

/** What an action is called in hosted mode, where the developer words would
 *  confuse. An action missing here reads the same in both modes. */
export const HOSTED_ACTION_WORDS: Record<string, string> = {
  "session.next": "Next conversation",
  "session.prev": "Previous conversation",
  "session.jumpIdle": "Next conversation waiting on you",
  "session.jumpPinned": "Jump to a pinned conversation",
  "session.pin": "Pin or unpin conversation",
  "session.markUnread": "Mark conversation unread",
  "session.moveToBucket": "Label conversation",
  "session.stash": "Set aside",
  "session.kill": "Close conversation",
  "session.snooze": "Snooze conversation…",
  "session.compose": "New conversation",
  "session.create": "New conversation (full page)",
  "session.rename": "Rename conversation",
  "sidebar.toggleRight": "Toggle conversations panel",
  "permission.approve": "Approve",
  "permission.deny": "Decline",
  "conv.copyLink": "Copy conversation link",
  "inbox.toggleFlatView": "Inbox: assistant conversations or everything",
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
const MODE_PAGES: Record<string, keyof ModeWords> = { "/triggers": "triggers", "/questions": "questionsPage", "/tasks": "tasksPage", "/docs": "docsPage" };

/** The mode's name for the page at `path`, or null when the page's name is
 *  the same in both modes. */
export function modePageLabel(path: string, hosted: boolean): string | null {
  const key = MODE_PAGES[path.split("?")[0].split("#")[0]];
  return key ? MODE_WORDS[hosted ? "hosted" : "developer"][key] : null;
}
