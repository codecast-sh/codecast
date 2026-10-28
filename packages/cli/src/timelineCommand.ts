// `cast timeline`: a workspace's work as major events (convex workTimeline.ts),
// oldest first: tasks opened and closed, changes landed, and on request a
// digest of what is in progress. Built for an outside agent's feed that polls
// with the cursor it was handed; decisions have their own read
// (`cast decide ls --answered-since`).
import type { Command } from "commander";
import type { PublishDeps } from "./castApi.js";
import { JSON_OPTION, TEAM_OPTION, emit, fail, scopedRead } from "./externalDataCli.js";
import { parseAnsweredSince } from "./decideCommand.js";

export interface TimelineRow {
  id: string;
  at: number;
  kind: "task_opened" | "task_closed" | "change_landed";
  detail?: string;
  into?: string;
  by?: string;
  task: { short_id?: string; title: string; status: string; project?: string; source?: string };
  repository?: string;
}

export interface TimelineDigest {
  in_progress: { project: string; count: number; titles: string[] }[];
  problems_opened: number;
}

export interface TimelinePage {
  events: TimelineRow[];
  cursor: number;
  landed_cursor: number;
  digest?: TimelineDigest;
}

function when(raw: string, flag: string, now: number): number {
  const at = parseAnsweredSince(raw, now);
  if (at === null) fail(`${flag} takes a time: epoch ms, 30m, 6h, 2d, or an ISO date`);
  return at;
}

export function formatTimeline(page: TimelinePage): string {
  const lines = page.events.map((e) => {
    const t = new Date(e.at).toISOString().slice(0, 16).replace("T", " ");
    const what = e.kind === "change_landed" ? `landed ${e.detail ?? ""}`.trim() : e.kind === "task_opened" ? `opened${e.by ? ` by ${e.by}` : ""}` : `closed ${e.detail ?? ""}${e.into ? ` into ${e.into}` : ""}`.trim();
    return `${t}  ${e.task.short_id ?? "-"}  ${what}  ${e.task.title}${e.task.project ? `  (${e.task.project})` : ""}`;
  });
  if (page.digest) {
    lines.push("", `In progress (${page.digest.problems_opened} problems opened since the digest time):`);
    for (const g of page.digest.in_progress) lines.push(`  ${g.project}: ${g.count}${g.titles.length ? `  ${g.titles.join("; ")}` : ""}`);
  }
  lines.push("", `cursor ${page.cursor}  landed_cursor ${page.landed_cursor}`);
  return lines.join("\n");
}

export function registerTimelineCommand(program: Command, deps: PublishDeps): void {
  program
    .command("timeline")
    .description("A workspace's work as major events, oldest first: tasks opened and closed, changes landed")
    .requiredOption("--since <time>", "Keep events after this time (epoch ms, 30m, 6h, 2d, ISO)")
    .option("--after <cursor>", "Read tasks on from the cursor an earlier page returned (default: --since)")
    .option("--landed-after <cursor>", "Read landings on from the landed_cursor an earlier page returned (default: --since)")
    .option("--digest-since <time>", "Also the in-progress digest, counting problems opened after this time")
    .option("-n, --limit <n>", "Tasks and landings read per page, each (1-150, default 60)", (v: string) => parseInt(v, 10))
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (o: { since: string; after?: string; landedAfter?: string; digestSince?: string; limit?: number; team?: string; json?: boolean }) => {
      const now = Date.now();
      const floor = when(o.since, "--since", now);
      const after = o.after !== undefined ? when(o.after, "--after", now) : floor;
      const page: TimelinePage = await scopedRead(deps, "/cli/timeline", {
        floor,
        after,
        ...(o.landedAfter !== undefined ? { landed_after: when(o.landedAfter, "--landed-after", now) } : {}),
        ...(o.limit ? { limit: o.limit } : {}),
        ...(o.digestSince !== undefined ? { digest_since: when(o.digestSince, "--digest-since", now) } : {}),
      }, o.team);
      emit(o.json, page, () => formatTimeline(page));
    });
}
