// `cast priorities`: what each person is driving at (shared/contracts/priorities.ts),
// inferred by a pass over their own sessions, and the person's own controls:
// rank; a title; a milestone's tier, done state, title and drop; set aside, done,
// restore and merge; moving a session or saying it is not part of one; and
// corrections the pass reads. Their call always wins over the pass.

import type { Command } from "commander";
import { apiPost, type PublishDeps } from "./castApi.js";
import { commandGroup } from "./commandGroupLookup.js";
import { ago, sparkline } from "./externalDataCli.js";
import type { PriorityCorrection, PriorityDetail, PriorityHistory, PriorityList, PriorityRow } from "@codecast/shared/contracts/priorities";

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

/** Under this the pass is on time and `ls` says nothing. */
const BEHIND_SHOWN_MS = 6 * 3_600_000;

/** "Behind by 8h" once the pass lags more than six hours, else null. */
export function behindLine(ms: number | null | undefined): string | null {
  return ms != null && ms > BEHIND_SHOWN_MS ? `Behind by ${Math.floor(ms / 3_600_000)}h: the pass has not caught up with your newest work.` : null;
}

/** When a pass runs, said plainly: "now", "in 40m", "in 2h". */
export function whenLabel(at: number | null | undefined, now = Date.now()): string {
  if (at == null) return "after your next pin, answer or task close";
  const ms = at - now;
  if (ms <= 60_000) return "now";
  return ms < 3_600_000 ? `in ${Math.ceil(ms / 60_000)}m` : `in ${Math.round(ms / 3_600_000)}h`;
}

/** "pri-3/s2" as its priority and milestone key; a bare "pri-3" names no milestone. */
export function milestoneRef(raw: string): { short_id: string; step_key?: string } {
  const [id, key, ...rest] = raw.split("/");
  if (rest.length || key === "") fail(`"${raw}" is not a priority or milestone (pri-N or pri-N/sK, like pri-3/s2)`);
  return { short_id: priorityId(id), ...(key ? { step_key: key.trim().toLowerCase() } : {}) };
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
    p.rank != null && p.status === "active" ? `#${p.rank} ${p.rank_source === "person" ? "(you placed it)" : "(ranked by AI)"}` : null,
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
      // A ref names a session whose short id is shared by a longer prefix of its id (jx7137jn): that is the same session.
      for (const c of s.sessions) if (!refs.some((r) => r.startsWith(c.short_id))) refs.push(c.short_id);
      const yours = s.tier_set_by === "person" || s.title_set_by === "person" || s.done_set_by === "person";
      out.push(`  ${s.done ? "✓" : " "} ${s.key.padEnd(keyWidth)}  ${s.title}${yours ? "  (yours)" : ""}${refs.length ? `  ${refs.join(" · ")}` : ""}`);
    }
  }
  if (p.other_sessions.length) out.push("", `Other sessions  ${p.other_sessions.map((c) => c.short_id).join(" · ")}`);
  if (p.corrections?.length) {
    out.push("", "Corrections");
    for (const c of p.corrections) out.push(`  ${c.status === "pending" ? "pending" : "applied"}  ${c.step_key ? `${c.step_key}  ` : ""}${c.text}  ${c._id}`);
  }
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
      const list = res as PriorityList;
      const rows: PriorityRow[] = list.priorities ?? [];
      if (options.json) return console.log(JSON.stringify(rows, null, 2));
      // No pass has settled here yet: say when the first one runs.
      if (!rows.length && list.behind_by_ms == null) return console.log(`No priorities yet — the first pass runs ${whenLabel(list.next_pass_at)}.`);
      const behind = behindLine(list.behind_by_ms);
      if (behind) console.log(behind);
      if (!rows.length) return console.log(options.all ? "No priorities here." : "No active priorities. cast priorities ls --all shows the rest.");
      for (const line of formatPriorityLines(rows)) console.log(line);
      if (res.own_truncated) console.log("Your priorities past the most recently active ones are not listed.");
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
    .description("Place a priority at position n among your active ones; the pass never moves it after")
    .option("--json", "The updated priority as JSON")
    .action(async (id: string, n: string, options: { json?: boolean }) => {
      const rank = Number(n);
      if (!Number.isInteger(rank) || rank < 1) fail(`a rank is a whole number from 1, got "${n}"`);
      const row: PriorityRow = await apiPost(deps, "/cli/priorities/move", { short_id: priorityId(id), to: rank });
      if (options.json) return console.log(JSON.stringify(row, null, 2));
      console.log(`ok ${row.short_id} now #${row.rank}`);
    });

  pri
    .command("rename <id> <title...>")
    .description("Rename a priority; the pass keeps your title")
    .option("--json", "The updated priority as JSON")
    .action(async (id: string, words: string[], options: { json?: boolean }) => {
      const title = words.join(" ").trim();
      if (!title) fail("a priority needs a title");
      const row: PriorityRow = await apiPost(deps, "/cli/priorities/rename", { short_id: priorityId(id), title });
      if (options.json) return console.log(JSON.stringify(row, null, 2));
      console.log(`ok ${row.short_id} renamed`);
    });

  /** A milestone verb's target: "pri-3/s2". */
  const milestone = (ref: string) => {
    const m = milestoneRef(ref);
    if (!m.step_key) fail(`name a milestone as pri-N/sK, like pri-3/s2 (got "${ref}")`);
    return m as { short_id: string; step_key: string };
  };
  const ms = pri.command("milestone").description("Change one milestone of a priority (pri-N/sK); the pass keeps what you set");

  ms
    .command("tier <milestone>")
    .description("Move a milestone onto the critical path or into polish")
    .option("--critical", "On the critical path")
    .option("--polish", "Polish")
    .option("--json", "The updated priority as JSON")
    .action(async (ref: string, options: { critical?: boolean; polish?: boolean; json?: boolean }) => {
      if (!!options.critical === !!options.polish) fail("pass exactly one of --critical or --polish");
      const tier = options.critical ? "critical" : "polish";
      const m = milestone(ref);
      const row: PriorityRow = await apiPost(deps, "/cli/priorities/step", { ...m, tier });
      if (options.json) return console.log(JSON.stringify(row, null, 2));
      console.log(`ok ${row.short_id}/${m.step_key} -> ${tier === "critical" ? "critical path" : "polish"}`);
    });

  for (const [verb, change, said, description] of [
    ["done", { done: true }, "done", "Mark a milestone done, whatever its tasks say"],
    ["undone", { done: false }, "not done", "Mark a milestone not done, whatever its tasks say"],
    ["drop", { drop: true }, "dropped", "Drop a milestone: it is hidden, and the pass never proposes it again"],
  ] as const) {
    ms
      .command(`${verb} <milestone>`)
      .description(description)
      .option("--json", "The updated priority as JSON")
      .action(async (ref: string, options: { json?: boolean }) => {
        const m = milestone(ref);
        const row: PriorityRow = await apiPost(deps, "/cli/priorities/milestone", { ...m, ...change });
        if (options.json) return console.log(JSON.stringify(row, null, 2));
        console.log(`ok ${row.short_id}/${m.step_key} ${said}`);
      });
  }

  ms
    .command("rename <milestone> <title...>")
    .description("Rename a milestone; the pass keeps your title")
    .option("--json", "The updated priority as JSON")
    .action(async (ref: string, words: string[], options: { json?: boolean }) => {
      const m = milestone(ref);
      const title = words.join(" ").trim();
      if (!title) fail("a milestone needs a title");
      const row: PriorityRow = await apiPost(deps, "/cli/priorities/milestone", { ...m, title });
      if (options.json) return console.log(JSON.stringify(row, null, 2));
      console.log(`ok ${row.short_id}/${m.step_key} renamed`);
    });

  for (const [verb, path, said, description] of [
    ["set-aside", "/cli/priorities/set-aside", "set aside", "Set a priority aside; the pass leaves it there until you restore it"],
    ["done", "/cli/priorities/done", "done", "Mark a priority done; the pass keeps it done"],
    ["restore", "/cli/priorities/restore", "active", "Bring a set-aside or done priority back to active"],
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
    .command("merge <id>")
    .description("Merge a priority into another of yours: its milestones, sessions and corrections move there")
    .requiredOption("--into <id>", "The priority that stays")
    .option("--json", "The surviving priority as JSON")
    .action(async (id: string, options: { into: string; json?: boolean }) => {
      const row: PriorityRow = await apiPost(deps, "/cli/priorities/merge", { short_id: priorityId(id), into: priorityId(options.into) });
      if (options.json) return console.log(JSON.stringify(row, null, 2));
      console.log(`ok ${priorityId(id)} merged into ${row.short_id}`);
    });

  const session = pri.command("session").description("Place one of your sessions; the pass keeps where you put it");

  session
    .command("move <session> <to>")
    .description("Put a session on a priority or one of its milestones (pri-N or pri-N/sK)")
    .option("--json", "The priority as JSON")
    .action(async (sessionId: string, to: string, options: { json?: boolean }) => {
      const row: PriorityRow = await apiPost(deps, "/cli/priorities/session-move", { session: sessionId, ...milestoneRef(to) });
      if (options.json) return console.log(JSON.stringify(row, null, 2));
      console.log(`ok ${sessionId} -> ${to.toLowerCase()}`);
    });

  session
    .command("not-this <session>")
    .description("Take a session off its priority; the pass never puts it back there")
    .option("--json", "The priority it left as JSON")
    .action(async (sessionId: string, options: { json?: boolean }) => {
      const row: PriorityRow = await apiPost(deps, "/cli/priorities/session-not-this", { session: sessionId });
      if (options.json) return console.log(JSON.stringify(row, null, 2));
      console.log(`ok ${sessionId} is not part of ${row.short_id}`);
    });

  pri
    .command("correct <target> <text...>")
    .description("Tell the pass what it got wrong about a priority or a milestone (pri-N or pri-N/sK); every later pass reads it")
    .option("--json", "The correction as JSON")
    .action(async (target: string, words: string[], options: { json?: boolean }) => {
      const text = words.join(" ").trim();
      if (!text) fail("a correction needs words");
      const c: PriorityCorrection = await apiPost(deps, "/cli/priorities/correct", { ...milestoneRef(target), text });
      if (options.json) return console.log(JSON.stringify(c, null, 2));
      console.log(`ok correction ${c._id} on ${target.toLowerCase()}: the next pass reads it`);
    });

  pri
    .command("correction")
    .description("Your corrections (cast priorities show lists them)")
    .command("delete <correction>")
    .description("Delete a correction; passes stop reading it")
    .action(async (id: string) => {
      await apiPost(deps, "/cli/priorities/correction-delete", { correction_id: id });
      console.log(`ok correction ${id} deleted`);
    });

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
