// What each agent feature is, told for the person deciding whether to turn it
// on: the outcome, where they will see it, when agents reach for it, and one
// thing to ask for once it is on. The catalog (snippets.ts) owns what a feature
// installs; this owns how it is explained. Every catalog slug, plus Stable
// context, has an entry (featureExplainers.test.ts holds that).
//
// Plain data, no React, so the CLI wizard can print it as well as the web.

export interface FeatureExplainer {
  /** The outcome in one sentence, in the reader's terms rather than the command's. */
  pitch: string;
  /** What changes for the person, and where in the app it shows. */
  youSee: string[];
  /** The moments an agent reaches for it. */
  agentsUse: string[];
  /** Something to ask an agent once the feature is on. */
  tryIt: string;
  /** The app surface the feature feeds, when it has one. */
  surface?: { label: string; path: string };
}

export const FEATURE_EXPLAINERS: Record<string, FeatureExplainer> = {
  stable: {
    pitch: "New sessions start already knowing what you and your team did recently.",
    youSee: [
      "Fewer \"what were we doing?\" openings: agents pick up threads from earlier sessions on their own.",
      "Solo reads your last 10 sessions; Team reads the team's last 15.",
    ],
    agentsUse: [
      "Automatically, once, at the start of every session. They never have to ask for it.",
    ],
    tryIt: "Open a fresh session and ask: what was I working on yesterday?",
  },
  memory: {
    pitch: "Agents look up what earlier sessions decided instead of working it out again.",
    youSee: [
      "Answers that cite the session and the line a decision was made in.",
      "Less repeated debugging: an agent finds the fix a teammate's session already landed.",
    ],
    agentsUse: [
      "Starting a task that someone has touched before.",
      "Debugging, to find who changed a file and why.",
      "When you refer to earlier work (\"like we did for auth\").",
    ],
    tryIt: "Why does the retry logic in the sync client back off the way it does?",
    surface: { label: "Search", path: "/search" },
  },
  state: {
    pitch: "Every thread carries a one-line status the agent keeps true, so you can scan the inbox instead of opening sessions.",
    youSee: [
      "A pinned line above the composer and on each inbox card: what it is doing, and whether it is working, blocked on you, or done.",
      "Blocked and finished threads stand out by color; a stale status shows as stale.",
    ],
    agentsUse: [
      "At each change of direction, when they get blocked, and when they finish.",
    ],
    tryIt: "Keep your thread state current while you work through this refactor.",
    surface: { label: "Inbox", path: "/inbox" },
  },
  messaging: {
    pitch: "Sessions can hand each other results and answers directly, without you relaying them.",
    youSee: [
      "Messages from other sessions inside a thread, marked with who sent them.",
      "One delivered result at the end of delegated work, not a stream of updates.",
    ],
    agentsUse: [
      "Delivering finished work to the session that asked for it.",
      "Answering another session's question, or warning it about a conflict.",
    ],
    tryIt: "When the migration is done, send the result to the session working on the API.",
  },
  forks: {
    pitch: "One agent can split work across helpers and give you back a single combined answer.",
    youSee: [
      "Workers nested under the session that started them, each with its own transcript.",
      "Parallel threads in your inbox only when you ask for them.",
    ],
    agentsUse: [
      "Fanning out independent pieces: an implementer per module, a reviewer, an audit.",
      "Running a quick prompt on another model, or moving a session to a different agent.",
    ],
    tryIt: "Have two workers try different fixes for the flaky test and tell me which holds up.",
  },
  decide: {
    pitch: "When an agent hits a judgment call, you get one clear question with options instead of an interruption.",
    youSee: [
      "A decision queue you clear in one sitting with the keyboard.",
      "Each card carries the context, the options and what each one costs, so you answer without opening the session.",
    ],
    agentsUse: [
      "Before something hard to reverse: a schema, a data migration, a deletion.",
      "Before spending money or touching production, or when the choice is a matter of taste.",
    ],
    tryIt: "If you need my call on the caching strategy, queue a decision and keep going on the rest.",
    surface: { label: "Questions", path: "/questions" },
  },
  chat: {
    pitch: "Agents post where your team already talks, and answer when someone asks them there.",
    youSee: [
      "Agent posts in team channels, marked as agent-written.",
      "Replies in a thread when someone mentions the team's agent.",
    ],
    agentsUse: [
      "Announcing a release or a blocker the whole team should know about.",
      "Reading a channel's history for context on a task.",
    ],
    tryIt: "Post a one-line note in #releases when the deploy finishes.",
    surface: { label: "Chat", path: "/chat" },
  },
  calls: {
    pitch: "What was decided out loud on a call reaches the work.",
    youSee: [
      "Agents quote the exact transcript line instead of paraphrasing a meeting.",
      "Tasks filed from a call link back to the moment they were agreed.",
    ],
    agentsUse: [
      "When a task says \"as discussed on the call\".",
      "Turning a huddle's action items into tasks.",
    ],
    tryIt: "Read yesterday's planning call and file a task for each action item.",
    surface: { label: "Calls", path: "/calls" },
  },
  tasks: {
    pitch: "Work agents take on shows up on your board, with progress and a clear done.",
    youSee: [
      "Tasks and plans on the board with who is working them and their latest progress.",
      "Steps nested under the goal they serve, and evidence attached when work is marked done.",
    ],
    agentsUse: [
      "Work that will outlive the session, needs a handoff, or coordinates several sessions.",
      "Not for small fixes they will finish right away.",
    ],
    tryIt: "Break the billing rewrite into a plan with tasks we can split across sessions.",
    surface: { label: "Tasks", path: "/tasks" },
  },
  triggers: {
    pitch: "Agents can schedule their own follow-ups, so work continues after the session goes quiet.",
    youSee: [
      "A list of scheduled, recurring and event-driven runs, each with its history.",
      "Results posted back to the thread that set them, and a nudge only when something needs you.",
    ],
    agentsUse: [
      "Checking CI half an hour after a push.",
      "Standing duties: a nightly sweep, a weekly digest, reacting to new PR comments.",
    ],
    tryIt: "After you push, check CI in 30 minutes and fix anything red.",
    surface: { label: "Triggers", path: "/triggers" },
  },
  workflows: {
    pitch: "Repeatable multi-step processes, with checks and approval gates where you want them.",
    youSee: [
      "A graph of each run: which step it is on, which passed, and buttons at your approval gates.",
    ],
    agentsUse: [
      "Only when you run a workflow. They never start one on their own.",
    ],
    tryIt: "Write a workflow that implements, typechecks, and waits for my approval before merging.",
    surface: { label: "Workflows", path: "/workflows" },
  },
  orchestration: {
    pitch: "Hand an agent a whole plan and it runs the team: implementers, reviewers and a final critic.",
    youSee: [
      "A plan advancing in waves, each task built in its own worktree and reviewed before it lands.",
    ],
    agentsUse: [
      "Only when you say \"orchestrate this plan\".",
    ],
    tryIt: "Orchestrate the plan for the settings redesign.",
    surface: { label: "Plans", path: "/plans" },
  },
  skills: {
    pitch: "Slash commands for the rituals that need more than one session can see.",
    youSee: [
      "/cast-pickup to start from where the team left off, /cast-handoff to pass work on, /cast-ship to see a PR to merge, and more.",
    ],
    agentsUse: [
      "When you type the command, or when a ritual fits (picking up after a break, ending the day).",
      "Each loads only when used, so they cost nothing until then.",
    ],
    tryIt: "/cast-why on a line that confuses you.",
  },
  pr: {
    pitch: "The session that opened a pull request looks after it until it merges.",
    youSee: [
      "Reviews you leave in codecast reach the owning session as one message.",
      "Threads answered and resolved, failing checks fixed, without you chasing it.",
    ],
    agentsUse: [
      "Reviewing a teammate's PR with line notes and one verdict.",
      "Owning a PR they opened: responding to review and keeping it green.",
    ],
    tryIt: "Review PR 482 and request changes if the migration is unsafe.",
  },
  visual: {
    pitch: "Agents show results as charts, diagrams and mockups right in the conversation.",
    youSee: [
      "Comparisons, timelines and metrics drawn inline, themed to the app, expandable to fullscreen.",
      "Screenshots that render in messages instead of local file paths.",
    ],
    agentsUse: [
      "When structure or size carries the meaning: a before and after, a breakdown, a flow.",
      "Plain text stays the default.",
    ],
    tryIt: "Compare the three caching options as a visual.",
  },
  publish: {
    pitch: "Anything an agent makes as a page gets a link you can open, share and comment on.",
    youSee: [
      "Reports and dashboards live at a stable link, embedded in the thread that made them.",
      "Versions you can diff or roll back, viewer comments, and optional passwords.",
    ],
    agentsUse: [
      "Delivering a report, dashboard or mockup that deserves its own page.",
    ],
    tryIt: "Publish a page summarizing this week's error trends.",
    surface: { label: "Pages", path: "/pages" },
  },
  mods: {
    pitch: "Ask an agent for a new view or tool inside codecast, and watch it get built in the conversation.",
    youSee: [
      "New panes, palette commands, sidebar sections and tracked object types, live in the app.",
      "Each change redraws in the thread as the agent pushes it.",
    ],
    agentsUse: [
      "When you want a dashboard, tracker or control that codecast does not have.",
    ],
    tryIt: "Build me a pane that lists my open PRs with their check status.",
    surface: { label: "Mods", path: "/mods" },
  },
  browser: {
    pitch: "Agents check their own UI work in your Chrome, with your sign-ins.",
    youSee: [
      "Screenshots, console errors and failed requests in the thread.",
      "Agent tabs grouped in the background, so your own browsing is untouched.",
    ],
    agentsUse: [
      "Verifying a UI change, reproducing a bug, or reading a page behind a login.",
    ],
    tryIt: "Open the settings page, change the theme, and show me a screenshot.",
    surface: { label: "Browser", path: "/browser" },
  },
  computer: {
    pitch: "Agents can use native Mac apps for you, in the background.",
    youSee: [
      "An orange agent cursor showing where it acts, without taking your screen or keyboard.",
      "Password managers refused and password fields hidden, always.",
    ],
    agentsUse: [
      "Work in a desktop app: a file picker, System Settings, a native dialog.",
    ],
    tryIt: "Open the exported PDF in Preview and tell me how many pages it has.",
  },
  sim: {
    pitch: "Agents test iOS builds on simulators they share, on your laptop or a cloud Mac.",
    youSee: [
      "Simulator screenshots in the thread as the agent taps through the app.",
      "No pile of booted simulators: idle ones shut down by themselves.",
    ],
    agentsUse: [
      "Installing a build and checking a screen or flow after a change.",
    ],
    tryIt: "Install the latest build and walk through sign-up, with a screenshot of each step.",
  },
  check: {
    pitch: "Typechecks answer in seconds and stop slowing the machine, however many agents run.",
    youSee: [
      "One shared typecheck per project instead of dozens of fresh ones under load.",
    ],
    agentsUse: [
      "Every time they verify a TypeScript change.",
    ],
    tryIt: "Typecheck the web app and fix what is red.",
  },
  limits: {
    pitch: "Hitting a usage limit pauses work instead of ending it.",
    youSee: [
      "Parked sessions resume at the reset, or move to a saved account with room.",
      "Agents finish their step instead of wrapping up early when a limit is near.",
    ],
    agentsUse: [
      "Automatically, when a limit lands. Turned on once a machine has more than one saved Claude account.",
    ],
    tryIt: "How much of my usage window is left, and when does it reset?",
  },
};
