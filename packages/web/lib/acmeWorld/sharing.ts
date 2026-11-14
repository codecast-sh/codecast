// Settings > Sync & Privacy and Settings > Team: Alex's project folders with
// their sharing rules and session counts, and the team roster the settings
// pages read. Three repositories go to Acme, three folders stay with Alex;
// billing-api is the one a share review opens on. Mobile's Metro reaches
// this file, so imports stay relative.

import { DAY, HOUR, MIN, PEOPLE, TEAMS, TEAM_ID, TEAM_MEMBERS, cid } from "./world";

type Folder = { path: string; repo?: string; team?: boolean; sessions: number; firstDays: number; lastAgo: number };

const FOLDERS: Folder[] = [
  { path: "~/src/acme-api", repo: "github.com/acme/acme-api", team: true, sessions: 48, firstDays: 64, lastAgo: MIN },
  { path: "~/src/acme-web", repo: "github.com/acme/acme-web", team: true, sessions: 31, firstDays: 58, lastAgo: 6 * MIN },
  { path: "~/src/webhooks", repo: "github.com/acme/webhooks", team: true, sessions: 23, firstDays: 21, lastAgo: 20 * MIN },
  { path: "~/src/billing-api", repo: "github.com/acme/billing-api", sessions: 14, firstDays: 12, lastAgo: 3 * HOUR },
  { path: "~/src/notes", sessions: 9, firstDays: 40, lastAgo: 2 * DAY },
  { path: "~/src/scratch", sessions: 5, firstDays: 9, lastAgo: DAY },
];

const PROJECTS = (now: number) =>
  FOLDERS.map((f) => ({
    path: f.path,
    is_git_repo: !!f.repo,
    session_count: f.sessions,
    first_active: now - f.firstDays * DAY,
    last_active: now - f.lastAgo,
    ...(f.repo ? { repository: f.repo, git_remote_url: `git@${f.repo.replace("/", ":")}.git` } : {}),
    team_id: f.team ? TEAM_ID : null,
    mapped_directly: !!f.team,
    auto_share: !!f.team,
  }));

const MAPPINGS = (now: number) =>
  FOLDERS.filter((f) => f.team).map((f) => ({
    _id: cid(`map${f.path}`),
    path_prefix: f.path,
    team_id: TEAM_ID,
    team_name: "Acme",
    auto_share: true,
    share_since: null,
    repository: f.repo,
    created_at: now - f.firstDays * DAY,
  }));

const IMPACT = (args: any) => {
  const now = Date.now();
  const out: Record<string, unknown> = {};
  for (const path of args?.path_prefixes ?? []) {
    const f = FOLDERS.find((x) => x.path === path);
    if (!f) continue;
    out[path] = {
      count: f.sessions,
      first_started_at: now - f.firstDays * DAY,
      last_started_at: now - f.lastAgo,
      truncated: false,
      older: 0,
      // Everything but today's two sessions started before local midnight.
      older_than_day: Math.max(0, f.sessions - 2),
      hidden: 0,
      manually_shared: 0,
    };
  }
  return out;
};

const BILLING_TITLES = [
  "Retry failed invoice webhooks",
  "Backoff schedule for invoice events",
  "Dead-letter table for invoice deliveries",
  "Refund webhook idempotency keys",
  "Signed payloads for invoice events",
  "Replay dropped invoice.paid events",
  "Ledger 502s during restarts",
  "Webhook attempt history endpoint",
  "Invoice PDF rendering timeout",
  "Tax rounding on multi-currency invoices",
  "Stripe SDK v14 call sites",
  "Rate limit on the invoices API",
  "Postgres 16 invoice indexes",
  "Billing API health checks",
];

const SESSIONS_FOR_PATH = (args: any) => {
  const now = Date.now();
  const paths: string[] = args?.path_prefixes ?? [];
  if (!paths.includes("~/src/billing-api")) return { rows: [], total: 0, truncated: false };
  const rows = BILLING_TITLES.map((title, i) => ({
    _id: cid(`billingapi${i}`),
    title,
    started_at: now - (i < 2 ? (i + 1) * HOUR : (i * 0.8 + 0.5) * DAY),
    message_count: 12 + ((i * 7) % 40),
    is_private: false,
    team_visibility: null,
  }));
  return { rows, total: rows.length, truncated: false };
};

/** Query answers for the stub (convexStub ACME_ANSWERS). */
export const SHARING_ANSWERS: Record<string, (args: any) => unknown> = {
  "users:getRecentProjectsWithGitInfo": () => PROJECTS(Date.now()),
  "users:getDirectoryTeamMappings": () => MAPPINGS(Date.now()),
  "users:shareImpactForPaths": IMPACT,
  "users:listConversationsForPath": SESSIONS_FOR_PATH,
  "teams:getTeamMembers": () => {
    const now = Date.now();
    // When each member's daemon last checked in (Settings > Team reads it as Online or "N hours ago").
    const seen: Record<string, number> = { [PEOPLE.me._id]: 10_000, [PEOPLE.sarah._id]: 20_000, [PEOPLE.maya._id]: 30_000, [PEOPLE.jordan._id]: 3 * HOUR, [PEOPLE.priya._id]: DAY };
    return TEAM_MEMBERS(now).map((m) => ({ ...m, daemon_last_seen: now - seen[m._id] }));
  },
  "teams:getTeam": () => ({ ...TEAMS[0], created_by: PEOPLE.me._id, created_at: Date.now() - 120 * DAY }),
};
