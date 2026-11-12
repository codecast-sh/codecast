// Sentry's shapes, pure: targets and URLs, parsing issues into mirrored
// groups, the webhook's work, and where a status change is written. Shared by
// sources/sentry.ts (the poll and the actions) and lib/sentryHttp.ts (the
// webhook route), which must not load sentry.ts: it reaches the big import
// cycle (ct-92432).
import { SENTRY_SLUG, type TokenConfig } from "../tokenConnectors";
import type { MirroredGroup } from "../lib/groupWrite";
import { HOUR_MS, hourStart, type Bucket } from "../lib/ingestGroups";
import { sentryIssueFingerprint } from "@codecast/shared/contracts/signalFingerprint";
import type { GroupStatus } from "@codecast/shared/contracts/ingest";

/** What one poll may read: 3 pages of 100 issues, and 10 issues re-read by id. */
export const SENTRY_POLL = {
  page_size: 100,
  max_pages: 3,
  recheck_max: 10,
  stats_period: "24h",
  window_ms: 24 * HOUR_MS,
} as const;

export const SENTRY_DEFAULT_HOST = "https://sentry.io";
export const SENTRY_WEBHOOK_SECRET_ENV = "SENTRY_WEBHOOK_SECRET";
/** The Sentry the deployment's webhook integration is installed on, when not sentry.io (a self-hosted Sentry). */
export const SENTRY_WEBHOOK_HOST_ENV = "SENTRY_WEBHOOK_HOST";
export const FETCH_TIMEOUT_MS = 15_000;

/* ==========================================================================
 * Parsing (pure)
 * ========================================================================== */

/** Where a source reads from: the connection's host and org, the source's projects and environments. */
export interface SentryTarget {
  host: string;
  org: string;
  /** Project slugs or numeric ids; empty reads every project the token sees. */
  projects: string[];
  environments: string[];
}

/**
 * The target for a source, or an error a person can act on. The org and host
 * come from the connection, which validated them with a live call; a source
 * naming another org is refused rather than quietly reading the connection's.
 */
export function sentryTarget(
  connection: TokenConfig | undefined,
  sourceConfig: { org?: string; projects?: string[]; environments?: string[] } | undefined,
): { ok: true; target: SentryTarget } | { ok: false; error: string } {
  const org = connection?.org || sourceConfig?.org;
  if (!org || !SENTRY_SLUG.test(org)) return { ok: false, error: "The Sentry connection names no organization" };
  if (sourceConfig?.org && connection?.org && sourceConfig.org !== connection.org) {
    return { ok: false, error: `The source reads ${sourceConfig.org} but the Sentry connection is for ${connection.org}` };
  }
  const projects = (sourceConfig?.projects ?? []).map((p) => p.trim()).filter(Boolean);
  const bad = projects.find((p) => !SENTRY_SLUG.test(p));
  if (bad) return { ok: false, error: `"${bad}" is not a Sentry project slug or id` };
  return {
    ok: true,
    target: {
      host: (connection?.host || SENTRY_DEFAULT_HOST).replace(/\/+$/, ""),
      org,
      projects,
      environments: (sourceConfig?.environments ?? []).map((e) => e.trim()).filter(Boolean),
    },
  };
}

export const orgPath = (t: SentryTarget) => `${t.host}/api/0/organizations/${encodeURIComponent(t.org)}`;

/** One page of the poll's list: unresolved, newest activity first, the last 24 hours. */
export function issuesListUrl(t: SentryTarget, projectIds: string[], cursor?: string): string {
  const q = new URLSearchParams();
  // -1 is every project the token can see; no project param means only the
  // token owner's own projects.
  for (const id of projectIds.length ? projectIds : ["-1"]) q.append("project", id);
  for (const env of t.environments) q.append("environment", env);
  q.set("query", "is:unresolved");
  q.set("sort", "date");
  q.set("statsPeriod", SENTRY_POLL.stats_period);
  q.set("limit", String(SENTRY_POLL.page_size));
  if (cursor) q.set("cursor", cursor);
  return `${orgPath(t)}/issues/?${q}`;
}

export const issueUrl = (t: SentryTarget, issueId: string) => `${orgPath(t)}/issues/${encodeURIComponent(issueId)}/`;
export const latestEventUrl = (t: SentryTarget, issueId: string) => `${issueUrl(t, issueId)}events/latest/`;
export const projectsUrl = (t: SentryTarget) => `${orgPath(t)}/projects/?per_page=100`;

/** The next page's cursor from Sentry's Link header, or null when there is none with results. */
export function nextCursor(link: string | null): string | null {
  for (const part of (link ?? "").split(/,\s*(?=<)/)) {
    if (!/rel="next"/.test(part) || !/results="true"/.test(part)) continue;
    const m = /cursor="([^"]+)"/.exec(part);
    if (m) return m[1];
  }
  return null;
}

/** Sentry's status as a group status, or null for an issue on its way out (deletion, merge). */
export function sentryStatus(status: unknown): GroupStatus | null {
  switch (status) {
    case "resolved":
    case "resolvedInNextRelease":
      return "resolved";
    case "ignored":
    case "muted":
    case "archived":
      return "ignored";
    case "pending_deletion":
    case "deletion_in_progress":
    case "pending_merge":
      return null;
    default:
      return "open";
  }
}

export function time(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const t = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export function str(value: unknown, max = 500): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  return s ? s.slice(0, max) : undefined;
}

/** The hourly counts in an issue's `stats["24h"]` ([[unix seconds, count], ...]) as buckets. */
export function statsBuckets(stats: unknown): Bucket[] | undefined {
  const rows = (stats as any)?.[SENTRY_POLL.stats_period];
  if (!Array.isArray(rows)) return undefined;
  const out: Bucket[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const [sec, count] = row;
    if (typeof sec === "number" && typeof count === "number" && count > 0) out.push({ hour: hourStart(sec * 1000), count });
  }
  return out;
}

/**
 * One Sentry issue (the list, detail and webhook shapes alike) as a mirrored
 * group, or null when it is not one (no id, no times, being deleted).
 */
export function issueToMirror(issue: any): MirroredGroup | null {
  if (!issue || typeof issue !== "object") return null;
  const id = str(issue.id, 64);
  const status = sentryStatus(issue.status);
  const firstSeen = time(issue.firstSeen);
  const lastSeen = time(issue.lastSeen) ?? firstSeen;
  if (!id || !status || firstSeen === null || lastSeen === null) return null;
  const count = Number(issue.count);
  const users = Number(issue.userCount);
  const release = str(issue.lastRelease?.version, 200);
  const firstRelease = str(issue.firstRelease?.version, 200);
  const resolvedIn = str(issue.statusDetails?.inRelease, 200);
  const hourly = statsBuckets(issue.stats);
  const url = str(issue.permalink ?? issue.web_url, 500);
  return {
    kind: "error",
    fp: sentryIssueFingerprint(id),
    title: str(issue.title ?? issue.metadata?.title, 300) ?? `Sentry issue ${id}`,
    ...(str(issue.culprit, 300) ? { culprit: str(issue.culprit, 300) } : {}),
    ...(str(issue.level, 20) ? { level: str(issue.level, 20) } : {}),
    status,
    count: Number.isFinite(count) && count > 0 ? count : 1,
    ...(Number.isFinite(users) && users >= 0 ? { users } : {}),
    first_seen: firstSeen,
    last_seen: Math.max(firstSeen, lastSeen),
    ...(release ? { release } : {}),
    ...(firstRelease ? { first_release: firstRelease } : {}),
    ...(resolvedIn ? { resolved_in: resolvedIn } : {}),
    regressed: issue.isRegression === true || issue.substatus === "regressed",
    ...(hourly ? { hourly } : {}),
    external: { provider: "sentry", id, ...(url ? { url } : {}) },
  };
}

/** The project an issue belongs to, as slug and id, for matching a source's project list. */
export function issueProject(issue: any): { slug?: string; id?: string } {
  return { slug: str(issue?.project?.slug, 64), id: str(issue?.project?.id, 32) };
}

/** Whether a source reads this project and environment. Unknown values match only an unfiltered source. */
export function targetReads(t: SentryTarget, at: { project_slug?: string; project_id?: string; environment?: string }): boolean {
  if (t.projects.length && !t.projects.some((p) => p === at.project_slug || p === at.project_id)) return false;
  if (t.environments.length && at.environment !== undefined && !t.environments.includes(at.environment)) return false;
  return true;
}

/** The origin of the Sentry whose signed deliveries arrive here. */
export function webhookHost(): string {
  return (process.env[SENTRY_WEBHOOK_HOST_ENV] || SENTRY_DEFAULT_HOST).replace(/\/+$/, "");
}

/**
 * Whether a source's Sentry host is the one the webhook comes from. On
 * sentry.io every *.sentry.io host (regional, org subdomains) is Sentry's
 * own; a self-hosted webhook host matches only its own origin.
 */
export function onWebhookHost(host: string, hook: string = webhookHost()): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(host);
    b = new URL(hook);
  } catch {
    return false;
  }
  if (a.protocol !== "https:" || a.port !== b.port) return false;
  const name = a.hostname.toLowerCase();
  const hookName = b.hostname.toLowerCase();
  if (hookName === "sentry.io") return name === "sentry.io" || name.endsWith(".sentry.io");
  return name === hookName;
}

/**
 * The org slug a webhook payload's URLs name: `/organizations/<org>/`,
 * `/projects/<org>/<project>/`, or an `<org>.sentry.io` host. Null when none
 * does, and a delivery that names no org reaches no source.
 */
export function sentryOrgFromUrl(...urls: unknown[]): string | null {
  for (const raw of urls) {
    if (typeof raw !== "string") continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    const path = /\/organizations\/([^/]+)\//.exec(url.pathname) ?? /\/api\/0\/projects\/([^/]+)\//.exec(url.pathname);
    if (path && SENTRY_SLUG.test(path[1])) return path[1];
    const host = /^([a-z0-9][a-z0-9-]*)\.sentry\.io$/i.exec(url.hostname);
    if (host && !["us", "de", "www", "api"].includes(host[1].toLowerCase())) return host[1];
  }
  return null;
}

/** What a webhook delivery asks of the mirror. */
export type SentryWebhookWork =
  | { kind: "issue"; org: string; issue_json: string; project_slug?: string; project_id?: string }
  | { kind: "event"; org: string; issue_id: string; project_id?: string; environment?: string }
  | { kind: "skip"; reason: string };

/** The issue hook actions that change what the mirror shows. Assignment and comments do not. */
export const ISSUE_ACTIONS = new Set(["created", "resolved", "unresolved", "ignored", "archived"]);

/** A verified delivery's body, read for the work it asks. Pure, so the route answers fast and the rules test without Convex. */
export function parseSentryWebhook(resource: string | null, body: any): SentryWebhookWork {
  if (resource === "issue") {
    const issue = body?.data?.issue;
    if (!ISSUE_ACTIONS.has(body?.action)) return { kind: "skip", reason: `issue ${body?.action ?? "?"}` };
    if (!issue?.id) return { kind: "skip", reason: "no issue" };
    const org = sentryOrgFromUrl(issue.url, issue.web_url, issue.permalink, issue.project_url);
    if (!org) return { kind: "skip", reason: "no organization in the payload" };
    const project = issueProject(issue);
    return { kind: "issue", org, issue_json: JSON.stringify(issue), project_slug: project.slug, project_id: project.id };
  }
  if (resource === "event_alert") {
    const event = body?.data?.event;
    const issueId = str(event?.issue_id ?? event?.group_id, 64);
    if (!issueId) return { kind: "skip", reason: "no issue id" };
    const org = sentryOrgFromUrl(event?.web_url, event?.url, event?.issue_url);
    if (!org) return { kind: "skip", reason: "no organization in the payload" };
    return { kind: "event", org, issue_id: issueId, project_id: str(event?.project, 32), environment: str(event?.environment, 100) };
  }
  return { kind: "skip", reason: `resource ${resource ?? "?"}` };
}


export type IssueStatus = "resolved" | "ignored" | "unresolved";

/** Where a group's status is set for an outside writer: Sentry's own issue for a mirrored group, else the group row. */
export function sentryStatusFor(group: { external?: { provider: string } }, status: GroupStatus): IssueStatus | null {
  if (group.external?.provider !== "sentry" || status === "muted") return null;
  return status === "open" ? "unresolved" : status;
}
