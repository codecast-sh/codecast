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
  me: { id: "hero-u-ashot", name: "Ashot", handle: "ashot" },
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
  decision: { question: "Exponential or fixed backoff?" },
  trigger: { title: "Check CI every 4h" },
  pr: { repository: "acme/billing", number: 482, title: "Retry failed webhooks with exponential backoff" },
  page: { slug: "webhook-retries", title: "Webhook retry report", url: "codecast.sh/a/webhook-retries" },
  blame: { file: "src/billing/retry.ts", line: 42 },
  channel: { name: "eng" },
  hosts: { cloud: "linux-host-1", laptop: "macbook" },
} as const;

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
  /** 2 Conversation: the prompt drops in (the poster frame follows it). */
  prompt: 5.0,
  testsPass: 12.0,
  /** 3 Fan out: spawn blocks, then worker rows land in the list. */
  spawnA: 15.6,
  spawnB: 16.0,
  workerRowA: 16.6,
  workerRowB: 16.9,
  /** 4 Approve: the API worker asks; the phone tap approves it. */
  permissionAsk: 20.8,
  permissionApproved: 25.6,
  /** The answered stack leaves the lead's transcript. */
  permissionCleared: 26.0,
  /** 5 Talk: a message and its reply between the workers, then a fork. */
  messageSent: 29.6,
  replySent: 31.2,
  forked: 32.4,
  /** 6 Decide. */
  decisionAsked: 35.4,
  decisionAnswered: 37.8,
  /** 7 Work: the lead files a task, it lands on the board, an agent claims it. */
  taskFiled: 40.2,
  taskLands: 41.6,
  taskClaimed: 43.0,
  /** 8 Automation. */
  triggerFires: 49.0,
  /** 10 Integrations. */
  prOpened: 62.0,
  checksGreen: 64.5,
  merged: 66.0,
  /** 11 Publish. */
  published: 69.8,
  /** 12 Memory: the cut to three weeks later. */
  threeWeeks: 73.5,
} as const;

/**
 * What other chapters add to the foot of the lead's transcript, and the
 * height each adds there (px at the desk's width, measured; negative when it
 * leaves). The transcript is anchored to the composer, so the conversation
 * chapter glides its feed by these and nothing jumps when they mount.
 */
export const FEED_FOOT: { cue: number; h: number }[] = [
  { cue: CUES.permissionAsk, h: 48 }, // 4 Approve: the permission stack
  { cue: CUES.permissionCleared, h: -48 }, // answered, it leaves
  { cue: CUES.taskFiled, h: 150 }, // 7 Track: `cast task create`
];
