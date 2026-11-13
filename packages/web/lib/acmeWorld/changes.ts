// The Acme team's Changes page: what shipped in acme/billing and acme/web
// over the last two weeks, told as stories and editions, the shape
// changesQueries returns. The webhook retry work of the inbox and the plan
// lands here as today's lead. Answered by the offline Convex client
// (./convexStub), so the page's own feeders write it to the store.

import { PEOPLE, SESSIONS, TEAM_ID } from "./world";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** YYYY-MM-DD in the team's day (UTC, TEAMS[0].timezone). */
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
/** ISO week `2026-W46` of a YYYY-MM-DD. */
function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / DAY - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

type StorySeed = {
  key: string;
  daysAgo: number;
  hour: number;
  repo?: string;
  area: string;
  kind: string;
  importance: number;
  headline: string;
  dek: string;
  authors: string[];
  plus: number;
  minus: number;
  files: number;
  sessions?: string[];
};

const STORY_SEEDS: StorySeed[] = [
  { key: "webhook-retry-queue", daysAgo: 0, hour: 3, area: "webhooks", kind: "feature", importance: 3, headline: "Failed webhooks now retry on their own", dek: "Up to 5 attempts with backoff; a 410 is logged once and never retried", authors: [PEOPLE.me.name], plus: 1284, minus: 96, files: 14, sessions: [SESSIONS.lead._id, SESSIONS.api._id] },
  { key: "retry-dashboard", daysAgo: 0, hour: 2, repo: "acme/web", area: "dashboard", kind: "feature", importance: 2, headline: "Dashboard shows each webhook's attempt history", dek: "A retry button on every failed delivery, with the reason for each attempt", authors: [PEOPLE.maya.name], plus: 612, minus: 40, files: 9, sessions: [SESSIONS.ui._id] },
  { key: "stripe-v14", daysAgo: 0, hour: 5, area: "billing", kind: "upgrade", importance: 2, headline: "Stripe SDK upgraded to v14", dek: "38 call sites migrated; refunds and payouts unchanged", authors: [PEOPLE.me.name], plus: 744, minus: 702, files: 38, sessions: [SESSIONS.stripe._id] },
  { key: "hmac-signing", daysAgo: 1, hour: 7, area: "webhooks", kind: "security", importance: 2, headline: "Webhook payloads are signed with HMAC", dek: "Receivers can verify every event with the endpoint's secret", authors: [PEOPLE.sarah.name], plus: 318, minus: 22, files: 6 },
  { key: "audit-export", daysAgo: 1, hour: 4, repo: "acme/infra", area: "infra", kind: "feature", importance: 1, headline: "Audit log exports to S3 every night", dek: "One manifest per day, so an auditor can pull any range", authors: [PEOPLE.priya.name], plus: 402, minus: 18, files: 7, sessions: [SESSIONS.audit._id] },
  { key: "pg16", daysAgo: 1, hour: 2, area: "ledger", kind: "infra", importance: 2, headline: "Invoices moved to Postgres 16", dek: "Migration ran clean on staging and prod, 0 rows lost", authors: [PEOPLE.maya.name], plus: 210, minus: 164, files: 11, sessions: [SESSIONS.pg._id] },
  { key: "idempotency", daysAgo: 3, hour: 6, area: "webhooks", kind: "fix", importance: 2, headline: "Refund webhooks are idempotent", dek: "Replaying an event can no longer refund twice", authors: [PEOPLE.sarah.name], plus: 188, minus: 31, files: 5 },
  { key: "rate-limit", daysAgo: 4, hour: 5, repo: "acme/gateway", area: "gateway", kind: "feature", importance: 2, headline: "The public API is rate limited per key", dek: "A token bucket holds 4,000 requests a second on one node", authors: [PEOPLE.jordan.name], plus: 530, minus: 44, files: 8, sessions: [SESSIONS.rate._id] },
  { key: "checkout-e2e", daysAgo: 8, hour: 4, repo: "acme/web", area: "checkout", kind: "fix", importance: 1, headline: "Checkout tests use a card CI can't exhaust", dek: "The flaky e2e moved off the shared 4242 card", authors: [PEOPLE.jordan.name], plus: 76, minus: 58, files: 4 },
  { key: "payout-schedule", daysAgo: 9, hour: 6, area: "billing", kind: "feature", importance: 3, headline: "Payouts can run weekly or monthly", dek: "Each connected account picks its schedule in settings", authors: [PEOPLE.me.name, PEOPLE.sarah.name], plus: 902, minus: 120, files: 17 },
  { key: "invoice-pdf", daysAgo: 10, hour: 3, area: "billing", kind: "feature", importance: 2, headline: "Invoices render as PDF in 120 ms", dek: "Server-side rendering replaced the headless browser", authors: [PEOPLE.maya.name], plus: 466, minus: 380, files: 12 },
];

function storyRow(s: StorySeed, now: number) {
  const at = now - s.daysAgo * DAY - s.hour * HOUR;
  const repository = s.repo ?? "acme/billing";
  return {
    _id: `hero-story-${s.key}`,
    _creationTime: at,
    team_id: TEAM_ID,
    repository,
    date: dayOf(at),
    story_key: s.key,
    area: s.area,
    branch: "main",
    on_default_branch: true,
    commit_shas: [`${s.key.replace(/[^a-z]/g, "").slice(0, 7).padEnd(7, "a")}`],
    conversation_ids: s.sessions ?? [],
    pr_ids: [],
    author_names: s.authors,
    actor_user_ids: [],
    insertions: s.plus,
    deletions: s.minus,
    files_changed: s.files,
    area_counts: { [s.area]: s.files },
    risks: [],
    first_at: at - 40 * MIN,
    last_at: at,
    headline: s.headline,
    dek: s.dek,
    kind: s.kind,
    importance: s.importance,
    prose_status: "written",
    inputs_hash: s.key,
    generated_at: at + 5 * MIN,
    private_session_count: 0,
  };
}

export const STORIES = (now: number) => STORY_SEEDS.map((s) => storyRow(s, now));

function edition(now: number, o: { scope: "day" | "week"; date: string; repository: string; headline: string; narrative: string; lead?: string; top?: string[] }) {
  return {
    _id: `hero-edition-${o.scope}-${o.repository.replace("/", "-")}-${o.date}`,
    _creationTime: now,
    team_id: TEAM_ID,
    scope: o.scope,
    date: o.date,
    repository: o.repository,
    headline: o.headline,
    narrative: o.narrative,
    lead_story_key: o.lead,
    top_story_keys: o.top,
    generated_at: now - 10 * MIN,
    status: o.scope === "week" ? "final" : "written",
    dirty_since: null,
    stale: false,
  };
}

export const EDITIONS = (now: number) => {
  const today = dayOf(now);
  const yesterday = dayOf(now - DAY);
  const lastWeek = isoWeek(dayOf(now - 8 * DAY));
  return [
    edition(now, { scope: "day", date: today, repository: "acme/billing", lead: "webhook-retry-queue", headline: "Webhooks retry on their own, and Stripe moves to v14", narrative: "A failed delivery now goes to a retry queue with exponential backoff, at most five attempts, so the two Stripe events support saw dropped overnight would have landed on the second try. The Stripe SDK upgrade migrated 38 call sites with refunds and payouts unchanged." }),
    edition(now, { scope: "day", date: yesterday, repository: "acme/billing", lead: "hmac-signing", headline: "Signed webhooks and invoices on Postgres 16", narrative: "Every webhook payload is now signed with the endpoint's secret, and the invoice tables moved to Postgres 16 with no rows lost." }),
    edition(now, {
      scope: "week",
      date: lastWeek,
      repository: "acme/billing",
      headline: "Payout schedules ship, and invoices render in 120 ms",
      narrative: "Connected accounts can now choose weekly or monthly payouts, the change most requested by marketplace customers this quarter. Invoice PDFs moved to server-side rendering and dropped from four seconds to 120 ms. Checkout's flaky end-to-end test moved off the shared test card, so CI stopped failing on rate limits.",
      top: ["payout-schedule", "invoice-pdf", "checkout-e2e"],
    }),
  ];
};

const inWindow = (date: string, a: { from_date?: string; to_date?: string }) => (!a.from_date || date >= a.from_date) && (!a.to_date || date <= a.to_date);
const inRepo = (repo: string, a: { repository?: string }) => !a.repository || a.repository === repo;

export const CHANGES_ANSWERS = {
  "changesQueries:listStories": (a: any) => {
    const stories = STORIES(Date.now()).filter((s) => inWindow(s.date, a) && inRepo(s.repository, a));
    return { stories, covered_from: a.from_date, complete: true };
  },
  "changesQueries:listEditions": (a: any) => EDITIONS(Date.now()).filter((e) => e.scope === a.scope && inWindow(e.date, a) && inRepo(e.repository, a)),
  "changesQueries:liveStatus": () => [],
  "changesQueries:inTheWorks": () => [],
};
