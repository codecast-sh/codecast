// The Sentry adapter (docs/architecture/external-data.md X7). Sentry already
// groups errors into issues, so codecast mirrors issues rather than counting
// occurrences: each read hands an issue's whole state (count, users, first and
// last seen, level, release, status) to ingest.mirrorGroups, which folds it
// into the issue's event_groups row under the mirror rule in
// lib/ingestGroups.ts. Transitions, triggers and promotion are the ingest
// core's; nothing here decides one.
//
// Three ways in:
// - A poll every two minutes (crons.ts) per active Sentry source: unresolved
//   issues seen in the last 24 hours, newest first, a few pages at most. An
//   issue that drops out of that list while open here is read by id, which is
//   how a resolve in Sentry reaches the mirror without the webhook.
// - The webhook (/api/webhooks/sentry), from an internal integration's issue
//   and alert hooks: verified, deduped by Request-ID, processed on a schedule.
//   It only removes the poll's lag; the poll alone is complete.
// - On-demand reads (issueDetail) and writes (setIssueStatus), each an
//   explicit call by an authenticated reader of the group. Nothing resolves or
//   ignores in Sentry on its own.
//
// The token comes from tokenConnectors.getTokenCredential and never leaves the
// actions here. Every Sentry call refuses redirects, so a token is never
// carried to a host the person did not connect.

import { v } from "convex/values";
import { httpAction } from "../_generated/server";
import { action, internalAction, internalMutation, internalQuery } from "../functions";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { requireUserOrToken } from "../lib/auth";
import { verifyHmacHex } from "../lib/hmac";
import { connectionForWork } from "../oauthConnectors";
import { SENTRY_SLUG, type FetchLike, type TokenConfig } from "../tokenConnectors";
import { claimWebhookDelivery, groupByRef, mirrorGroups, type MirroredGroup } from "../ingest";
import { linkReplayToGroup } from "../replays";
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
const FETCH_TIMEOUT_MS = 15_000;

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

const orgPath = (t: SentryTarget) => `${t.host}/api/0/organizations/${encodeURIComponent(t.org)}`;

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

function time(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const t = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function str(value: unknown, max = 500): string | undefined {
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
function issueProject(issue: any): { slug?: string; id?: string } {
  return { slug: str(issue?.project?.slug, 64), id: str(issue?.project?.id, 32) };
}

/** Whether a source reads this project and environment. Unknown values match only an unfiltered source. */
export function targetReads(t: SentryTarget, at: { project_slug?: string; project_id?: string; environment?: string }): boolean {
  if (t.projects.length && !t.projects.some((p) => p === at.project_slug || p === at.project_id)) return false;
  if (t.environments.length && at.environment !== undefined && !t.environments.includes(at.environment)) return false;
  return true;
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
const ISSUE_ACTIONS = new Set(["created", "resolved", "unresolved", "ignored", "archived"]);

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

// ── Issue detail ──

const MAX_FRAMES = 25;
const MAX_TAGS = 30;

export interface TrimmedFrame {
  file?: string;
  function?: string;
  line?: number;
  col?: number;
  in_app: boolean;
  /** The source line the frame stopped on, when Sentry has it. */
  code?: string;
}

/**
 * A stack's frames, innermost last, trimmed to what a reader needs: the
 * product's own frames (all of them when none are marked) plus the frame that
 * threw, the last MAX_FRAMES, with only the line it stopped on and no locals.
 */
export function trimFrames(frames: any[]): TrimmedFrame[] {
  if (!Array.isArray(frames)) return [];
  const anyInApp = frames.some((f) => f?.inApp);
  const kept = frames.filter((f, i) => !anyInApp || f?.inApp || i === frames.length - 1).slice(-MAX_FRAMES);
  return kept.map((f) => {
    const line = typeof f?.lineNo === "number" ? f.lineNo : undefined;
    const ctxLine = Array.isArray(f?.context) ? f.context.find((c: any) => Array.isArray(c) && c[0] === line) : undefined;
    return {
      ...(str(f?.filename ?? f?.absPath ?? f?.module, 300) ? { file: str(f?.filename ?? f?.absPath ?? f?.module, 300) } : {}),
      ...(str(f?.function, 200) ? { function: str(f?.function, 200) } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(typeof f?.colNo === "number" ? { col: f.colNo } : {}),
      in_app: !!f?.inApp,
      ...(ctxLine && str(ctxLine[1], 200) ? { code: str(ctxLine[1], 200) } : {}),
    };
  });
}

function tagValue(event: any, key: string): string | undefined {
  const tag = Array.isArray(event?.tags) ? event.tags.find((t: any) => t?.key === key) : undefined;
  return str(tag?.value, 200);
}

/** The session replay an event was recorded in, from its replay context or tag. */
export function replayIdOf(event: any): string | null {
  return str(event?.contexts?.replay?.replay_id, 64) ?? tagValue(event, "replayId") ?? tagValue(event, "replay_id") ?? null;
}

/** A latest event as a reader sees it: the exception with its trimmed stack, where it happened, and its tags. No locals, no request bodies. */
export function trimEvent(event: any) {
  if (!event || typeof event !== "object") return null;
  const entries: any[] = Array.isArray(event.entries) ? event.entries : [];
  const exceptions = (entries.find((e) => e?.type === "exception")?.data?.values ?? []).map((x: any) => {
    const frames = trimFrames(x?.stacktrace?.frames ?? []);
    return {
      type: str(x?.type, 200),
      value: str(x?.value, 1000),
      handled: x?.mechanism?.handled,
      frames,
      // The same frames as text, innermost first, the way a stack reads.
      stack: [...frames].reverse().map((f) => `  at ${f.function ?? "?"} (${f.file ?? "?"}${f.line !== undefined ? `:${f.line}` : ""}${f.col !== undefined ? `:${f.col}` : ""})`).join("\n"),
    };
  });
  const request = entries.find((e) => e?.type === "request")?.data;
  const tags = (Array.isArray(event.tags) ? event.tags : []).slice(0, MAX_TAGS).map((t: any) => ({ key: str(t?.key, 100) ?? "", value: str(t?.value, 200) ?? "" }));
  return {
    event_id: str(event.eventID ?? event.id, 64),
    at: time(event.dateCreated ?? event.dateReceived),
    title: str(event.title, 300),
    message: str(event.message, 2000),
    platform: str(event.platform, 50),
    release: str(event.release?.version ?? event.release, 200),
    environment: tagValue(event, "environment"),
    url: str(request?.url, 500),
    method: str(request?.method, 10),
    user_id: str(event.user?.id, 200),
    exceptions,
    tags,
  };
}

/* ==========================================================================
 * Sentry calls
 * ========================================================================== */

type Answer = { ok: true; json: any; link: string | null } | { ok: false; status: number; error: string };

/** One authenticated call. Redirects are refused; messages never carry the token. */
export async function sentryCall(fetchImpl: FetchLike, token: string, url: string, init: { method?: string; body?: unknown } = {}): Promise<Answer> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e: any) {
    return { ok: false, status: 0, error: `Could not reach Sentry at ${new URL(url).origin}: ${e?.message ?? "network error"}` };
  }
  if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, error: `Sentry redirected ${url}; reconnect with the final host` };
  if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, error: `Sentry refused the token (${res.status}); reconnect Sentry` };
  if (res.status === 404) return { ok: false, status: 404, error: `Sentry has nothing at ${url}` };
  if (!res.ok) return { ok: false, status: res.status, error: `Sentry answered ${res.status} at ${url}` };
  try {
    return { ok: true, json: await res.json(), link: res.headers.get("link") };
  } catch {
    return { ok: false, status: res.status, error: `${url} did not answer JSON` };
  }
}

/** A refusal no retry fixes: the token, the org or a project is wrong. The source stops until a person resumes it. */
export const isFatalStatus = (status: number) => status === 401 || status === 403 || status === 404;

/**
 * The numeric ids the list endpoint filters by. Slugs are looked up in the
 * org's projects (one call); ids pass through.
 */
export async function resolveProjectIds(fetchImpl: FetchLike, token: string, t: SentryTarget): Promise<{ ok: true; ids: string[] } | { ok: false; status: number; error: string }> {
  const slugs = t.projects.filter((p) => !/^\d+$/.test(p));
  if (!slugs.length) return { ok: true, ids: t.projects };
  const answer = await sentryCall(fetchImpl, token, projectsUrl(t));
  if (!answer.ok) return answer;
  const bySlug = new Map<string, string>((Array.isArray(answer.json) ? answer.json : []).map((p: any) => [String(p?.slug), String(p?.id)]));
  const ids: string[] = [];
  for (const p of t.projects) {
    if (/^\d+$/.test(p)) ids.push(p);
    else if (bySlug.has(p)) ids.push(bySlug.get(p)!);
    else return { ok: false, status: 404, error: `Sentry has no project ${p} in ${t.org}` };
  }
  return { ok: true, ids };
}

export interface PollRead {
  groups: MirroredGroup[];
  /** Issue ids the list returned, so open groups missing from it can be re-read. */
  seen: string[];
  /** The page cap cut the list short: absence from it proves nothing. */
  truncated: boolean;
  error?: { status: number; message: string };
}

/** The poll's list read: pages of unresolved issues until the cursor ends or the cap. */
export async function readUnresolved(fetchImpl: FetchLike, token: string, t: SentryTarget): Promise<PollRead> {
  const ids = await resolveProjectIds(fetchImpl, token, t);
  if (!ids.ok) return { groups: [], seen: [], truncated: true, error: { status: ids.status, message: ids.error } };
  const groups: MirroredGroup[] = [];
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < SENTRY_POLL.max_pages; page++) {
    const answer = await sentryCall(fetchImpl, token, issuesListUrl(t, ids.ids, cursor));
    if (!answer.ok) return { groups, seen, truncated: true, error: { status: answer.status, message: answer.error } };
    for (const issue of Array.isArray(answer.json) ? answer.json : []) {
      const m = issueToMirror(issue);
      if (!m) continue;
      groups.push(m);
      seen.push(m.external.id);
    }
    const next = nextCursor(answer.link);
    if (!next) return { groups, seen, truncated: false };
    cursor = next;
  }
  return { groups, seen, truncated: true };
}

/* ==========================================================================
 * Convex: the poll
 * ========================================================================== */

/** The connection a source reads through: its own, else the workspace's (team) or owner's (personal). */
async function sourceConnection(ctx: any, source: Doc<"event_sources">): Promise<any | null> {
  if (source.connection_id) {
    const row = await ctx.db.get(source.connection_id);
    return row && row.provider === "sentry" && !row.pending_confirm_hash ? row : null;
  }
  // A team workspace reads through the team's connection; a personal one only
  // through its owner's, never a team's it happens to route to.
  const teamWorkspace = source.workspace.startsWith("team:");
  return connectionForWork(ctx, "sentry", { team_id: teamWorkspace ? source.team_id : undefined, user_id: source.owner_user_id });
}

/** Cron: one poll action per active Sentry source. */
export const schedulePolls = internalMutation({
  args: {},
  handler: async (ctx) => {
    const sources = await ctx.db.query("event_sources").withIndex("by_provider_status", (q) => q.eq("provider", "sentry").eq("status", "active")).take(500);
    for (const [i, s] of sources.entries()) {
      // Spread across the interval so a workspace with many sources does not
      // hit Sentry's rate limit in one burst.
      await ctx.scheduler.runAfter(Math.min(i * 200, 60_000), internal.sources.sentry.pollSource, { source_id: s._id });
    }
    return sources.length;
  },
});

/** What a poll needs before it calls Sentry. Internal: the connection id is handed to getTokenCredential, never to a client. */
export const pollInputs = internalQuery({
  args: { source_id: v.id("event_sources") },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.source_id);
    if (!source || source.provider !== "sentry") return null;
    const connection = await sourceConnection(ctx, source);
    // Open mirrored groups seen inside the list's window: the ones the list
    // should still return, so one it does not is re-read by id.
    const since = Date.now() - SENTRY_POLL.window_ms;
    const open: string[] = [];
    for await (const g of ctx.db.query("event_groups").withIndex("by_source_last_seen", (q) => q.eq("source_id", source._id).gte("last_seen", since)).order("desc")) {
      if (g.status === "open" && g.external?.provider === "sentry") open.push(g.external.id);
      if (open.length >= 500) break;
    }
    return {
      status: source.status,
      config: source.config,
      connection_id: connection ? String(connection._id) : null,
      connection_config: (connection?.config ?? undefined) as TokenConfig | undefined,
      open,
    };
  },
});

/** A poll's outcome on the source row. A fatal refusal stops the source until a person resumes it. */
export const recordPoll = internalMutation({
  args: { source_id: v.id("event_sources"), error: v.optional(v.string()), fatal: v.optional(v.boolean()), connection_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.source_id);
    if (!source) return;
    const now = Date.now();
    const connectionId = args.connection_id ? ctx.db.normalizeId("app_installations", args.connection_id) : null;
    await ctx.db.patch(source._id, {
      last_poll_at: now,
      last_error: args.error,
      ...(args.fatal && source.status === "active" ? { status: "error" as const } : {}),
      // The connection the poll found is the one the source reads through
      // from now on, so a later personal connection cannot take its place.
      ...(connectionId && !source.connection_id ? { connection_id: connectionId } : {}),
      updated_at: now,
    });
  },
});

async function credential(ctx: any, connectionId: string | null): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  if (!connectionId) return { ok: false, error: "No Sentry connection: connect Sentry under Settings, Integrations" };
  const cred: any = await ctx.runAction(internal.tokenConnectors.getTokenCredential, { connection_id: connectionId });
  return cred.ok ? { ok: true, token: cred.token } : { ok: false, error: cred.error };
}

/** Mirror groups in pages the mutation can hold. */
async function writeMirrors(ctx: any, sourceId: Id<"event_sources">, groups: MirroredGroup[]): Promise<number> {
  let transitions = 0;
  for (let i = 0; i < groups.length; i += SENTRY_POLL.page_size) {
    const out: any = await ctx.runMutation(internal.ingest.applyMirrorBatch, {
      source_id: sourceId,
      groups_json: JSON.stringify(groups.slice(i, i + SENTRY_POLL.page_size)),
    });
    transitions += out.transitions;
  }
  return transitions;
}

export const pollSource = internalAction({
  args: { source_id: v.id("event_sources") },
  handler: async (ctx, args): Promise<{ mirrored: number; transitions: number; error?: string }> => {
    const inputs: any = await ctx.runQuery(internal.sources.sentry.pollInputs, { source_id: args.source_id });
    if (!inputs || inputs.status !== "active") return { mirrored: 0, transitions: 0 };
    const fail = async (error: string, fatal: boolean) => {
      await ctx.runMutation(internal.sources.sentry.recordPoll, { source_id: args.source_id, error, fatal });
      return { mirrored: 0, transitions: 0, error };
    };
    const target = sentryTarget(inputs.connection_config, inputs.config);
    if (!target.ok) return fail(target.error, true);
    const cred = await credential(ctx, inputs.connection_id);
    if (!cred.ok) return fail(cred.error, !inputs.connection_id);

    const read = await readUnresolved(fetch, cred.token, target.target);
    // Whatever was read before an error still lands.
    let transitions = await writeMirrors(ctx, args.source_id, read.groups);
    let mirrored = read.groups.length;
    let error = read.error;

    if (!read.truncated && !read.error) {
      const seen = new Set(read.seen);
      const missing = (inputs.open as string[]).filter((id) => !seen.has(id)).slice(0, SENTRY_POLL.recheck_max);
      const rechecked: MirroredGroup[] = [];
      for (const id of missing) {
        const answer = await sentryCall(fetch, cred.token, issueUrl(target.target, id));
        // A deleted issue answers 404; its group keeps its last state.
        if (!answer.ok) {
          if (answer.status !== 404) error = { status: answer.status, message: answer.error };
          continue;
        }
        const m = issueToMirror(answer.json);
        if (m) rechecked.push(m);
      }
      transitions += await writeMirrors(ctx, args.source_id, rechecked);
      mirrored += rechecked.length;
    }

    await ctx.runMutation(internal.sources.sentry.recordPoll, {
      source_id: args.source_id,
      error: error?.message,
      fatal: error ? isFatalStatus(error.status) : undefined,
      connection_id: inputs.connection_id ?? undefined,
    });
    return { mirrored, transitions, ...(error ? { error: error.message } : {}) };
  },
});

/** One issue re-read and mirrored: an alert's event names only the issue. */
export const refreshIssue = internalAction({
  args: { source_id: v.id("event_sources"), issue_id: v.string(), environment: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ mirrored: number; error?: string }> => {
    const inputs: any = await ctx.runQuery(internal.sources.sentry.pollInputs, { source_id: args.source_id });
    if (!inputs || inputs.status !== "active") return { mirrored: 0 };
    const target = sentryTarget(inputs.connection_config, inputs.config);
    if (!target.ok) return { mirrored: 0, error: target.error };
    const cred = await credential(ctx, inputs.connection_id);
    if (!cred.ok) return { mirrored: 0, error: cred.error };
    const answer = await sentryCall(fetch, cred.token, issueUrl(target.target, args.issue_id));
    if (!answer.ok) return { mirrored: 0, error: answer.error };
    const m = issueToMirror(answer.json);
    const project = issueProject(answer.json);
    if (!m || !targetReads(target.target, { project_slug: project.slug, project_id: project.id, environment: args.environment })) return { mirrored: 0 };
    await writeMirrors(ctx, args.source_id, [m]);
    return { mirrored: 1 };
  },
});

/* ==========================================================================
 * Convex: the webhook
 * ========================================================================== */

/**
 * `POST /api/webhooks/sentry`. Sentry signs the raw body with the internal
 * integration's client secret (Sentry-Hook-Signature, hex HMAC-SHA256) and
 * names each delivery with Request-ID. A missing secret is our
 * misconfiguration (500, so Sentry retries once it is set); a bad signature is
 * a caller we refuse (401). The work is scheduled and the answer is fast.
 */
export const sentryWebhook = httpAction(async (ctx, request) => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const raw = await request.text();
  const secret = process.env[SENTRY_WEBHOOK_SECRET_ENV];
  if (!secret) {
    console.error(`[sentry webhook] ${SENTRY_WEBHOOK_SECRET_ENV} not configured; refusing webhook`);
    return json(500, { error: "Webhook not configured" });
  }
  if (!(await verifyHmacHex(raw, request.headers.get("sentry-hook-signature"), secret))) return json(401, { error: "Invalid signature" });
  const requestId = request.headers.get("request-id");
  if (!requestId) return json(400, { error: "Missing Request-ID" });
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "Invalid JSON" });
  }
  const work = parseSentryWebhook(request.headers.get("sentry-hook-resource"), body);
  const result: any = await ctx.runMutation(internal.sources.sentry.takeWebhook, { request_id: requestId.slice(0, 200), work_json: JSON.stringify(work) });
  return json(200, result);
});

/** Dedupe by Request-ID, then schedule the work. A retried delivery schedules nothing. */
export const takeWebhook = internalMutation({
  args: { request_id: v.string(), work_json: v.string() },
  handler: async (ctx, args) => {
    const work = JSON.parse(args.work_json) as SentryWebhookWork;
    if (work.kind === "skip") return { ok: true, skipped: work.reason };
    if (!(await claimWebhookDelivery(ctx, "sentry", args.request_id))) return { ok: true, duplicate: true };
    await ctx.scheduler.runAfter(0, internal.sources.sentry.processWebhook, { work_json: args.work_json });
    return { ok: true, duplicate: false };
  },
});

/**
 * A delivery applied to every active Sentry source reading its org and
 * project. An issue hook carries the whole issue and is mirrored here; an
 * alert's event names only the issue, which each source re-reads.
 */
export const processWebhook = internalMutation({
  args: { work_json: v.string() },
  handler: async (ctx, args) => {
    const work = JSON.parse(args.work_json) as SentryWebhookWork;
    if (work.kind === "skip") return { sources: 0 };
    const sources = await ctx.db.query("event_sources").withIndex("by_provider_status", (q) => q.eq("provider", "sentry").eq("status", "active")).take(500);
    const now = Date.now();
    let applied = 0;
    for (const source of sources) {
      const connection = await sourceConnection(ctx, source);
      const target = sentryTarget(connection?.config, source.config);
      if (!connection || !target.ok || target.target.org !== work.org) continue;
      if (work.kind === "issue") {
        if (!targetReads(target.target, { project_slug: work.project_slug, project_id: work.project_id })) continue;
        const m = issueToMirror(JSON.parse(work.issue_json));
        if (!m) continue;
        await mirrorGroups(ctx, source, [m], now);
      } else {
        // An event names its project by numeric id only, so a source that
        // filters by slug is checked by refreshIssue on the issue it reads.
        const bySlug = target.target.projects.some((p) => !/^\d+$/.test(p));
        if (!bySlug && !targetReads(target.target, { project_id: work.project_id, environment: work.environment })) continue;
        await ctx.scheduler.runAfter(0, internal.sources.sentry.refreshIssue, { source_id: source._id, issue_id: work.issue_id, environment: work.environment });
      }
      applied++;
    }
    return { sources: applied };
  },
});

/* ==========================================================================
 * Convex: on-demand reads and writes
 * ========================================================================== */

/**
 * The Sentry issue behind a group the caller may read, and the connection to
 * read it through. Internal: the action that calls it returns the issue, never
 * the connection. Auth propagates from the calling action.
 */
export const issueTarget = internalQuery({
  args: { api_token: v.optional(v.string()), group: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const group = await groupByRef(ctx, userId, args.group);
    if (group.external?.provider !== "sentry") return { ok: false as const, error: `${group.short_id} is not a Sentry issue` };
    const source = await ctx.db.get(group.source_id);
    if (!source) return { ok: false as const, error: "The group's source was removed" };
    const connection = await sourceConnection(ctx, source);
    const target = sentryTarget(connection?.config, source.config);
    if (!connection) return { ok: false as const, error: "No Sentry connection: connect Sentry under Settings, Integrations" };
    if (!target.ok) return { ok: false as const, error: target.error };
    return {
      ok: true as const,
      group_id: group._id,
      short_id: group.short_id,
      source_id: source._id,
      issue_id: group.external.id,
      connection_id: String(connection._id),
      target: target.target,
    };
  },
});

/** A recording a Sentry event names, linked to its group so `cast replay show` can import it (X5). */
export const linkIssueReplay = internalMutation({
  args: { source_id: v.id("event_sources"), group_id: v.id("event_groups"), replay_id: v.string(), at: v.number() },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.source_id);
    if (!source || !(await ctx.db.get(args.group_id))) return null;
    return await linkReplayToGroup(ctx, source, args.replay_id, args.group_id, args.at);
  },
});

/**
 * The issue behind a group, its latest event with the stack trimmed, and the
 * replay that event was recorded in. Read live from Sentry; nothing but the
 * replay link is stored.
 */
export const issueDetail = action({
  args: { api_token: v.optional(v.string()), group: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> => {
    const t: any = await ctx.runQuery(internal.sources.sentry.issueTarget, args);
    if (!t.ok) return t;
    const cred = await credential(ctx, t.connection_id);
    if (!cred.ok) return cred;
    const [issue, event] = await Promise.all([
      sentryCall(fetch, cred.token, issueUrl(t.target, t.issue_id)),
      sentryCall(fetch, cred.token, latestEventUrl(t.target, t.issue_id)),
    ]);
    if (!issue.ok) return { ok: false, error: issue.error };
    const mirror = issueToMirror(issue.json);
    const latest = event.ok ? trimEvent(event.json) : null;
    const replayId = event.ok ? replayIdOf(event.json) : null;
    if (replayId) {
      await ctx.runMutation(internal.sources.sentry.linkIssueReplay, {
        source_id: t.source_id,
        group_id: t.group_id,
        replay_id: replayId,
        at: latest?.at ?? Date.now(),
      });
    }
    return {
      ok: true,
      group: t.short_id,
      issue: {
        id: t.issue_id,
        short_id: str(issue.json?.shortId, 64),
        title: mirror?.title,
        culprit: mirror?.culprit,
        level: mirror?.level,
        status: str(issue.json?.status, 40),
        substatus: str(issue.json?.substatus, 40),
        count: mirror?.count,
        users: mirror?.users,
        first_seen: mirror?.first_seen,
        last_seen: mirror?.last_seen,
        first_release: mirror?.first_release,
        last_release: mirror?.release,
        url: mirror?.external.url,
      },
      event: latest,
      event_error: event.ok ? undefined : event.error,
      replay_id: replayId,
    };
  },
});

/**
 * Resolve or ignore the issue in Sentry, then mirror what Sentry answers.
 * Only ever this explicit call: no transition, trigger or poll writes to
 * Sentry.
 */
export const setIssueStatus = action({
  args: { api_token: v.optional(v.string()), group: v.string(), status: v.union(v.literal("resolved"), v.literal("ignored"), v.literal("unresolved")) },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string; status?: string }> => {
    const t: any = await ctx.runQuery(internal.sources.sentry.issueTarget, { api_token: args.api_token, group: args.group });
    if (!t.ok) return t;
    const cred = await credential(ctx, t.connection_id);
    if (!cred.ok) return cred;
    const put = await sentryCall(fetch, cred.token, issueUrl(t.target, t.issue_id), { method: "PUT", body: { status: args.status } });
    if (!put.ok) return { ok: false, error: put.error };
    // The PUT answers with the changed fields only; the issue read is whole.
    const issue = await sentryCall(fetch, cred.token, issueUrl(t.target, t.issue_id));
    const m = issue.ok ? issueToMirror(issue.json) : null;
    if (m) await writeMirrors(ctx, t.source_id, [m]);
    return { ok: true, status: issue.ok ? str(issue.json?.status, 40) : args.status };
  },
});
