// Acme's code as the Code view reads it: acme/acme-api's src/webhooks.ts with
// git blame, the sessions behind its commits (session blame), and the commit
// that added the retry cap, whose Codecast-Session trailer names Alex's lead
// session. Answered through the repo browse queries, so the pages' own feeders
// fill the repoBrowse and commits collections. Mobile's Metro reaches this
// file, so imports stay relative.

import type { AcmePart } from "./parts";
import { DAY, HOUR, PEOPLE, SESSIONS, TEAM_ID, type Person } from "./world";
import { TEAM_SESSIONS as T } from "./teamSessions";

export const CODE_REPO = "acme/acme-api";
export const CODE_FILE = "src/webhooks.ts";
export const CAP_SHA = "4f2c9e1b7a3d5f60c8e2b19d4a7f3c6e1b0d9a52";

const FILE = `import { signed } from "./signing";
import { queue } from "./queue";
import type { WebhookEvent } from "./types";

/** Attempts after the first delivery fails. */
export const MAX_ATTEMPTS = 5;

/** Wait before attempt n (2s, 4s, 8s, 16s), with up to 20% jitter. */
export function backoff(attempt: number): number {
  const base = 1000 * 2 ** attempt;
  return base + Math.random() * base * 0.2;
}

/** A status worth trying again: the endpoint may answer next time. */
export function retryable(status: number): boolean {
  if (status === 410) return false;
  return status === 429 || status >= 500;
}

export async function deliver(event: WebhookEvent): Promise<number> {
  const res = await fetch(event.endpoint, signed(event));
  return res.status;
}

export async function attempt(event: WebhookEvent, n: number) {
  const status = await deliver(event).catch(() => 504);
  if (status < 300) return queue.done(event, n);
  if (!retryable(status) || n >= MAX_ATTEMPTS) {
    return queue.deadLetter(event, { status, attempts: n });
  }
  return queue.later(event, n + 1, backoff(n));
}

export function receive(event: WebhookEvent) {
  return attempt(event, 1);
}

// Replays an event by hand, from the dashboard's Retry button.
export function retryNow(event: WebhookEvent) {
  return attempt(event, 1);
}

/** What the dashboard shows for one event's attempts. */
export function history(event: WebhookEvent) {
  return queue.attempts(event).map((a) => ({
    at: a.at,
    status: a.status,
    next: a.n < MAX_ATTEMPTS ? backoff(a.n) : null,
  }));
}
`;

const LINES = FILE.trimEnd().split("\n").length;

type Commit = { sha: string; message: string; who: Person; ago: number; session?: { _id: string; short_id: string; title: string; who: Person } };

const lead = { ...SESSIONS.lead, who: PEOPLE.me };
const COMMITS: Commit[] = [
  { sha: CAP_SHA, message: `Cap webhook retries at 5 attempts\n\nA delivery that fails its fifth attempt goes to the dead-letter queue\nwith its last status instead of retrying forever.\n\nCodecast-Session: https://codecast.sh/conversation/${SESSIONS.lead._id}`, who: PEOPLE.me, ago: 2 * HOUR, session: lead },
  { sha: "9a1e5c3f7b2d4e6081c3a5f7d9b1e3c5a7f9d1b3", message: `Back off retries exponentially with jitter\n\nCodecast-Session: ${T.backoff._id}`, who: PEOPLE.maya, ago: 2 * DAY, session: T.backoff },
  { sha: "c7d3a9e5b1f2c4d6e8a0b2c4d6e8f0a1b3c5d7e9", message: `Treat 410 Gone as final\n\nCodecast-Session: ${T.dlq._id}`, who: PEOPLE.sarah, ago: 26 * HOUR, session: { ...T.dlq, who: PEOPLE.sarah, title: "Treat 410 Gone as final" } },
  { sha: "1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d", message: "Initial webhook receiver", who: PEOPLE.jordan, ago: 40 * DAY },
];

/** Which commit wrote each line range (1-based, inclusive). */
const RANGES: [number, number, number][] = [
  [1, 3, 3],
  [4, 12, 1],
  [13, 17, 2],
  [18, 30, 0],
  [31, 33, 2],
  [34, LINES, 0],
];

const commitRow = (c: Commit, now: number) => ({
  _id: `hero-commit-${c.sha.slice(0, 7)}`,
  sha: c.sha,
  repository: CODE_REPO,
  team_id: TEAM_ID,
  branch: "main",
  message: c.message,
  author_name: c.who.name,
  author_email: c.who.email,
  author_login: c.who.handle,
  author_avatar_url: c.who.image,
  timestamp: now - c.ago,
  conversation_id: c.session?._id ?? null,
  insertions: c.sha === CAP_SHA ? 14 : 30,
  deletions: c.sha === CAP_SHA ? 3 : 4,
  files_changed: c.sha === CAP_SHA ? 2 : 1,
  files: c.sha === CAP_SHA
    ? [
        { filename: CODE_FILE, status: "modified", additions: 9, deletions: 3, changes: 12, patch: "@@ -22,9 +22,15 @@ export async function deliver(event: WebhookEvent): Promise<number> {\n   return res.status;\n }\n \n-export async function attempt(event: WebhookEvent) {\n+export async function attempt(event: WebhookEvent, n: number) {\n   const status = await deliver(event).catch(() => 504);\n-  if (status < 300) return queue.done(event);\n-  return queue.later(event, backoff());\n+  if (status < 300) return queue.done(event, n);\n+  if (!retryable(status) || n >= MAX_ATTEMPTS) {\n+    return queue.deadLetter(event, { status, attempts: n });\n+  }\n+  return queue.later(event, n + 1, backoff(n));\n }\n" },
        { filename: "src/webhooks.test.ts", status: "modified", additions: 5, deletions: 0, changes: 5, patch: "@@ -40,3 +40,8 @@\n+test(\"a fifth failure dead-letters the event\", async () => {\n+  const event = failing(503);\n+  for (let n = 1; n <= 5; n++) await attempt(event, n);\n+  expect(queue.deadLetters).toContain(event);\n+});\n" },
      ]
    : [],
});

const blame = (now: number) => ({
  ranges: RANGES.map(([start_line, end_line, i]) => {
    const c = COMMITS[i];
    return { start_line, end_line, sha: c.sha, message: c.message.split("\n")[0], author_name: c.who.name, author_login: c.who.handle, author_avatar_url: c.who.image, committed_at: now - c.ago };
  }),
});

const blameSessions = () => ({
  by_sha: Object.fromEntries(
    COMMITS.filter((c) => c.session).map((c) => [
      c.sha,
      { conversation_id: c.session!._id, short_id: c.session!.short_id, title: c.session!.title, author_name: c.session!.who.name, author_image: c.session!.who.image, via: "trailer" as const },
    ]),
  ),
  line_matches: [],
});

const log = (now: number) => ({
  commits: COMMITS.map((c) => ({
    sha: c.sha,
    message: c.message,
    author_name: c.who.name,
    author_login: c.who.handle,
    author_avatar_url: c.who.image,
    timestamp: now - c.ago,
    conversation_id: c.session?._id ?? null,
    session: c.session ? { _id: c.session._id, title: c.session.title } : null,
    tasks: [],
    pr_number: null,
  })),
});

const forRepo = (a: any, fn: () => unknown) => (a?.repository === CODE_REPO ? fn() : null);

export const CODE_PART: AcmePart = {
  name: "code",
  answers: {
    "repos:canBrowse": (a) => a?.repository === CODE_REPO,
    "repos:getBlob": (a) => forRepo(a, () => (a.path === CODE_FILE ? { content: FILE, size: FILE.length, truncated: false, sha: "b7e1c9d3a5f2" } : null)),
    "repos:getBlame": (a) => forRepo(a, () => (a.path === CODE_FILE ? blame(Date.now()) : null)),
    "repos:getBlameSessions": (a) => forRepo(a, () => (a.path === CODE_FILE ? blameSessions() : null)),
    "repos:getLog": (a) => forRepo(a, () => log(Date.now())),
    "commits:getCommitBySha": (a) => {
      const c = COMMITS.find((x) => x.sha === a?.sha);
      return c ? commitRow(c, Date.now()) : null;
    },
    "commits:neighbours": (a) => {
      const i = COMMITS.findIndex((x) => x.sha === a?.sha);
      const pick = (c?: Commit) => (c ? { sha: c.sha, message: c.message.split("\n")[0] } : undefined);
      return i < 0 ? {} : { newer: pick(COMMITS[i - 1]), older: pick(COMMITS[i + 1]) };
    },
  },
};
