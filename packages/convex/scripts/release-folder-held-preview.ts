// A client-side preview of `migrations:releaseFolderHeldSessions` (org-staffing.md
// S35) over PROD, from the CLI's own reads, for a tree that is not deployed yet:
// which sessions each lead holds only through the old folder rule, and which it
// keeps. The migration's own dry run is authoritative once deployed; this reads
// the same facts the way a person could (`cast org ls`, `cast sessions`,
// `cast task show`, `cast org log`) and applies the same rule:
//   keep  bound to work in the role's area (contracts/orgLead ownsWork)
//   keep  a hand the role's line started (its first line is the hand briefing)
//   keep  filed by a person or role (a session batch in the org log)
//   release  taken over by the folder rule (a takeover lists it), or no record
//
//   bun packages/convex/scripts/release-folder-held-preview.ts --team Union [--role calling] [--json]

import { execFileSync } from "node:child_process";
import { apiConfig } from "../../evals/src/adapters/convo";
import { ownsWork } from "@codecast/shared/contracts/orgLead";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const team = arg("team") ?? "Union";
const onlyRole = arg("role")?.replace(/^@/, "").toLowerCase();
const json = process.argv.includes("--json");

const { siteUrl, apiToken } = apiConfig();
const post = async (path: string, body: any) => (await fetch(`${siteUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_token: apiToken, ...body }) })).json() as Promise<any>;
const cast = (...args: string[]) => JSON.parse(execFileSync("cast", [...args, "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));

const tree = cast("org", "ls", "--team", team);
const roles: any[] = (tree.roles ?? []).filter((r: any) => r.status !== "retired");
const log = cast("org", "log", "--team", team, "--since", "365d");
// Sessions a takeover moved (the lead row of each batch; a batch that hired two
// roles lists only the first role's takeover here), and sessions a person or
// role filed (a batch of kind session).
const takenOver = new Map<string, string>();
const filed = new Set<string>();
for (const e of log.entries ?? []) {
  const kinds = Object.keys(e.kinds ?? {});
  const t = e.lead?.effects?.takeover;
  for (const s of t?.sessions ?? []) takenOver.set(s.short_id, `${e.actor?.proposal?.short_id ?? e.door} ${kinds.join("+")}`);
  if (kinds.length === 1 && kinds[0] === "session" && e.lead?.subject?.type === "session") filed.add(e.lead.subject.short_id ?? e.lead.subject.id.slice(0, 7));
}

const taskCache = new Map<string, any>();
const planCache = new Map<string, any>();
const workOf = async (s: any) => {
  if (s.active_task?.short_id) {
    if (!taskCache.has(s.active_task.short_id)) taskCache.set(s.active_task.short_id, await post("/cli/work/get", { short_id: s.active_task.short_id }));
    const t = taskCache.get(s.active_task.short_id) ?? {};
    if (t.project_id || !t.plan_id) return { project_id: t.project_id, plan_id: t.plan_id };
    if (!planCache.has(String(t.plan_id))) planCache.set(String(t.plan_id), await post("/cli/plans/get", { id: t.plan_id }));
    return { plan_id: t.plan_id, project_id: planCache.get(String(t.plan_id))?.project_id };
  }
  if (s.active_plan?.short_id) {
    if (!planCache.has(s.active_plan.short_id)) planCache.set(s.active_plan.short_id, await post("/cli/plans/get", { short_id: s.active_plan.short_id }));
    const p = planCache.get(s.active_plan.short_id) ?? {};
    return { plan_id: p._id, project_id: p.project_id };
  }
  return {};
};
const isHand = async (shortId: string) => {
  const r = await post("/cli/read", { conversation_id: shortId, start_line: 1, end_line: 1, full_content: true });
  const first = (r.messages ?? [])[0]?.content ?? "";
  return /^## You are a hand of /m.test(first);
};

const rows: any[] = [];
for (const role of roles) {
  if (onlyRole && role.handle !== onlyRole) continue;
  // The tree caps each role's list; the sessions-under route pages the whole set.
  const under: any[] = [];
  for (let cursor = 0; ; cursor += 200) {
    const page = await post("/cli/org/sessions-under", { parent: { kind: "role", role_id: role._id }, team_id: tree.workspace?.team_id ?? role.team_id, cursor: String(cursor), limit: 200 });
    under.push(...(page.sessions ?? []).filter((s: any) => !s.is_anchor));
    if (!page.next_cursor) break;
  }
  if (!under.length) continue;
  const details = new Map<string, any>();
  for (let i = 0; i < under.length; i += 25) {
    const chunk = under.slice(i, i + 25).map((s: any) => s.short_id);
    for (const s of cast("sessions", ...chunk).sessions ?? []) details.set(s.id?.slice(0, 7) ?? s.short_id, s);
  }
  for (const s of under) {
    const d = details.get(s.short_id) ?? {};
    const state = d.is_killed ? "killed" : d.work_state ?? s.state ?? "?";
    const work = await workOf(d);
    const row: any = { role: role.handle, session: s.short_id, title: (s.title ?? "").trim().slice(0, 60), state, folder: s.project_path ?? "" };
    if ((work.project_id || work.plan_id) && ownsWork(role, work, roles)) { rows.push({ ...row, verdict: "keep", reason: `bound to ${d.active_task?.short_id ?? d.active_plan?.short_id} in its area` }); continue; }
    if (filed.has(s.short_id)) { rows.push({ ...row, verdict: "keep", reason: "filed by a person or role" }); continue; }
    if (await isHand(s.short_id)) { rows.push({ ...row, verdict: "keep", reason: "a hand its line started" }); continue; }
    const taken = takenOver.get(s.short_id);
    rows.push({ ...row, verdict: "release", reason: taken ? `taken over by the folder rule (${taken})` : "no record", return_to: s.owner_user_id ?? "its starter" });
  }
}

const counts = { release: rows.filter((r) => r.verdict === "release").length, release_live: rows.filter((r) => r.verdict === "release" && !["done", "killed"].includes(r.state)).length, keep: rows.filter((r) => r.verdict === "keep").length };
if (json) { console.log(JSON.stringify({ team, counts, rows }, null, 2)); process.exit(0); }
console.log(`${team}: ${counts.release} to release (${counts.release_live} not done), ${counts.keep} kept\n`);
for (const role of [...new Set(rows.map((r) => r.role))]) {
  const mine = rows.filter((r) => r.role === role);
  console.log(`@${role}: release ${mine.filter((r) => r.verdict === "release").length}, keep ${mine.filter((r) => r.verdict === "keep").length}`);
  for (const r of mine) console.log(`  ${r.verdict === "release" ? "←" : "·"} ${r.session} ${r.state.padEnd(8)} ${r.title.padEnd(60)} ${r.reason}${r.folder ? `  [${r.folder}]` : ""}`);
  console.log();
}
