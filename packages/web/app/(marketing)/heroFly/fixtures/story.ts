/**
 * The film's one story, shared by every chapter: "retry failed webhooks" is
 * asked for, fanned out, approved, discussed, decided, tracked, automated,
 * talked over with the team, merged, published, and found again three weeks
 * later. The cast (people, sessions, objects) and the film-time cues of events
 * that one chapter causes and another shows live here, so chapters agree
 * without importing each other. Read-only for chapter builders: ask the
 * orchestrator for a change.
 *
 * Ids are `hero-*` (never Convex-shaped) and short ids use a `hero` stem, so
 * no fixture can resolve to a real row. Timestamps are offsets in ms, applied
 * as `now - ago` against the hero's mount-time `now`.
 */

import type { ConvexAgentType } from "@codecast/shared/contracts";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const PEOPLE = {
  me: { id: "hero-u-me", name: "Alex Rivera", handle: "alex" },
  sarah: { id: "hero-u-sarah", name: "Sarah Chen", handle: "sarah" },
  maya: { id: "hero-u-maya", name: "Maya Ortiz", handle: "maya" },
} as const;

type StorySession = { id: string; shortId: string; title: string; agent: ConvexAgentType; project: string };

export const SESSIONS = {
  lead: { id: "hero-s-lead", shortId: "jx7hero", title: "Retry failed webhooks", agent: "claude_code", project: "~/src/billing" },
  api: { id: "hero-s-api", shortId: "jx7hapi", title: "Webhook API half", agent: "codex", project: "~/src/billing" },
  ui: { id: "hero-s-ui", shortId: "jx7hrui", title: "Dashboard retry UI", agent: "cursor", project: "~/src/billing" },
  fork: { id: "hero-s-fork", shortId: "jx7hfrk", title: "Try fixed backoff", agent: "codex", project: "~/src/billing" },
} satisfies Record<string, StorySession>;

export const OBJECTS = {
  task: { shortId: "ct-hero1", title: "Retry queue for failed webhooks" },
  plan: { shortId: "pl-hero1", title: "Webhook reliability" },
  decision: { shortId: "sd-hero1", question: "Exponential or fixed backoff?" },
  trigger: { title: "Check CI every 4h" },
  pr: { repository: "acme/billing", number: 482, title: "Retry failed webhooks with exponential backoff" },
  page: { slug: "webhook-retries", title: "Webhook retry report", url: "codecast.sh/a/webhook-retries" },
  blame: { file: "src/billing/retry.ts", line: 42 },
  channel: { name: "eng" },
  hosts: { cloud: "linux-host-1", laptop: "macbook" },
} as const;

/** What the fork's replay found, the one piece of evidence the decision, the code and the search all cite. */
export const EVIDENCE = "a fixed 30s retry lost 3 events to a ledger restart, exponential lost none";

/** The lead's opening prompt, typed in the conversation and quoted elsewhere. */
export const PROMPT = "retry failed webhooks with backoff";

/**
 * Film-time cues (seconds) of events one chapter causes and others show. The
 * chapter that causes an event owns its cue's meaning; any chapter may read it.
 */
export const CUES = {
  /** 1 Inbox: the lead's row lands on top and takes focus. */
  leadLands: 3.4,
  leadSelected: 4.8,
  /** 2 Conversation: the prompt drops in, and the lead's plan answers it (the poster frame follows both). */
  prompt: 5.0,
  testsPass: 10.3,
  /** 3 Fan out: spawn blocks, then worker rows land in the list. */
  spawnA: 14.7,
  spawnB: 15.1,
  workerRowA: 15.7,
  workerRowB: 16.0,
  /** 4 Approve: the API worker asks in its own pane; the phone tap approves it. */
  permissionAsk: 21.6,
  permissionApproved: 25.6,
  /** The answered stack leaves the worker's transcript. */
  permissionCleared: 25.9,
  /** On the pull-back, the approval's arc from the phone lands on the worker. */
  approvalDrawn: 28.5,
  /** 5 Talk: a message and its reply between the workers, then a fork. */
  messageSent: 31.1,
  replySent: 32.5,
  forked: 33.6,
  /** 6 Decide. */
  decisionAsked: 37.8,
  decisionAnswered: 39.9,
  /** 7 Work: the lead files a task, it lands on the board, an agent claims it. */
  taskFiled: 42.0,
  taskLands: 43.5,
  taskClaimed: 44.8,
  /** 8 Automation. */
  triggerFires: 50.5,
  /** 10 Integrations: the lead opens the PR before the team talks it over (9), its checks go green, it merges. */
  prOpened: 53.8,
  checksGreen: 64.7,
  merged: 65.8,
  /** 11 Publish. */
  published: 70.9,
  /** 12 Memory: the cut to three weeks later. */
  threeWeeks: 74.3,
  /** 13 Anywhere: the API worker's row (on the cloud host) is opened, after the camera lands. */
  remoteOpen: 83.4,
} as const;

/**
 * What other chapters add to the foot of the lead's transcript, and the
 * height each adds there (px at the desk's width, measured; negative when it
 * leaves). The transcript is anchored to the composer, so the conversation
 * chapter glides its feed by these and nothing jumps when they mount.
 */
export const FEED_FOOT: { cue: number; h: number }[] = [
  { cue: CUES.taskFiled, h: 150 }, // 7 Track: `cast task create`
];

/** The permission stack's height at the foot of the API worker's transcript (px, measured); its boot entries glide by it. */
export const ASK_H = 48;
