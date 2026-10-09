/**
 * Guide registry — the deep technical articles under /documentation/<slug>.
 *
 * Each guide is a markdown file in ./content (imported raw by guideContent.ts)
 * rendered by the guide page (../[slug] route → GuidePage.tsx). This registry
 * is pure data — the single list the docs page, the guide page, the changelog
 * links, and the SEO manifest (lib/seoRoutes.ts) all read from, so a slug can
 * never drift from its content. Keep it importable outside Vite (bun server,
 * bun tests): no `?raw` imports, no browser APIs.
 *
 * Voice: a product guide for the people who use codecast. Say what the
 * feature does for them, how to turn it on in the app, what to ask an agent,
 * what they will see, and what it will and won't do. The cast commands are
 * what agents run, not what people type, so a guide shows the app (real
 * screenshots, clipped to the surface they explain, captured with
 * scripts/app-element-shot.ts and nothing private in frame) rather than
 * commands. Ground every claim in the product's actual behavior.
 */


/** Categories in the order the docs Guides section shows them. */
export const GUIDE_CATEGORIES = [
  "Agent features",
  "Recall",
  "Working together",
  "Tracking and automation",
  "Hands on the machine",
  "Machines and accounts",
  "Showing the work",
  "Under the hood",
] as const;

export type GuideCategory = (typeof GUIDE_CATEGORIES)[number];

export interface Guide {
  slug: string;
  title: string;
  /** One-line standfirst shown on cards and under the title. */
  dek: string;
  category: GuideCategory;
  /** ISO date the guide first went live (its first commit), shown in its header. */
  published: string;
  /** The feature this guide documents, as Agent features names it, when it is one people switch on there. */
  feature?: string;
}

/** Ordered as they appear in the docs Guides section. */
export const GUIDES: Guide[] = [
  {
    slug: "agent-snippets",
    published: "2026-08-07",
    title: "Agent features: what your agents know how to do",
    dek: "Switch features on for each computer, and every new session there learns to remember, delegate, track work, show results and use your machine.",
    category: "Agent features",
  },
  {
    slug: "memory",
    published: "2026-08-07",
    title: "Memory: agents that look up past work",
    dek: "Your agents search every session you can see, across your machines, agents and team, and answer with the session they found it in.",
    category: "Recall",
    feature: "memory",
  },
  {
    slug: "search-sessions-across-machines",
    published: "2026-09-25",
    title: "Search your history across every machine",
    dek: "Every computer you connect sends its sessions to one history, searchable from the web, the Mac app and your iPhone.",
    category: "Recall",
  },
  {
    slug: "which-session-wrote-this-line",
    published: "2026-09-18",
    title: "See which agent session wrote a line",
    dek: "Set Blame to Sessions on any file to see the session behind each line, and open the conversation where it was decided.",
    category: "Recall",
  },
  {
    slug: "messaging",
    published: "2026-08-07",
    title: "Messaging between sessions",
    dek: "Your sessions hand each other results and answers directly, so you stop relaying text between them.",
    category: "Working together",
    feature: "messaging",
  },
  {
    slug: "ambient-awareness",
    published: "2026-08-07",
    title: "Stable context: sessions that know what's been happening",
    dek: "New sessions start with a short list of what you and your team worked on recently, so they pick up threads instead of starting cold.",
    category: "Recall",
    feature: "stable",
  },
  {
    slug: "team-sessions",
    published: "2026-08-20",
    title: "See your whole team's agent sessions in one place",
    dek: "Every session your team runs, on every machine and agent, in one live feed and inbox, shared per folder.",
    category: "Working together",
  },
  {
    slug: "share-a-session",
    published: "2026-09-13",
    title: "Share a session with your team",
    dek: "Choose what the team sees of a session, share it by link or a few messages at a time, and how that compares to other tools.",
    category: "Working together",
  },
  {
    slug: "thread-state",
    published: "2026-08-12",
    title: "Pinned thread state",
    dek: "The agent keeps one short note on each session saying where it stands, above the composer and on its inbox card.",
    category: "Working together",
    feature: "state",
  },
  {
    slug: "decisions",
    published: "2026-09-20",
    title: "Decisions: asking without interrupting",
    dek: "Agents put the calls only you can make into one queue you clear when you choose to, and each answer goes back to the session that asked.",
    category: "Working together",
    feature: "decide",
  },
  {
    slug: "team-chat",
    published: "2026-09-20",
    title: "Team chat with your agents in the room",
    dek: "Channels, threads and DMs where you can hand a session or a role something by mentioning it, while agents stay quiet unless they're needed.",
    category: "Working together",
  },
  {
    slug: "calls",
    published: "2026-09-20",
    title: "Huddles, transcripts and walkie",
    dek: "Every huddle is transcribed under each speaker's name and leaves a summary, so your agents can quote what was said, and a session can join the call.",
    category: "Working together",
  },
  {
    slug: "forks-and-spawn",
    published: "2026-08-07",
    title: "Workers, forks and switching agents",
    dek: "Your agent can hand work to workers that report back to it, and you can fork a conversation to try two directions from the same point.",
    category: "Working together",
    feature: "forks",
  },
  {
    slug: "tasks-and-plans",
    published: "2026-08-07",
    title: "Tasks and plans",
    dek: "Agents file the work they take on, post progress and close it with what they verified, and you follow it on the Tasks and Plans pages.",
    category: "Tracking and automation",
    feature: "tasks",
  },
  {
    slug: "triggers",
    published: "2026-08-07",
    title: "Triggers",
    dek: "Agents schedule their own follow-ups, once, on a schedule or on a GitHub or Linear event, and you can set one yourself from the Triggers page.",
    category: "Tracking and automation",
    feature: "triggers",
  },
  {
    slug: "workflows",
    published: "2026-08-07",
    title: "Workflows",
    dek: "A fixed sequence of agent steps, checks and approval gates that runs the same way every time and waits for you where you want a say.",
    category: "Tracking and automation",
    feature: "workflows",
  },
  {
    slug: "orchestration",
    published: "2026-08-07",
    title: "Orchestration",
    dek: "Hand an agent a whole plan and it runs a team: implementers working in parallel, a reviewer on every task and critics on the result.",
    category: "Tracking and automation",
    feature: "orchestration",
  },
  {
    slug: "pull-requests",
    published: "2026-09-20",
    title: "Pull requests and issues",
    dek: "Every pull request gets a page with its checks and threads, the session that opened it fixes what reviewers and CI flag, and Linear or GitHub issues become tasks.",
    category: "Tracking and automation",
    feature: "pr",
  },
  {
    slug: "org-roles",
    published: "2026-09-20",
    title: "The org: roles that look after your work",
    dek: "Give lasting work to a role with an area, a charter and a standing session, and approve the changes your agents propose to the org.",
    category: "Tracking and automation",
  },
  {
    slug: "browser",
    published: "2026-09-20",
    title: "Let agents use your Chrome",
    dek: "Agents check pages in the Chrome you already use, logins included, from their own background tabs. Screenshots and errors come back to the conversation.",
    category: "Hands on the machine",
    feature: "browser",
  },
  {
    slug: "computer",
    published: "2026-09-20",
    title: "Computer use: agents in your Mac apps",
    dek: "Agents work in Preview, Slack, System Settings or your own desktop build, in the background, with an orange pointer that shows where they act.",
    category: "Hands on the machine",
    feature: "computer",
  },
  {
    slug: "typecheck",
    published: "2026-09-20",
    title: "Typecheck: one shared check for every agent",
    dek: "With Typecheck on, agents on a computer share one typecheck per project, so checks answer in seconds and a busy machine stays usable.",
    category: "Hands on the machine",
    feature: "check",
  },
  {
    slug: "skills",
    published: "2026-09-20",
    title: "Skills: slash commands for the jobs you repeat",
    dek: "Type / in a Claude Code session to pick up work, hand it over, get a second opinion or ship a pull request, the same careful way every time.",
    category: "Hands on the machine",
    feature: "skills",
  },
  {
    slug: "remote-and-cloud-sessions",
    published: "2026-09-20",
    title: "Run sessions on other machines and in the cloud",
    dek: "Start a session on another computer or a cloud machine in your AWS account, move it there and back, and watch it from anywhere.",
    category: "Machines and accounts",
  },
  {
    slug: "codex-cloud",
    published: "2026-10-02",
    title: "Codex Cloud tasks in codecast",
    dek: "Bring your Codex Cloud tasks into your inbox, start new ones with several attempts, and turn the result into a pull request or local changes.",
    category: "Machines and accounts",
  },
  {
    slug: "usage-limits",
    published: "2026-09-20",
    title: "Usage limits are a pause",
    dek: "When a Claude plan runs out, sessions wait for the reset or continue on another account you've saved, instead of stopping for good.",
    category: "Machines and accounts",
    feature: "limits",
  },
  {
    slug: "visual-canvas",
    published: "2026-08-07",
    title: "The visual canvas",
    dek: "Agents answer with charts, comparisons and diagrams drawn right in the conversation when a picture says it better than text.",
    category: "Showing the work",
    feature: "visual",
  },
  {
    slug: "publish",
    published: "2026-08-07",
    title: "Published pages",
    dek: "Agents turn reports and mockups into pages with their own link that you can share, gate, and get comments on.",
    category: "Showing the work",
    feature: "publish",
  },
  {
    slug: "sync-engine",
    published: "2026-09-20",
    title: "Why codecast feels instant, even offline",
    dek: "Everything you see comes from a copy on your device that the server keeps current, so screens open at once, your edits show immediately, and nothing is lost offline.",
    category: "Under the hood",
  },
];

export function getGuide(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}

/** "August 7, 2026" for an ISO date, read as a calendar day (no timezone shift). */
export function formatGuideDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

export function guideHref(slug: string): string {
  return `/documentation/${slug}`;
}
