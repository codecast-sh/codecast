/**
 * Chapter 12, Memory: fixture data for its views. Timestamps are offsets
 * applied to the mount-time `now` (see story.ts); `entities` answers any id
 * this chapter renders as a pill or card.
 *
 * Three weeks later: Sarah opens the palette and types "webhook retry"; the
 * sessions that did the work and the task come back. Then the file itself:
 * session blame ties the backoff line of src/billing/retry.ts to the lead
 * session that applied the decision, under the comment that says why.
 */

import type { EntityFixture } from "@/lib/entityDisplay";
import type { SessionBlameRange } from "@/lib/repoView";
import { DAY, EVIDENCE, HOUR, OBJECTS, PEOPLE, SESSIONS } from "./story";

/** Film-time cues inside the chapter (palette hold 75.8 to 78.0, blame 79.3 to 81.3). */
export const MEMORY = {
  /** The palette is open on its recent sessions as the camera sets off from the page (73.9). */
  palette: 74.0,
  query: "webhook retry",
  typeAt: 76.0,
  typeRate: 13,
  /** While the camera faces the palette, a row may be selected (see PaletteSearch). */
  selectFrom: 75.6,
  selectTo: 78.2,
  /** The file is open as the camera sets off from the palette (78.0). */
  blame: 78.1,
  focus: 79.9,
} as const;

/** The query the palette starts searching at: the server tier answers from three letters. */
export const SEARCH_MIN = 3;

const WEEKS3 = 21 * DAY;

/** Sarah's recent sessions, what the palette lists before she types. */
export const RECENT = [
  { _id: "hero-s-sarah3", title: "Refund webhook idempotency", project_path: "/Users/sarah/src/billing", ago: 2 * HOUR },
  { _id: "hero-s-sarah4", title: "Quarterly invoice export", project_path: "/Users/sarah/src/billing", ago: 6 * HOUR },
  { _id: "hero-s-sarah5", title: "Support macros for failed payments", project_path: "/Users/sarah/src/support", ago: DAY },
  { _id: "hero-s-sarah1", title: "Stripe signature check", project_path: "/Users/sarah/src/billing", ago: 3 * DAY },
] as const;

/** What the content search returns for the query, three weeks on. */
export const RESULTS = [
  { session: SESSIONS.lead, match: "A failed webhook retry goes to the queue with exponential backoff, at most 5 attempts.", matches: 6, ago: WEEKS3 },
  { session: SESSIONS.fork, match: `Replayed the failures both ways: ${EVIDENCE}.`, matches: 3, ago: WEEKS3 + 2 * HOUR },
  { session: SESSIONS.api, match: "Webhook retry states: pending, retrying, delivered, dead.", matches: 2, ago: WEEKS3 + 3 * HOUR },
] as const;

export const TASK = { _id: "hero-task-1", title: OBJECTS.task.title, short_id: OBJECTS.task.shortId, status: "done", ago: WEEKS3 - 2 * DAY } as const;

/** src/billing/retry.ts as it stands on main. */
export const FILE = {
  repository: OBJECTS.pr.repository,
  path: OBJECTS.blame.file,
  line: OBJECTS.blame.line,
  /** The first line in view: the camera reads the lines around 42. */
  top: 33,
  content: [
    'import { ledger } from "./ledger";',
    'import { deadLetter, enqueue, toFailure } from "./queue";',
    'import type { WebhookEvent } from "./types";',
    "",
    "export const MAX_ATTEMPTS = 5;",
    "const BASE_DELAY_MS = 2 * 60_000;",
    "const MAX_DELAY_MS = 16 * 60_000;",
    "",
    "export type Delivery = {",
    "  event: WebhookEvent;",
    "  attempt: number;",
    "  lastError?: string;",
    "  firstFailedAt: number;",
    "};",
    "",
    "/** Errors worth another try: the ledger restarting, timeouts, rate limits. */",
    "export function isRetryable(status: number | undefined): boolean {",
    "  if (status === undefined) return true;",
    "  return status === 429 || status >= 500;",
    "}",
    "",
    "function jitter(ms: number): number {",
    "  return Math.round(ms * (0.85 + Math.random() * 0.3));",
    "}",
    "",
    "export async function deliver(d: Delivery): Promise<void> {",
    "  const res = await ledger.post(d.event).catch(toFailure);",
    "  if (res.status && res.status < 300) return;",
    "  await retry(d, res.status, res.error);",
    "}",
    "",
    "export async function retry(d: Delivery, status?: number, error?: string) {",
    "  if (!isRetryable(status)) return deadLetter(d.event, error ?? `${status}`);",
    "  const attempt = d.attempt + 1;",
    "  if (attempt >= MAX_ATTEMPTS) {",
    "    return deadLetter(d.event, `gave up after ${MAX_ATTEMPTS} attempts`);",
    "  }",
    "",
    "  // Exponential, not fixed: replaying the failures both ways, a fixed 30s",
    "  // retry lost 3 events to a ledger restart and exponential lost none.",
    "  // 2, 4, 8, 16 minutes covers a restart with room to spare.",
    "  const base = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);",
    "  const delay = jitter(base);",
    "",
    "  await enqueue({ ...d, attempt, lastError: error }, { delayMs: delay });",
    "}",
    "",
    "export function nextAttemptAt(d: Delivery, now: number): number {",
    "  return now + Math.min(BASE_DELAY_MS * 2 ** d.attempt, MAX_DELAY_MS);",
    "}",
    "",
  ].join("\n"),
};

const who = (s: { id: string; shortId: string; title: string }, author: string, via: "edit" | "trailer") => ({
  conversation_id: s.id,
  short_id: s.shortId,
  title: s.title,
  author_name: author,
  via,
});

/** Session blame folded onto the file: which session wrote which run of lines. */
export function blameRanges(now: number): SessionBlameRange[] {
  const run = (start: number, end: number, s: Parameters<typeof who>[0] | null, ago: number, sha: string, message: string, via: "edit" | "trailer" = "edit"): SessionBlameRange => ({
    start_line: start,
    end_line: end,
    session: s ? who(s, PEOPLE.me.name, via) : null,
    git: { start_line: start, end_line: end, sha, message, author_name: PEOPLE.me.name, author_login: PEOPLE.me.handle, committed_at: now - ago },
    newest_at: now - ago,
  });
  return [
    run(1, 3, null, 90 * DAY, "4f1c2a9d0b7e", "billing: webhook types"),
    run(4, 25, SESSIONS.lead, WEEKS3, "a83e51c07d2f", "Retry failed webhooks with exponential backoff"),
    run(26, 30, SESSIONS.api, WEEKS3 + 3 * HOUR, "c19b7e2f4a01", "Webhook API: retry states and dead letters"),
    run(31, 38, SESSIONS.lead, WEEKS3, "a83e51c07d2f", "Retry failed webhooks with exponential backoff"),
    run(39, 44, SESSIONS.lead, WEEKS3 - HOUR, "e7d2096b3c55", `Backoff: exponential over fixed, per ${OBJECTS.decision.shortId}`),
    run(45, 47, SESSIONS.lead, WEEKS3, "a83e51c07d2f", "Retry failed webhooks with exponential backoff"),
    run(48, 51, SESSIONS.api, WEEKS3 + 3 * HOUR, "c19b7e2f4a01", "Webhook API: retry states and dead letters"),
  ];
}

export const VIEWER = PEOPLE.sarah;

export const entities: Record<string, EntityFixture> = {};
