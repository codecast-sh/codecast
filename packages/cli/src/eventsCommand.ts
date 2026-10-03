// `cast events` (docs/architecture/external-data.md X3, X10): what a running
// product reported. `ls` is the timeline of transitions (a new error, a
// regression, a red check), `groups` the grouped facts behind them with their
// counts, `show` one group with its recent samples.
//
//   cast events ls [--source s] [--since 2h] [-w]
//   cast events groups [--source s] [--status open] [--kind error]
//   cast events show eg-N | resolve eg-N [--in <release>] | ignore eg-N
//
// Routes: /cli/events/* in http.ts (ingest.ts). A group mirrored from Sentry
// shows Sentry's latest event and is resolved or ignored in Sentry itself,
// which runs only on a person's grant (issue.resolve, issue.ignore); a refusal
// names the browser page where they grant it, and the verb exits non-zero.
import type { Command } from "commander";
import { apiPost, type PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";
import { commandGroup } from "./commandGroups.js";
import { JSON_OPTION, TEAM_OPTION, ago, emit, fail, scopedRead, sparkline } from "./externalDataCli.js";
import { GROUP_KINDS, GROUP_STATUSES } from "@codecast/shared/contracts/ingest";
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

export const WATCH_INTERVAL_MS = 5_000;

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
  return `${fmt.id(g.short_id)}  ${g.kind}  ${state}  ×${g.count}  ${g.title}${metric}  ${fmt.muted(`last ${ago(g.last_seen, now)}`)}  ${sparkline(g.buckets.map((b) => b.count))}`.trimEnd();
}

export function formatGroupList(rows: GroupRow[], now: number = Date.now()): string {
  if (rows.length === 0) return "No groups.";
  return rows.map((g) => formatGroupLine(g, now)).join("\n");
}

export function formatGroupDetail(res: { group: GroupRow; samples: SampleRow[]; source: { name: string; provider: string } | null; issue?: any }, now: number = Date.now()): string {
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
  const event = res.issue?.event;
  if (event) {
    lines.push("", fmt.highlight("Latest event (Sentry)"));
    if (event.title || event.message) lines.push(event.message || event.title);
    if (event.url) lines.push(fmt.muted(`  ${event.method ? `${event.method} ` : ""}${event.url}`));
    for (const x of event.exceptions ?? []) {
      lines.push(`${x.type ?? "Error"}: ${x.value ?? ""}`);
      if (x.stack) lines.push(fmt.muted(x.stack));
    }
    if (res.issue.replay_id) lines.push(fmt.muted(`  recorded in replay ${res.issue.replay_id}: cast replay ls --source ${res.source?.name ?? "<source>"}`));
  } else if (res.issue?.error) {
    lines.push(fmt.muted(`  Sentry: ${res.issue.error}`));
  }
  for (const s of res.samples.slice(0, 5)) {
    lines.push("", `${fmt.muted(ago(s.at, now))}  ${s.message ?? ""}${s.release ? fmt.muted(`  (${s.release})`) : ""}`);
    if (s.url) lines.push(fmt.muted(`  ${s.url}`));
    if (s.stack) lines.push(fmt.muted(s.stack.split("\n").slice(0, 12).join("\n")));
  }
  if (res.samples.length > 5) lines.push(fmt.muted(`\n  ${res.samples.length - 5} more samples: --json`));
  return lines.join("\n");
}

/** The rows of a page not seen before, oldest first, and the cursor after them. */
export function freshEvents(rows: EventRow[], seen: Set<string>): EventRow[] {
  return rows.filter((r) => !seen.has(r._id)).sort((a, b) => a.created_at - b.created_at);
}

/**
 * `-w`: poll every few seconds and print each new transition once. The
 * cursor is the newest created_at seen; ids dedupe rows that share it.
 */
export async function watchEvents(
  fetchSince: (since: number) => Promise<EventRow[]>,
  print: (row: EventRow) => void,
  opts: { since: number; intervalMs?: number; rounds?: number; sleep?: (ms: number) => Promise<void> },
): Promise<void> {
  const seen = new Set<string>();
  let since = opts.since;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let round = 0; opts.rounds === undefined || round < opts.rounds; round++) {
    if (round > 0) await sleep(opts.intervalMs ?? WATCH_INTERVAL_MS);
    for (const row of freshEvents(await fetchSince(since), seen)) {
      seen.add(row._id);
      since = Math.max(since, row.created_at);
      print(row);
    }
  }
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
      await watchEvents((from) => page(from, o.limit ?? 100), (row) => console.log(o.json ? JSON.stringify(row) : formatEventLine(row)), { since: since ?? now - 60 * 60_000 });
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
    .option(...JSON_OPTION)
    .action(async (ref: string, o: { json?: boolean }) => {
      const res = await apiPost(deps, "/cli/events/group", { group: ref }, { read: true });
      if (res.group?.external?.provider === "sentry") res.issue = await apiPost(deps, "/cli/events/issue", { group: ref }, { read: true });
      emit(o.json, res, () => formatGroupDetail(res));
    });

  const setStatus = (verb: string, what: string) =>
    events
      .command(verb)
      .description(what)
      .argument("<group>", "eg-N")
      .option(...JSON_OPTION);

  setStatus("resolve", "Mark a group resolved; a later occurrence reopens it as a regression. A Sentry group is resolved in Sentry, only while a person's grant of issue.resolve covers it")
    .option("--in <release>", "The release that carries the fix; an occurrence from a newer release is a regression")
    .action(async (ref: string, o: { in?: string; json?: boolean }) => {
      const res = await apiPost(deps, "/cli/events/set-status", { group: ref, status: "resolved", ...(o.in?.trim() ? { resolved_in: o.in.trim() } : {}) });
      emit(o.json, res, () => formatGroupLine(res.group));
    });

  setStatus("ignore", "Stop announcing a group. A Sentry group is ignored in Sentry, only while a person's grant of issue.ignore covers it")
    .action(async (ref: string, o: { json?: boolean }) => {
      const res = await apiPost(deps, "/cli/events/set-status", { group: ref, status: "ignored" });
      emit(o.json, res, () => formatGroupLine(res.group));
    });
}
