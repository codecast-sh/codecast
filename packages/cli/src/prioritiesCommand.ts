// `cast priorities`: what each person is driving at (shared/contracts/priorities.ts),
// inferred by a pass over their own sessions, and the person's own controls:
// rank, a step's tier, set aside and restore. Their call always wins over the pass.

import type { Command } from "commander";
import { apiPost, type PublishDeps } from "./castApi.js";
import { commandGroup } from "./commandGroups.js";
import { ago, sparkline } from "./externalDataCli.js";
import type { PriorityDetail, PriorityHistory, PriorityRow } from "@codecast/shared/contracts/priorities";

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

/** "pri-3", "PRI-3" or "3". */
export function priorityId(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (/^\d+$/.test(id)) return `pri-${id}`;
  if (!/^pri-\d+$/.test(id)) fail(`"${raw}" is not a priority id (pri-N, like pri-3)`);
  return id;
}

const STATUS_WORD: Record<string, string> = { active: "active", done: "done", quiet: "quiet", set_aside: "set aside", merged: "merged" };
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const day = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** One line per priority: rank, id, title, critical path, status, last active. */
export function formatPriorityLines(rows: PriorityRow[], now = Date.now()): string[] {
  const titleWidth = Math.min(48, Math.max(0, ...rows.map((r) => r.title.length)));
  const idWidth = Math.max(0, ...rows.map((r) => r.short_id.length));
  return rows.map((r) => {
    const status = r.status === "done" && r.done_at ? `✓ done ${day(r.done_at)}` : STATUS_WORD[r.status] ?? r.status;
    return [
      (r.rank != null && r.status === "active" ? `#${r.rank}` : "-").padStart(3),
      r.short_id.padEnd(idWidth),
      clip(r.title, titleWidth).padEnd(titleWidth),
      `critical ${r.counts.critical_done}/${r.counts.critical_total}`.padEnd(13),
      status.padEnd(15),
      ago(r.last_active_at, now),
      r.mine ? "" : ` · ${r.owner || "teammate"}`,
    ].join("  ").trimEnd();
  });
}

/** One priority: its line of facts, its summary, and its steps under Critical path and Polish. */
export function formatPriorityDetail(p: PriorityDetail, now = Date.now()): string[] {
  const facts = [
    p.status === "done" && p.done_at ? `✓ done ${day(p.done_at)}` : STATUS_WORD[p.status] ?? p.status,
    p.rank != null && p.status === "active" ? `#${p.rank}` : null,
    `critical ${p.counts.critical_done}/${p.counts.critical_total}`,
    p.serves ? `serves ${p.serves}` : null,
    p.session_count ? `${p.session_count}${p.session_count_more ? "+" : ""} session${p.session_count === 1 && !p.session_count_more ? "" : "s"}` : null,
    `last active ${ago(p.last_active_at, now)}`,
    p.mine ? null : p.owner,
  ].filter(Boolean);
  const out = [`${p.short_id}  ${p.title}`, facts.join(" · ")];
  if (p.summary) out.push(p.summary);
  const keyWidth = Math.max(0, ...p.steps.map((s) => s.key.length));
  for (const [tier, heading] of [["critical", "Critical path"], ["polish", "Polish"]] as const) {
    const steps = p.steps.filter((s) => s.tier === tier);
    if (!steps.length) continue;
    out.push("", heading);
    for (const s of steps) {
      const refs = [...s.refs.map((r) => r.id)];
      for (const c of s.sessions) if (!refs.includes(c.short_id)) refs.push(c.short_id);
      out.push(`  ${s.done ? "✓" : " "} ${s.key.padEnd(keyWidth)}  ${s.title}${s.tier_set_by === "person" ? "  (yours)" : ""}${refs.length ? `  ${refs.join(" · ")}` : ""}`);
    }
  }
  if (p.other_sessions.length) out.push("", `Other sessions  ${p.other_sessions.map((c) => c.short_id).join(" · ")}`);
  return out;
}

/**
 * One line per lane: id, title, its owner (a teammate's lane), a sparkline and
 * the total typed; a lane whose read was cut marks its total with "+".
 */
export function formatHistory(res: PriorityHistory): string[] {
  if (!res.lanes.length) return [`Nothing typed in the last ${res.days.length} days.`];
  const keyWidth = Math.max(0, ...res.lanes.map((l) => (l.key === "unassigned" ? 0 : l.key.length)));
  const titleWidth = Math.min(40, Math.max(0, ...res.lanes.map((l) => l.title.length)));
  const ownerWidth = Math.max(0, ...res.lanes.map((l) => l.owner?.length ?? 0));
  const ownerCol = (owner: string | undefined) => (ownerWidth ? `  ${(owner ?? "").padEnd(ownerWidth)}` : "");
  const head = `${"".padEnd(keyWidth)}  ${"".padEnd(titleWidth)}${ownerCol(undefined)}  ${res.days[0]?.slice(5) ?? ""} → ${res.days.at(-1)?.slice(5) ?? ""}`;
  return [
    head,
    ...res.lanes.map((l) => {
      return `${(l.key === "unassigned" ? "" : l.key).padEnd(keyWidth)}  ${clip(l.title, titleWidth).padEnd(titleWidth)}${ownerCol(l.owner)}  ${sparkline(l.counts).padEnd(res.days.length)}  ${l.total}${l.truncated ? "+" : ""} typed`;
    }),
  ];
}

/** The workspace a verb reads, resolved the way every work command does (see objCommand.ts). */
async function scope(deps: PublishDeps, team: string | undefined): Promise<{ team_id?: string; personal?: boolean }> {
  const { loadWorkspaceRoster, resolveWorkspaceForRead } = await import("./resolveWorkspace.js");
  const roster = await loadWorkspaceRoster(async () => await apiPost(deps, "/cli/teams", {}, { read: true }));
  try {
    const ws = resolveWorkspaceForRead(roster, team);
    return ws.kind === "team" ? { team_id: ws.teamId } : { personal: true };
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

const TEAM_HELP = "Which workspace (default: your active team, as the app shows)";

export function registerPrioritiesCommand(program: Command, deps: PublishDeps): void {
  const pri = program.command("priorities").description(commandGroup("priorities").description);

  pri
    .command("ls", { isDefault: true })
    .description("Priorities in rank order, one line each; active only unless --all")
    .option("--all", "Include done, quiet and set-aside ones")
    .option("--team <name|id|personal>", TEAM_HELP)
    .option("--json", "As JSON")
    .action(async (options: { all?: boolean; team?: string; json?: boolean }) => {
      const res = await apiPost(deps, "/cli/priorities/list", { ...(options.all ? { all: true } : { status: "active" }), ...(await scope(deps, options.team)) }, { read: true });
      const rows: PriorityRow[] = res.priorities ?? [];
      if (options.json) return console.log(JSON.stringify(rows, null, 2));
      if (!rows.length) return console.log(options.all ? "No priorities yet." : "No active priorities. cast priorities ls --all shows the rest.");
      for (const line of formatPriorityLines(rows)) console.log(line);
      if (res.teammates_truncated) console.log("Teammates' priorities past the most recently active ones are not listed.");
    });

  pri
    .command("show <id>")
    .description("One priority: its steps on the critical path and polish, with their tasks, sessions and PRs")
    .option("--json", "As JSON")
    .action(async (id: string, options: { json?: boolean }) => {
      const res = await apiPost(deps, "/cli/priorities/show", { short_id: priorityId(id) }, { read: true });
      if (options.json) return console.log(JSON.stringify(res, null, 2));
      for (const line of formatPriorityDetail(res)) console.log(line);
    });

  pri
    .command("rank <id> <n>")
    .description("Pin a priority at position n among your active ones; the pass keeps it there")
    .option("--json", "The updated priority as JSON")
    .action(async (id: string, n: string, options: { json?: boolean }) => {
      const rank = Number(n);
      if (!Number.isInteger(rank) || rank < 1) fail(`a rank is a whole number from 1, got "${n}"`);
      const row: PriorityRow = await apiPost(deps, "/cli/priorities/rank", { short_id: priorityId(id), rank });
      if (options.json) return console.log(JSON.stringify(row, null, 2));
      console.log(`ok ${row.short_id} now #${row.rank}`);
    });

  pri
    .command("step <id> <key>")
    .description("Move a step onto the critical path or into polish; the pass keeps your choice")
    .option("--critical", "On the critical path")
    .option("--polish", "Polish")
    .option("--json", "The updated priority as JSON")
    .action(async (id: string, key: string, options: { critical?: boolean; polish?: boolean; json?: boolean }) => {
      if (!!options.critical === !!options.polish) fail("pass exactly one of --critical or --polish");
      const tier = options.critical ? "critical" : "polish";
      const row: PriorityRow = await apiPost(deps, "/cli/priorities/step", { short_id: priorityId(id), step_key: key, tier });
      if (options.json) return console.log(JSON.stringify(row, null, 2));
      console.log(`ok ${row.short_id} ${key.toLowerCase()} -> ${tier === "critical" ? "critical path" : "polish"}`);
    });

  for (const [verb, path, said, description] of [
    ["set-aside", "/cli/priorities/set-aside", "set aside", "Set a priority aside; the pass leaves it there until you restore it"],
    ["restore", "/cli/priorities/restore", "active", "Bring a set-aside priority back to active"],
  ] as const) {
    pri
      .command(`${verb} <id>`)
      .description(description)
      .option("--json", "The updated priority as JSON")
      .action(async (id: string, options: { json?: boolean }) => {
        const row: PriorityRow = await apiPost(deps, path, { short_id: priorityId(id) });
        if (options.json) return console.log(JSON.stringify(row, null, 2));
        console.log(`ok ${row.short_id} ${said}`);
      });
  }

  pri
    .command("history")
    .description("Typing per day on each priority you can see, its owner's, and on your sessions no priority holds")
    .option("--days <n>", "How many days (up to 30)", "15")
    .option("--team <name|id|personal>", TEAM_HELP)
    .option("--json", "As JSON")
    .action(async (options: { days: string; team?: string; json?: boolean }) => {
      const days = Number(options.days);
      if (!Number.isInteger(days) || days < 1) fail(`--days takes a whole number from 1, got "${options.days}"`);
      const res = await apiPost(deps, "/cli/priorities/history", { days, tz_offset_minutes: new Date().getTimezoneOffset(), ...(await scope(deps, options.team)) }, { read: true });
      if (options.json) return console.log(JSON.stringify(res, null, 2));
      for (const line of formatHistory(res)) console.log(line);
    });

  pri
    .command("run")
    .description("Run one pass now over your new sessions; results land in about a minute")
    .option("--team <name|id|personal>", TEAM_HELP)
    .option("--json", "As JSON")
    .action(async (options: { team?: string; json?: boolean }) => {
      const res = await apiPost(deps, "/cli/priorities/run", await scope(deps, options.team));
      if (options.json) return console.log(JSON.stringify(res, null, 2));
      console.log(res.note);
      for (const s of res.skipped ?? []) console.log(`not run in ${s.workspace}: ${s.reason}`);
    });
}
