#!/usr/bin/env bun
// The product-fit scorecard (pl-842): what happens to a new person AFTER their
// first session syncs. Acquisition is the growth pack's number (cli_authed);
// this one answers whether the people acquired look at the product and stay.
//
//   bun scripts/product-fit-scorecard.ts            # table
//   bun scripts/product-fit-scorecard.ts --json     # the same, machine readable
//
// Reads PostHog project 354151 with the personal key in ~/.config/posthog/key
// (query:read on that project). Prints aggregates only: no emails, no ids.
//
// Queries stay small on purpose (raw rows for the cohort, joined here): a
// HogQL self-join over events hits PostHog's execution cap.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECT = 354151;
const DAY = 86_400_000;
// The first day of server funnel events backfilled every existing user as a
// "first sync"; cohorts start the day after.
const COHORTS_START = "2026-08-09T12:00:00Z";
// Kept: opened the app on 3+ distinct days after day 10. Judged only once a
// cohort is 14+ days old.
const KEPT_AFTER_DAYS = 10;
const KEPT_MIN_DAYS = 3;
const MATURE_DAYS = 14;
const INTERNAL = /@(almostcandid\.com|codecast\.sh)$/;

const key = readFileSync(join(homedir(), ".config/posthog/key"), "utf8").trim();

async function hogql(query: string): Promise<any[][]> {
  const res = await fetch(`https://us.posthog.com/api/projects/${PROJECT}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
  });
  const body: any = await res.json();
  if (!body.results) throw new Error(`PostHog: ${JSON.stringify(body).slice(0, 300)}`);
  return body.results;
}

const weekOf = (t: number) => {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

const now = Date.now();
const firstSync = new Map<string, number>();
const internal = new Set<string>();
for (const [pid, t, email] of await hogql(
  `select e.person_id, min(e.timestamp), any(p.properties.email) from events e left join persons p on p.id = e.person_id
   where e.event = 'first_session_synced' and e.timestamp > '${COHORTS_START}' group by e.person_id limit 10000`,
)) {
  firstSync.set(pid, Date.parse(t));
  if (email && INTERNAL.test(email)) internal.add(pid);
}
const cohort = `(select person_id from events where event = 'first_session_synced' and timestamp > '${COHORTS_START}')`;

const activeDays = new Map<string, Set<string>>();
for (const [pid, day] of await hogql(
  `select person_id, toDate(timestamp) d from events where event = 'inbox_digest_heartbeat' and timestamp > '${COHORTS_START}'
   and person_id in ${cohort} group by person_id, d limit 100000`,
)) {
  if (!activeDays.has(pid)) activeDays.set(pid, new Set());
  activeDays.get(pid)!.add(day);
}

// First-day behaviour: did they open the inbox or a conversation, and did a
// second person enter the picture (a team join or an invite link).
const sawProduct = new Set<string>();
const joinedTeam = new Set<string>();
for (const [pid, t, path] of await hogql(
  `select person_id, timestamp, properties.$pathname from events where event = '$pageview' and timestamp > '${COHORTS_START}'
   and person_id in ${cohort}
   and (properties.$pathname = '/inbox' or properties.$pathname like '/conversation/%' or properties.$pathname like '/join/%' or properties.$pathname = '/settings/team/join')
   limit 100000`,
)) {
  const t0 = firstSync.get(pid);
  if (t0 === undefined) continue;
  const dt = Date.parse(t) - t0;
  if (dt < -5 * 60_000) continue;
  const isTeam = path.startsWith("/join/") || path === "/settings/team/join";
  if (isTeam && dt <= 3 * DAY) joinedTeam.add(pid);
  if (!isTeam && dt <= DAY) sawProduct.add(pid);
}

type Row = { week: string; synced: number; saw_product_24h: number; joined_team_3d: number; mature: boolean; kept: number | null };
const rows = new Map<string, Row>();
for (const [pid, t0] of firstSync) {
  if (internal.has(pid)) continue;
  const week = weekOf(t0);
  const mature = now - t0 >= MATURE_DAYS * DAY;
  const row = rows.get(week) ?? { week, synced: 0, saw_product_24h: 0, joined_team_3d: 0, mature: true, kept: 0 };
  row.synced++;
  if (sawProduct.has(pid)) row.saw_product_24h++;
  if (joinedTeam.has(pid)) row.joined_team_3d++;
  if (!mature) row.mature = false;
  const late = [...(activeDays.get(pid) ?? [])].filter((d) => Date.parse(d) - t0 >= KEPT_AFTER_DAYS * DAY).length;
  if (late >= KEPT_MIN_DAYS) row.kept = (row.kept ?? 0) + 1;
  rows.set(week, row);
}
const weeks = [...rows.values()].sort((a, b) => a.week.localeCompare(b.week)).map((r) => (r.mature ? r : { ...r, kept: null }));

const [[visitors, intent, authed]] = await hogql(
  `with land as (select person_id from events where event = '$pageview' and properties.$pathname = '/' and timestamp > now() - interval 7 day group by person_id)
   select count(),
     countIf(person_id in (select person_id from events where event in ('install_command_copied', 'desktop_download_clicked') and timestamp > now() - interval 7 day)),
     countIf(person_id in (select person_id from events where event = 'cli_authed' and timestamp > now() - interval 7 day))
   from land`,
);
// A person bouncing between /auth/cli and /login: the redirect loop fixed on
// 2026-10-06. Any minute above 8 loads means it is back.
const loops = (
  await hogql(
    `select person_id, toStartOfMinute(timestamp) m, count() from events where event = '$pageview'
     and properties.$pathname in ('/auth/cli', '/login') and timestamp > now() - interval 7 day group by person_id, m having count() > 8 limit 1000`,
  )
).length;

const mature = weeks.filter((w) => w.mature);
const sum = (k: "synced" | "saw_product_24h" | "kept") => mature.reduce((n, w) => n + (w[k] ?? 0), 0);
const out = {
  as_of: new Date(now).toISOString(),
  last_7_days: { landing_visitors: visitors, install_intent: intent, cli_authed: authed, auth_redirect_loops: loops },
  mature_cohorts: { synced: sum("synced"), saw_product_24h: sum("saw_product_24h"), kept: sum("kept") },
  weeks,
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`Product-fit scorecard, ${out.as_of.slice(0, 10)}`);
  console.log(`Last 7 days: ${visitors} landing visitors, ${intent} install intent, ${authed} signed a CLI in, ${loops} sign-in redirect loops`);
  console.log(`Mature cohorts: ${out.mature_cohorts.synced} synced, ${out.mature_cohorts.saw_product_24h} opened the inbox or a session within 24h, ${out.mature_cohorts.kept} kept\n`);
  console.log("week of     synced  saw product 24h  joined team 3d  kept (3+ days after day 10)");
  for (const w of weeks) {
    console.log(`${w.week}  ${String(w.synced).padStart(6)}  ${String(w.saw_product_24h).padStart(15)}  ${String(w.joined_team_3d).padStart(14)}  ${w.kept === null ? "too young" : w.kept}`);
  }
}
