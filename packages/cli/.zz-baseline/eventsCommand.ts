// `cast events` (docs/architecture/external-data.md X3, X10): what a running
// product reported. `ls` is the timeline of transitions (a new error, a
// regression, a red check), `groups` the grouped facts behind them with their
// counts, `show` one group with its recent samples.
//
//   cast events ls [--source s] [--since 2h] [-w]
//   cast events groups [--source s] [--status open] [--kind error]
//   cast events show eg-N | resolve eg-N [--in <release>] | ignore eg-N
//
// An eg-N is global, so show, resolve and ignore find it wherever the caller
// may read it. --team on those verbs only narrows that: a group from another
// workspace is refused with one line before anything is written.
//
// Routes: /cli/events/* in http.ts (ingest.ts). A group mirrored from Sentry
// shows Sentry's latest event and is resolved or ignored in Sentry itself,
// which runs only on a person's grant (issue.resolve, issue.ignore); a refusal
// names the browser page where they grant it, and the verb exits non-zero.
import type { Command } from "commander";
import { apiPost, type PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";
import { commandGroup } from "./commandGroups.js";
import { JSON_OPTION, TEAM_OPTION, ago, emit, fail, scopedRead, scopedWrite, sparkline } from "./externalDataCli.js";
import { scopeFor } from "./signalCommand.js";
import { GROUP_KINDS, GROUP_STATUSES, bucketSeries } from "@codecast/shared/contracts/ingest";
import { fenceProductText } from "@codecast/shared/contracts";
import { parseDuration } from "@codecast/shared/time";

export interface EventRow {
  _id: string;
  kind: string;
  title: string;
  url?: string;
  created_at: number;
  data?: { transition?: string; group_short_id?: string; source_name?: string; count?: number; level?: string; release?: string; environment?: string };
}

export interface GroupRow {
  _id: string;
  short_id: string;
  kind: string;
  status: string;
  title: string;
  culprit?: string;
  level?: string;
  count: number;
  users?: number;
  first_seen: number;
  last_seen: number;
  buckets: { hour: number; count: number }[];
  last_release?: string;
  first_release?: string;
  resolved_in?: string;
  external?: { provider: string; id: string; url?: string };
  /** The access key (`team:<id>` or `user:<id>`), as the server stores it. */
  workspace?: string;
  meta?: { ok?: boolean; value?: number; threshold?: number; direction?: string };
}

export interface SampleRow {
  at: number;
  message?: string;
  stack?: string;
  level?: string;
  url?: string;
  release?: string;
}

/** --team on a verb that takes an eg-N: the group is global, so the flag only narrows the lookup. */
const GROUP_TEAM_OPTION = ["--team <name|id|personal>", "Only a group in this workspace; one elsewhere is refused (default: wherever eg-N is)"] as const;

export const WATCH_INTERVAL_MS = 5_000;
/** A watch reads the server's whole page (ingest.ts LIST_CAP), so a burst inside the lookback window is not cut. */
export const WATCH_PAGE_LIMIT = 500;

export function formatEventLine(e: EventRow, now: number = Date.now()): string {
  const d = e.data ?? {};
  const extra = [d.count !== undefined ? `×${d.count}` : "", d.release ? `release ${d.release}` : "", d.environment ?? ""].filter(Boolean).join(", ");
  return [
    fmt.muted(ago(e.created_at, now).padEnd(8)),
    fmt.warning(e.kind),
    d.source_name ?? "",
    d.group_short_id ? fmt.id(d.group_short_id) : "",
    e.title,
    extra ? fmt.muted(`(${extra})`) : "",
  ].filter(Boolean).join("  ");
}

export function formatEventList(rows: EventRow[], now: number = Date.now()): string {
  if (rows.length === 0) return "No events. Sources: cast sources ls";
  return rows.map((e) => formatEventLine(e, now)).join("\n");
}

export function formatGroupLine(g: GroupRow, now: number = Date.now()): string {
  const state = g.status === "open" ? fmt.warning(g.status) : fmt.muted(g.status);
  const metric = g.kind === "metric" && g.meta?.value !== undefined ? ` = ${g.meta.value}` : "";
  return `${fmt.id(g.short_id)}  ${g.kind}  ${state}  ×${g.count}  ${g.title}${metric}  ${fmt.muted(`last ${ago(g.last_seen, now)}`)}  ${sparkline(bucketSeries(g.buckets, now))}`.trimEnd();
}

export function formatGroupList(rows: GroupRow[], now: number = Date.now()): string {
  if (rows.length === 0) return "No groups.";
  return rows.map((g) => formatGroupLine(g, now)).join("\n");
}

export function formatGroupDetail(
  res: { group: GroupRow; samples: SampleRow[]; source: { name: string; provider: string } | null; issue?: any; commit?: { sha: string; message: string; session: string | null } | null },
  now: number = Date.now(),
): string {
  const g = res.group;
  const lines = [formatGroupLine(g, now)];
  const facts = [
    res.source ? `${res.source.name} (${res.source.provider})` : "",
    g.culprit ?? "",
    g.level ?? "",
    `first ${ago(g.first_seen, now)}`,
    g.users ? `${g.users} users` : "",
    g.first_release ? `first in ${g.first_release}` : "",
    g.last_release ? `last in ${g.last_release}` : "",
    g.resolved_in ? `resolved in ${g.resolved_in}` : "",
  ].filter(Boolean);
  lines.push(fmt.muted(`  ${facts.join(" · ")}`));
  if (g.external?.url) lines.push(fmt.muted(`  ${g.external.url}`));
  // The commit the newest release was built from (its deploy's sha), and the session that wrote it.
  if (res.commit) lines.push(fmt.muted(`  built from ${res.commit.sha.slice(0, 10)} ${res.commit.message}${res.commit.session ? `, written in session ${res.commit.session}` : ""}`));
  // Everything a product sent (messages, stacks, request URLs) reads inside
  // one fence under the untrusted-data line; our own facts stay outside it.
  const product: string[] = [];
  const event = res.issue?.event;
  if (event) {
    product.push("Latest event (Sentry)");
    if (event.title || event.message) product.push(event.message || event.title);
    if (event.url) product.push(`  ${event.method ? `${event.method} ` : ""}${event.url}`);
    for (const x of event.exceptions ?? []) {
      product.push(`${x.type ?? "Error"}: ${x.value ?? ""}`);
      if (x.stack) product.push(x.stack);
    }
  }
  for (const s of res.samples.slice(0, 5)) {
    product.push("", `${ago(s.at, now)}  ${s.message ?? ""}${s.release ? `  (${s.release})` : ""}`);
    if (s.url) product.push(`  ${s.url}`);
    if (s.stack) product.push(s.stack.split("\n").slice(0, 12).join("\n"));
  }
  if (product.length) lines.push("", fenceProductText(product.join("\n").replace(/^\n/, ""), `${res.source?.provider ?? "product"} ${g.short_id}`));
  if (event && res.issue.replay_id) lines.push(fmt.muted(`  recorded in replay ${res.issue.replay_id}: cast replay ls --source ${res.source?.name ?? "<source>"}`));
  else if (!event && res.issue?.error) lines.push(fmt.muted(`  Sentry: ${res.issue.error}`));
  if (res.samples.length > 5) lines.push(fmt.muted(`\n  ${res.samples.length - 5} more samples: --json`));
  return lines.join("\n");
}

/** The rows of a page not seen before, oldest first. */
export function freshEvents(rows: EventRow[], seen: Map<string, number> | Set<string>): EventRow[] {
  return rows.filter((r) => !seen.has(r._id)).sort((a, b) => a.created_at - b.created_at);
}

/**
 * How far behind the newest row a watch keeps re-reading. A row is stamped
 * with when the thing happened (a regression at the group's last_seen, an SDK
 * item at the client's clock, a deploy at its own time), not when it was
 * written, so one written after the cursor moved can carry an earlier
 * created_at. Re-reading this window and deduping by id prints it anyway.
 */
export const WATCH_LOOKBACK_MS = 15 * 60_000;

/**
 * `-w`: poll every few seconds and print each new transition once. Each poll
 * reads from the newest created_at seen minus WATCH_LOOKBACK_MS; ids dedupe
 * the overlap, and ids older than the window are forgotten.
 */
export async function watchEvents(
  fetchSince: (since: number) => Promise<EventRow[]>,
  print: (row: EventRow) => void,
  opts: { since: number; intervalMs?: number; rounds?: number; sleep?: (ms: number) => Promise<void>; lookbackMs?: number },
): Promise<void> {
  const seen = new Map<string, number>();
  const lookback = opts.lookbackMs ?? WATCH_LOOKBACK_MS;
  let newest = opts.since;
  let floor = opts.since;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let round = 0; opts.rounds === undefined || round < opts.rounds; round++) {
    if (round > 0) await sleep(opts.intervalMs ?? WATCH_INTERVAL_MS);
    for (const row of freshEvents(await fetchSince(floor), seen)) {
      seen.set(row._id, row.created_at);
      newest = Math.max(newest, row.created_at);
      print(row);
    }
    floor = Math.max(opts.since, newest - lookback);
    for (const [id, at] of seen) if (at < floor) seen.delete(id);
  }
}

/**
 * Why a group is outside the workspace `--team` named, or null. `scope` is
 * what scopeFor resolved the flag to; the personal workspace a caller can read
 * is only their own, so any `user:` key is it.
 */
export function groupScopeProblem(group: Pick<GroupRow, "short_id" | "workspace">, scope: { workspace?: string; team_id?: string; [k: string]: unknown }, team: string): string | null {
  if (!scope.workspace || !group.workspace) return null;
  const inScope = scope.workspace === "team" ? group.workspace === `team:${scope.team_id}` : group.workspace.startsWith("user:");
  if (inScope) return null;
  const named = scope.workspace === "team" ? `the ${team} workspace` : "your personal workspace";
  return `${group.short_id} is not in ${named}. eg-N names one group everywhere; drop --team to reach it where it lives.`;
}

/** One group read, held to the workspace `--team` named when it names one. */
async function readGroup(deps: PublishDeps, ref: string, team: string | undefined): Promise<any> {
  if (!team) return await apiPost(deps, "/cli/events/group", { group: ref }, { read: true });
  const scope = await scopeFor(deps, team, false);
  const res = await apiPost(deps, "/cli/events/group", { group: ref, ...scope }, { read: true });
  const problem = res?.group ? groupScopeProblem(res.group, scope, team) : null;
  if (problem) fail(problem);
  return res;
}

function sinceFrom(raw: string | undefined, now: number): number | undefined {
  if (!raw) return undefined;
  try {
    return now - parseDuration(raw);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

export function registerEventsCommand(program: Command, deps: PublishDeps): void {
  const events = program.command("events").description(commandGroup("events").description);

  events
    .command("ls")
    .alias("list")
    .description("The timeline of transitions across sources, newest first")
    .option("--source <name>", "Only this source")
    .option("--since <duration>", "Only the last 30m, 24h, 7d...")
    .option("-n, --limit <n>", "How many", (v: string) => parseInt(v, 10))
    .option("-w, --watch", "Keep polling every 5 s and print each new transition")
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (o: { source?: string; since?: string; limit?: number; watch?: boolean; team?: string; json?: boolean }) => {
      const now = Date.now();
      const since = sinceFrom(o.since, now);
      const page = async (from: number | undefined, limit?: number): Promise<EventRow[]> =>
        await scopedRead(deps, "/cli/events/list", { source: o.source, since: from, limit }, o.team);
      if (!o.watch) {
        const rows = await page(since, o.limit);
        emit(o.json, rows, () => formatEventList(rows));
        return;
      }
      // Watching prints the backlog oldest first, then one line (or one JSON
      // object) per new row as it lands.
      await watchEvents((from) => page(from, o.limit ?? WATCH_PAGE_LIMIT), (row) => console.log(o.json ? JSON.stringify(row) : formatEventLine(row)), { since: since ?? now - 60 * 60_000 });
    });

  events
    .command("groups")
    .description("Grouped facts (errors, jobs, checks, metrics) with counts and the last 72 hours")
    .option("--source <name>", "Only this source")
    .option("--status <status>", GROUP_STATUSES.join(" | "))
    .option("--kind <kind>", GROUP_KINDS.join(" | "))
    .option("-n, --limit <n>", "How many", (v: string) => parseInt(v, 10))
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (o: { source?: string; status?: string; kind?: string; limit?: number; team?: string; json?: boolean }) => {
      if (o.status && !(GROUP_STATUSES as readonly string[]).includes(o.status)) fail(`Unknown status "${o.status}". Statuses: ${GROUP_STATUSES.join(", ")}`);
      if (o.kind && !(GROUP_KINDS as readonly string[]).includes(o.kind)) fail(`Unknown kind "${o.kind}". Kinds: ${GROUP_KINDS.join(", ")}`);
      const rows: GroupRow[] = await scopedRead(deps, "/cli/events/groups", { source: o.source, status: o.status, kind: o.kind, limit: o.limit }, o.team);
      emit(o.json, rows, () => formatGroupList(rows));
    });

  events
    .command("show")
    .description("One group: its facts, recent samples, and for a Sentry group the latest event read live")
    .argument("<group>", "eg-N")
    .option(...GROUP_TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (ref: string, o: { team?: string; json?: boolean }) => {
      const res = await readGroup(deps, ref, o.team);
      if (res.group?.external?.provider === "sentry") res.issue = await apiPost(deps, "/cli/events/issue", { group: ref }, { read: true });
      emit(o.json, res, () => formatGroupDetail(res));
    });

  const setStatus = (verb: string, what: string) =>
    events
      .command(verb)
      .description(what)
      .argument("<group>", "eg-N")
      .option(...GROUP_TEAM_OPTION)
      .option(...JSON_OPTION);

  // Checked before the write, so a mismatched --team changes nothing.
  const writeGroup = async (ref: string, team: string | undefined, body: Record<string, unknown>) => {
    if (team) await readGroup(deps, ref, team);
    return await scopedWrite(deps, "/cli/events/set-status", { group: ref, ...body }, team);
  };

  setStatus("resolve", "Mark a group resolved; a later occurrence reopens it as a regression. A Sentry group is resolved in Sentry, only while a person's grant of issue.resolve covers it")
    .option("--in <release>", "The release that carries the fix; an occurrence from a newer release is a regression")
    .action(async (ref: string, o: { in?: string; team?: string; json?: boolean }) => {
      const res = await writeGroup(ref, o.team, { status: "resolved", ...(o.in?.trim() ? { resolved_in: o.in.trim() } : {}) });
      emit(o.json, res, () => [formatGroupLine(res.group), ...(res.note ? [fmt.muted(`  ${res.note}`)] : [])].join("\n"));
    });

  setStatus("ignore", "Stop announcing a group. A Sentry group is ignored in Sentry, only while a person's grant of issue.ignore covers it")
    .action(async (ref: string, o: { team?: string; json?: boolean }) => {
      const res = await writeGroup(ref, o.team, { status: "ignored" });
      emit(o.json, res, () => formatGroupLine(res.group));
    });
}
