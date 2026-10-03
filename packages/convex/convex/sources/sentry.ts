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
// - Replays: an event's replay id is linked to its group (issueDetail), and
//   the recording is imported the first time it is read (importReplay, through
//   vendorReplay.importLinked): the replay's project from Sentry, then its
//   rrweb recording segments, capped, into fromRrweb like PostHog's.
// - On-demand reads (issueDetail) and writes (setIssueStatus), each an
//   explicit call by an authenticated reader of the group. A write runs only
//   while a person's grant covers it (issue.resolve, issue.ignore: the same
//   writeRefusal check an app connector's actions pass) and is audited in
//   app_calls. Nothing resolves or ignores in Sentry on its own.
//
// A source reads through its workspace's own Sentry connection
// (tokenConnectors.connectionIdForSource), and the token comes from
// tokenConnectors.tokenFor and never leaves the actions here. Every Sentry
// call goes through lib/tokenHttp: redirects refused, answers capped.
//
// Webhook deliveries are signed with the deployment's one integration secret,
// so they come from the one Sentry that integration lives on. A delivery
// reaches only sources whose connection is on that Sentry: there, connecting
// proved the token reads the org, while a connection on any other host proves
// nothing about who owns an org of the same slug on sentry.io.

import { v } from "convex/values";
import { httpAction } from "../_generated/server";
import { action, internalAction, internalMutation, internalQuery } from "../functions";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { requireUserOrToken } from "../lib/auth";
import { resolveSessionConversation } from "../lib/access";
import { verifyHmacHex } from "../lib/hmac";
import { SENTRY_SLUG, connectionIdForSource, tokenFor, type FetchLike, type TokenConfig } from "../tokenConnectors";
import { jsonOf, tokenHttp } from "../lib/tokenHttp";
import { isTokenRefusal, markConnectionLost } from "../lib/sourceHealth";
import { claimWebhookDelivery, groupByRef, mirrorGroups, patchSourceStats, type MirroredGroup } from "../ingest";
import { takeFromWindow } from "../ipRateLimit";
import { linkReplayToGroup } from "../replays";
import { importVendorRecording, type ImportOutcome, type VendorRecording } from "./vendorReplay";
import type { RrwebEvent } from "@codecast/shared/replay";
import { HOUR_MS, hourStart, type Bucket } from "../lib/ingestGroups";
import { auditOutsideCall, grantUrlFor, type OutsideCall } from "./app";
import { scopeArgs } from "../ingest";
import { VENDOR_ACTIONS, sentryStatusAction, writeRefusal } from "@codecast/shared/contracts/appConnector";
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

type Answer = { ok: true; json: any; link: string | null; bytes?: number } | { ok: false; status: number; error: string; over?: boolean };

/**
 * One authenticated call through lib/tokenHttp (redirects refused, answer
 * capped, messages without the token), with Sentry's wording for refusals.
 * One answer past `maxBytes` is refused with `over`.
 */
export async function sentryCall(fetchImpl: FetchLike, token: string, url: string, init: { method?: string; body?: unknown; maxBytes?: number } = {}): Promise<Answer> {
  const res = await tokenHttp(fetchImpl, {
    url,
    method: init.method ?? "GET",
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    token,
    maxBytes: init.maxBytes,
    timeoutMs: FETCH_TIMEOUT_MS,
    vendor: "Sentry",
  });
  if (res.failure) return { ok: false, status: res.status, error: res.error!, ...(res.failure === "over" ? { over: true } : {}) };
  if (isTokenRefusal(res.status)) return { ok: false, status: res.status, error: `Sentry refused the token (${res.status}); reconnect Sentry` };
  if (res.status === 404) return { ok: false, status: 404, error: `Sentry has nothing at ${url}` };
  if (!res.ok) return { ok: false, status: res.status, error: `Sentry answered ${res.status} at ${url}` };
  const json = jsonOf(res.text);
  if (json === undefined) return { ok: false, status: res.status, error: `${url} did not answer JSON` };
  return { ok: true, json, link: res.link, bytes: res.bytes };
}

/** A refusal no retry fixes: the token, the org or a project is wrong. The source stops until a connection is stored again or a person resumes it. */
export const isFatalStatus = (status: number) => isTokenRefusal(status) || status === 404;

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

// ── Replays ──

/** Sentry replay ids are UUIDs, usually without dashes; checked so an id can never steer a path. */
export const SENTRY_REPLAY_ID = /^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What one import may read: 10 pages of 100 segments, 24 MB of segment JSON in all. */
export const SENTRY_REPLAY = { page_size: 100, max_pages: 10, max_bytes: 24 * 1024 * 1024 } as const;

export const replayUrl = (t: SentryTarget, replayId: string) => `${orgPath(t)}/replays/${encodeURIComponent(replayId)}/`;

/** One page of a replay's recording segments, each downloaded whole as its rrweb events. */
export function segmentsUrl(t: SentryTarget, project: string, replayId: string, cursor?: string): string {
  const q = new URLSearchParams({ download: "true", per_page: String(SENTRY_REPLAY.page_size) });
  if (cursor) q.set("cursor", cursor);
  return `${t.host}/api/0/projects/${encodeURIComponent(t.org)}/${encodeURIComponent(project)}/replays/${encodeURIComponent(replayId)}/recording-segments/?${q}`;
}

/** The rrweb events in a downloaded segments page: a list of segments, each a list of events. Anything else is skipped. */
export function segmentEvents(body: unknown): RrwebEvent[] {
  const out: RrwebEvent[] = [];
  for (const segment of Array.isArray(body) ? body : []) {
    for (const e of Array.isArray(segment) ? segment : [segment]) {
      if (e && typeof e === "object" && typeof e.type === "number" && typeof e.timestamp === "number") out.push(e as RrwebEvent);
    }
  }
  return out;
}

/**
 * One replay read from Sentry: its detail (project, start, user), then its
 * recording segments page by page up to the caps. A replay past a cap imports
 * its beginning and says so.
 */
export async function readSentryReplay(fetchImpl: FetchLike, token: string, t: SentryTarget, replayId: string): Promise<VendorRecording> {
  const meta = await sentryCall(fetchImpl, token, replayUrl(t, replayId));
  if (!meta.ok) throw new Error(meta.error);
  const data = meta.json?.data ?? meta.json;
  const project = str(data?.project_id ?? data?.project, 64);
  if (!project || !SENTRY_SLUG.test(project)) throw new Error(`Sentry names no project for replay ${replayId}`);
  const events: RrwebEvent[] = [];
  let budget: number = SENTRY_REPLAY.max_bytes;
  let cursor: string | undefined;
  let truncated = true;
  for (let page = 0; page < SENTRY_REPLAY.max_pages; page++) {
    const answer = await sentryCall(fetchImpl, token, segmentsUrl(t, project, replayId, cursor), { maxBytes: budget });
    if (!answer.ok) {
      // Over the budget keeps what was read; any other failure fails the import.
      if (answer.over) break;
      throw new Error(answer.error);
    }
    budget -= answer.bytes ?? 0;
    events.push(...segmentEvents(answer.json));
    const next = nextCursor(answer.link);
    if (!next) {
      truncated = false;
      break;
    }
    cursor = next;
  }
  const started = time(data?.started_at);
  const user = { id: str(data?.user?.id, 200), email: str(data?.user?.email, 200) };
  return { events, truncated, ...(started !== null ? { started_at: started } : {}), ...(user.id || user.email ? { user } : {}) };
}

/* ==========================================================================
 * Convex: the poll
 * ========================================================================== */

/**
 * The connection row a source reads through: strictly its workspace's own
 * (tokenConnectors.connectionIdForSource). Its id and non-secret config only
 * leave this module; the token is read in the actions by tokenFor.
 */
async function sourceConnection(ctx: any, source: Doc<"event_sources">): Promise<{ _id: string; config?: TokenConfig } | null> {
  const id = await connectionIdForSource(ctx, source);
  return id ? await ctx.db.get(id) : null;
}

const POLL_SCHEDULE_PAGE = 200;

/** How long one alerted issue's re-read covers later alerts on it. */
const REFRESH_COALESCE_MS = 30_000;

/** Cron: one poll action per active Sentry source, a page per transaction so every source is reached. */
export const schedulePolls = internalMutation({
  args: { cursor: v.optional(v.string()), offset: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("event_sources")
      .withIndex("by_provider_status", (q) => q.eq("provider", "sentry").eq("status", "active"))
      .paginate({ cursor: args.cursor ?? null, numItems: POLL_SCHEDULE_PAGE });
    const offset = args.offset ?? 0;
    for (const [i, s] of page.page.entries()) {
      // Spread across the interval so a workspace with many sources does not
      // hit Sentry's rate limit in one burst.
      await ctx.scheduler.runAfter(Math.min((offset + i) * 200, 60_000), internal.sources.sentry.pollSource, { source_id: s._id });
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.sources.sentry.schedulePolls, { cursor: page.continueCursor, offset: offset + page.page.length });
    return page.page.length;
  },
});

/** What a poll needs before it calls Sentry. Internal: the connection id is handed to tokenFor, never to a client. */
export const pollInputs = internalQuery({
  args: { source_id: v.id("event_sources"), without_open: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.source_id);
    if (!source || source.provider !== "sentry") return null;
    const connection = await sourceConnection(ctx, source);
    // Open mirrored groups seen inside the list's window: the ones the list
    // should still return, so one it does not is re-read by id. A one-issue
    // refresh has no list, so it skips the walk.
    const since = Date.now() - SENTRY_POLL.window_ms;
    const open: string[] = [];
    if (!args.without_open) for await (const g of ctx.db.query("event_groups").withIndex("by_source_last_seen", (q) => q.eq("source_id", source._id).gte("last_seen", since)).order("desc")) {
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

/**
 * A poll's outcome on the source row. A fatal refusal (a lost connection, a
 * target Sentry does not have) stops the source (lib/sourceHealth) until a
 * connection is stored again or a person resumes it.
 */
export const recordPoll = internalMutation({
  args: { source_id: v.id("event_sources"), error: v.optional(v.string()), fatal: v.optional(v.boolean()), connection_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.source_id);
    if (!source) return;
    const now = Date.now();
    const connectionId = args.connection_id ? ctx.db.normalizeId("app_installations", args.connection_id) : null;
    // The poll time is a counter (event_source_stats); the source row is
    // written only when something on it changes, so a quiet poll every two
    // minutes does not re-run every query that reads the source.
    await patchSourceStats(ctx, source, () => ({ last_poll_at: now }), now);
    if (args.fatal && args.error) {
      await markConnectionLost(ctx, source, args.error, now);
      return;
    }
    const patch = {
      ...(source.last_error !== args.error ? { last_error: args.error } : {}),
      // The connection the poll found is the one the source reads through
      // from now on, so a later personal connection cannot take its place.
      ...(connectionId && !source.connection_id ? { connection_id: connectionId } : {}),
    };
    if (Object.keys(patch).length) await ctx.db.patch(source._id, { ...patch, updated_at: now });
  },
});

const credential = (ctx: { runQuery: (...a: any[]) => Promise<any> }, connectionId: string | null) => tokenFor(ctx, connectionId, "sentry");

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
    // No connection, or one that cannot be read: nothing to poll with until
    // one is stored again. Checked first, so the cause it names is the connection.
    const cred = await credential(ctx, inputs.connection_id);
    if (!cred.ok) return fail(cred.error, true);
    const target = sentryTarget(inputs.connection_config, inputs.config);
    if (!target.ok) return fail(target.error, true);

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
    const inputs: any = await ctx.runQuery(internal.sources.sentry.pollInputs, { source_id: args.source_id, without_open: true });
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
    const hook = webhookHost();
    for (const source of sources) {
      const connection = await sourceConnection(ctx, source);
      const target = sentryTarget(connection?.config, source.config);
      if (!connection || !target.ok || target.target.org !== work.org) continue;
      // Only a connection on the Sentry that signed this delivery proved it reads the org.
      if (!onWebhookHost(target.target.host, hook)) continue;
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
        // One re-read per source and issue in a window: a burst of alerts on
        // one issue is one Sentry call, not one per delivery.
        const { granted } = await takeFromWindow(ctx.db, `sentry-refresh:${source._id}:${work.issue_id}`, 1, REFRESH_COALESCE_MS, 1);
        if (granted) await ctx.scheduler.runAfter(0, internal.sources.sentry.refreshIssue, { source_id: source._id, issue_id: work.issue_id, environment: work.environment });
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
  // user_id: a web gesture's person, carried by the action dispatch scheduled (setIssueStatusFor).
  args: { api_token: v.optional(v.string()), user_id: v.optional(v.id("users")), group: v.string(), conversation_id: scopeArgs.conversation_id },
  handler: async (ctx, args) => {
    const userId = args.user_id ?? (await requireUserOrToken(ctx, args.api_token));
    // The agent session making the call, for the audit row; only one the caller may read.
    const conversation = args.conversation_id ? await resolveSessionConversation(ctx, userId, args.conversation_id) : null;
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
      user_id: userId,
      conversation_id: conversation?._id,
      group_id: group._id,
      short_id: group.short_id,
      source_id: source._id,
      issue_id: group.external.id,
      connection_id: String(connection._id),
      target: target.target,
      // For writes: the grants in force and where a person makes one.
      grants: source.grants ?? [],
      grant_url: grantUrlFor(source),
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
 * A linked Sentry replay imported the first time it is read, as its source:
 * the caller's access to the replay was checked by vendorReplay.importLinked.
 */
export const importReplay = internalAction({
  args: { source_id: v.id("event_sources"), external_id: v.string() },
  handler: async (ctx, args): Promise<ImportOutcome> => {
    if (!SENTRY_REPLAY_ID.test(args.external_id)) throw new Error("That is not a Sentry replay id");
    const inputs: any = await ctx.runQuery(internal.sources.sentry.pollInputs, { source_id: args.source_id });
    if (!inputs) throw new Error("The replay's Sentry source was removed");
    const target = sentryTarget(inputs.connection_config, inputs.config);
    if (!target.ok) throw new Error(target.error);
    return importVendorRecording(ctx, { source_id: args.source_id, provider: "sentry", external_id: args.external_id }, async () => {
      const cred = await credential(ctx, inputs.connection_id);
      if (!cred.ok) throw new Error(cred.error);
      return readSentryReplay(fetch, cred.token, target.target, args.external_id);
    });
  },
});

/**
 * The issue behind a group, its latest event with the stack trimmed, and the
 * replay that event was recorded in. Read live from Sentry; nothing but the
 * replay link is stored.
 */
export const issueDetail = action({
  args: { api_token: v.optional(v.string()), group: v.string(), conversation_id: scopeArgs.conversation_id },
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
 * Resolve, reopen or ignore the issue in Sentry, then mirror what Sentry
 * answers. Only ever this explicit call, and only on a person's grant of the
 * action (issue.resolve covers reopening): no transition, trigger or poll
 * writes to Sentry. Every attempt is audited in app_calls, a refusal too.
 */
type IssueStatus = "resolved" | "ignored" | "unresolved";
const issueStatusValidator = v.union(v.literal("resolved"), v.literal("ignored"), v.literal("unresolved"));

export const setIssueStatus = action({
  args: {
    api_token: v.optional(v.string()),
    group: v.string(),
    status: issueStatusValidator,
    conversation_id: scopeArgs.conversation_id,
  },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string; status?: string; denied?: boolean }> => writeIssueStatus(ctx, args),
});

/** setIssueStatus for a web gesture (dispatch setOpsGroupStatus), which runs as a mutation and schedules this with its person. */
export const setIssueStatusFor = internalAction({
  args: { user_id: v.id("users"), group: v.string(), status: issueStatusValidator },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string; status?: string; denied?: boolean }> => writeIssueStatus(ctx, args),
});

async function writeIssueStatus(
  ctx: any,
  args: { api_token?: string; user_id?: Id<"users">; group: string; status: IssueStatus; conversation_id?: string },
): Promise<{ ok: boolean; error?: string; status?: string; denied?: boolean }> {
  const t: any = await ctx.runQuery(internal.sources.sentry.issueTarget, { api_token: args.api_token, user_id: args.user_id, group: args.group, conversation_id: args.conversation_id });
  if (!t.ok) return t;
  const name = sentryStatusAction(args.status);
  const started = Date.now();
  const call: OutsideCall = { source_id: t.source_id, user_id: t.user_id, conversation_id: t.conversation_id, kind: "do", name, args: { issue: t.issue_id, status: args.status } };
  const audit = (status: "ok" | "error" | "denied", error?: string, http_status?: number) =>
    auditOutsideCall(ctx, call, status, { ms: Date.now() - started, ...(error ? { error } : {}), ...(http_status ? { http_status } : {}) });
  const refusal = writeRefusal(VENDOR_ACTIONS.sentry, t.grants, name, { grantUrl: t.grant_url }, started);
  if (refusal) {
    await audit("denied", refusal);
    return { ok: false, denied: true, error: refusal };
  }
  const cred = await credential(ctx, t.connection_id);
  if (!cred.ok) {
    await audit("error", cred.error);
    return cred;
  }
  const put = await sentryCall(fetch, cred.token, issueUrl(t.target, t.issue_id), { method: "PUT", body: { status: args.status } });
  await audit(put.ok ? "ok" : "error", put.ok ? undefined : put.error, put.ok ? undefined : put.status);
  if (!put.ok) return { ok: false, error: put.error };
  // The PUT answers with the changed fields only; the issue read is whole.
  const issue = await sentryCall(fetch, cred.token, issueUrl(t.target, t.issue_id));
  const m = issue.ok ? issueToMirror(issue.json) : null;
  if (m) await writeMirrors(ctx, t.source_id, [m]);
  return { ok: true, status: issue.ok ? str(issue.json?.status, 40) : args.status };
}

/** Where a group's status is set for an outside writer: Sentry's own issue for a mirrored group, else the group row. */
export function sentryStatusFor(group: { external?: { provider: string } }, status: GroupStatus): IssueStatus | null {
  if (group.external?.provider !== "sentry" || status === "muted") return null;
  return status === "open" ? "unresolved" : status;
}

/**
 * `cast events resolve|ignore|reopen|mute` (/cli/events/set-status). A group
 * mirrored from Sentry is resolved, ignored or reopened in Sentry (on a
 * person's grant), since the next poll follows Sentry's status; a mute is
 * codecast's own and is set here. Sentry decides its own regressions, so a
 * release named with --in is not used for a mirrored group, and the answer
 * says so.
 */
export async function setEventGroupStatus(
  ctx: { runQuery: (...a: any[]) => Promise<any>; runMutation: (...a: any[]) => Promise<any>; runAction: (...a: any[]) => Promise<any> },
  body: { api_token?: string; group: string; status: GroupStatus; resolved_in?: string; conversation_id?: string; [k: string]: unknown },
): Promise<any> {
  const { group } = await ctx.runQuery(api.ingest.getGroup, { api_token: body.api_token, group: body.group });
  const status = sentryStatusFor(group, body.status);
  if (!status) return await ctx.runMutation(api.ingest.setGroupStatus, body);
  const out = await ctx.runAction(api.sources.sentry.setIssueStatus, {
    api_token: body.api_token,
    group: body.group,
    status,
    // The agent session that asked, so the app_calls row names it.
    ...(typeof body.conversation_id === "string" ? { conversation_id: body.conversation_id } : {}),
  });
  if (!out.ok) return { error: out.error ?? "Sentry refused the change" };
  return {
    ...(await ctx.runQuery(api.ingest.getGroup, { api_token: body.api_token, group: body.group })),
    sentry_status: out.status,
    ...(body.resolved_in?.trim() ? { note: `--in ${body.resolved_in.trim()} was not used: ${group.short_id} is mirrored from Sentry, which decides its regressions` } : {}),
  };
}
