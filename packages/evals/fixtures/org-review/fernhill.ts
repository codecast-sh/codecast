#!/usr/bin/env bun
// Two synthetic org-review snapshots of one small company, Fernhill, written
// to EVALS_HOME/snapshots/org-review (the surface reads snapshots only there):
//
//   fernhill-inbox  Mara's inbox holds loose sessions whose work plainly sits
//                   in an area a role owns (growth, billing, mobile), one on an
//                   open task, one finished, and three that are hers alone.
//   fernhill-calm   the control: every loose session is Mara's own work.
//
// The records are clean in both, so a review has nothing else to settle and
// the run is short. Each world is its own workspace in the labels repo, whose
// grade-sets.json says where each session may go (`files`) and which must
// stay (`keep`).
//
//   bun packages/evals/fixtures/org-review/fernhill.ts

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { headOfPeopleOpening } from '@codecast/shared/contracts/headOfPeoplePrompt';

import { looseLines } from '../../../cli/src/orgLooseRun';
import { homePaths } from '../../src/paths';
import { EVERY_READ, writeFrozenVerbs, writeServedRead } from '../../src/served';

const stripAnsi = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '');

const NOW = Date.parse('2026-10-14T09:00:00.000Z');
const DAY = 86_400_000;
const MARA = 'kd7fernmara0000000000000000000';
const THEO = 'kd7ferntheo0000000000000000000';
const WS = 'k97fernhill0000000000000000000';

const projects = [
  { id: 'sd7fernsite', short_id: 'pr-1', title: 'Marketing site', path: '/Users/mara/src/fernhill-site', description: 'The public site: pricing, docs landing, launch pages and the newsletter.' },
  { id: 'sd7fernbill', short_id: 'pr-2', title: 'Billing', path: '/Users/mara/src/fernhill', description: 'Stripe, invoices, refunds and the billing API.' },
  { id: 'sd7fernmobl', short_id: 'pr-3', title: 'Mobile app', path: '/Users/mara/src/fernhill-mobile', description: 'The iOS and Android app.' },
];
const roles = [
  { id: 'ms7fernhop', short_id: 'or-1', handle: 'head-of-people', name: 'Head of People', scope: [] as string[], seat: 'jx7hop1', charter: 'Keeps the company structure true to how the work runs.' },
  { id: 'ms7ferngrw', short_id: 'or-2', handle: 'growth', name: 'Growth lead', scope: ['pr-1'], seat: 'jx7grw1', charter: 'Owns the marketing site, launches and the newsletter.' },
  { id: 'ms7fernbil', short_id: 'or-3', handle: 'billing', name: 'Billing lead', scope: ['pr-2'], seat: 'jx7bil1', charter: 'Owns payments, invoices and refunds end to end.' },
  { id: 'ms7fernmob', short_id: 'or-4', handle: 'mobile', name: 'Mobile lead', scope: ['pr-3'], seat: 'jx7mob1', charter: 'Owns the iOS and Android app and its releases.' },
];
const plans = [
  { id: 'ss7fernpl1', short_id: 'pl-11', title: 'Launch v2 pricing', project: 'pr-1', done: 3, total: 5 },
  { id: 'ss7fernpl2', short_id: 'pl-12', title: 'Refunds and credits', project: 'pr-2', done: 2, total: 6 },
  { id: 'ss7fernpl3', short_id: 'pl-13', title: 'Push notifications', project: 'pr-3', done: 1, total: 4 },
];
const tasks = [
  { short_id: 'ct-212', title: 'Partial refunds in the billing API', plan: 'pl-12', project: 'pr-2', status: 'in_progress' },
  { short_id: 'ct-213', title: 'Credit notes on invoices', plan: 'pl-12', project: 'pr-2', status: 'open' },
  { short_id: 'ct-111', title: 'New pricing page', plan: 'pl-11', project: 'pr-1', status: 'in_progress' },
  { short_id: 'ct-131', title: 'Android push via FCM v1', plan: 'pl-13', project: 'pr-3', status: 'open' },
];

type Loose = { id: string; title: string; path: string; state: string; ago_days: number; messages: number; said: string[]; files?: string[]; keep?: true };
const HOME = '/Users/mara';
const site = projects[0]!.path, bill = projects[1]!.path, mobl = projects[2]!.path;

const inbox: Loose[] = [
  { id: 'jx7g001', title: 'Draft the launch thread for v2 pricing', path: site, state: 'idle', ago_days: 1, messages: 34, files: ['@growth'], said: ['Draft a launch thread for the v2 pricing change for X and LinkedIn.', 'Five posts drafted in launch/thread.md, linking the new pricing page.'] },
  { id: 'jx7g002', title: 'Fix pricing page copy and FAQ', path: site, state: 'working', ago_days: 0, messages: 61, files: ['@growth', 'ct-111'], said: ['The pricing page still says "per seat" in the FAQ. Fix the copy everywhere.', 'Updated pricing.tsx and faq.mdx; checking the comparison table next.'] },
  { id: 'jx7g003', title: 'Newsletter #14: what shipped in September', path: site, state: 'idle', ago_days: 3, messages: 22, files: ['@growth'], said: ['Write newsletter #14 from what shipped in September.', 'Draft in newsletter/14.md, waiting on two screenshots.'] },
  { id: 'jx7b001', title: 'Stripe webhook retries failing with 409', path: bill, state: 'working', ago_days: 0, messages: 88, files: ['@billing'], said: ['Stripe keeps retrying invoice.paid and our handler answers 409. Find out why.', 'The idempotency key is reused across events; fixing the handler in billing/webhooks.ts.'] },
  { id: 'jx7b002', title: 'Invoice PDF is missing the VAT number', path: bill, state: 'idle', ago_days: 2, messages: 17, files: ['@billing', 'ct-213'], said: ['EU customers say the invoice PDF has no VAT number on it.', 'Found the template field; the VAT id is not passed from the customer record yet.'] },
  { id: 'jx7b003', title: 'Partial refunds: wire the refund endpoint', path: bill, state: 'working', ago_days: 0, messages: 140, files: ['ct-212', '@billing'], said: ['Work on ct-212: partial refunds in the billing API.', 'POST /refunds now takes an amount; writing the Stripe partial refund call.'] },
  { id: 'jx7m001', title: 'Android push notifications not arriving', path: mobl, state: 'idle', ago_days: 4, messages: 45, files: ['@mobile', 'ct-131'], said: ['Push notifications never arrive on Android 14 devices.', 'The legacy FCM endpoint is gone; this needs the FCM v1 migration.'] },
  { id: 'jx7d001', title: 'Bump Node to 22 in CI', path: bill, state: 'done', ago_days: 9, messages: 12, files: ['done'], said: ['Move CI to Node 22.', 'Merged in #482, CI is green on Node 22. Nothing left to do.'] },
  { id: 'jx7p001', title: 'October investor update', path: HOME, state: 'idle', ago_days: 1, messages: 26, keep: true, said: ['Help me write the October investor update.', 'Draft has revenue, burn and the three asks; you wanted to add the hiring note.'] },
  { id: 'jx7p002', title: 'Hiring plan: first support hire', path: HOME, state: 'idle', ago_days: 2, messages: 19, keep: true, said: ['Think through whether our first support hire should be full time.', 'Compared three options; you were leaning to a contractor until January.'] },
  { id: 'jx7p003', title: 'Lisbon offsite logistics', path: HOME, state: 'needs_input', ago_days: 0, messages: 14, keep: true, said: ['Plan the Lisbon offsite for the four of us in November.', 'Two venues shortlisted; which week do you prefer?'] },
];
const calm: Loose[] = [
  inbox[8]!, inbox[9]!, inbox[10]!,
  { id: 'jx7p004', title: 'Answer Acme procurement questionnaire', path: HOME, state: 'working', ago_days: 0, messages: 30, keep: true, said: ['Acme sent their vendor questionnaire; help me answer it.', 'Twenty of thirty-two answered; the rest need your call on data retention.'] },
];

function inputs(loose: Loose[]) {
  const ts = (d: number) => NOW - d * DAY - 3_600_000;
  return {
    workspace: { id: WS, kind: 'team', name: 'Fernhill' },
    generated_at: NOW,
    window_days: 30,
    caps: {},
    members: [
      { user_id: MARA, name: 'Mara Okafor', is_me: true, sessions_30d: 64, by_project_path: { [site]: 18, [bill]: 26, [mobl]: 9, [HOME]: 11 } },
      { user_id: THEO, name: 'Theo Lind', is_me: false, sessions_30d: 22, by_project_path: { [mobl]: 22 } },
    ],
    labels: [],
    git_roots: [],
    projects: projects.map((p) => ({ id: p.id, short_id: p.short_id, title: p.title, description: p.description, status: 'active', project_path: p.path, plans: 1, tasks: { open: 2, total: 9, by_status: { open: 1, in_progress: 1, done: 7 } }, updated_at: NOW - DAY })),
    plans: plans.map((p) => ({ id: p.id, short_id: p.short_id, title: p.title, status: 'active', project_id: projects.find((x) => x.short_id === p.project)!.id, progress: { done: p.done, in_progress: 1, open: p.total - p.done - 1, total: p.total, source: 'plan' }, updated_at: NOW - DAY })),
    tasks: { total: 27, by_status: { open: 6, in_progress: 4, done: 17 }, unfiled_open: 0, truncated: false, closed_counted: 'inside the window only' },
    docs_by_type: { note: 6 },
    decisions_open_by_category: {},
    channels: [],
    insights: { total: 0, headlines: [], outcomes: {}, themes: [] },
    said: { calls: [], chat: [], truncated: false },
    activity: { areas: [], bound: { plans: [], tasks: [] }, commits: { total: 0, landed: 0 }, people: [], stale: { plans: [], projects: [], tasks: [] } },
    coverage: { active_initiatives: 0, active_without_owner: 0, initiatives: [], with_work: 3, with_lead: 3, with_lead_paused: 0, projects: projects.map((p) => ({ id: p.id, title: p.title, initiatives: [], open_plans: 1, open_tasks: 2 })), outside: { areas: [], plans: [], open_tasks: 0 } },
    sessions: {
      total: loose.length + 9,
      truncated: false,
      unfiled: loose.length,
      loose: { count: loose.length, rows: loose.map((s) => ({ short_id: s.id, title: s.title, state: s.state, last_active_at: ts(s.ago_days), started_at: ts(s.ago_days + 2), messages: s.messages, project_path: s.path })) },
      titles_by_path: {},
      long_running: { listed: 0, min_age_days: 7, old_enough: 0, rows: [] },
    },
    org: {
      roles: roles.map((r) => ({ id: r.id, short_id: r.short_id, handle: r.handle, name: r.name, status: 'active', reports_to: 'Mara Okafor', charter: r.charter, scope: { projects: r.scope.map((s) => projects.find((p) => p.short_id === s)!.title), plans: [] }, seat: { session: r.seat, title: r.name }, standing: true, trust: r.handle === 'head-of-people' ? 'understand' : 'direct', starts_on_its_own: r.handle !== 'head-of-people', hands: 2, idle: false, idle_days: 0, overlaps: [] })),
      anchors: [],
      projects_without_role: [],
      whole_workspace_roles: 0,
    },
    truncated: { docs: false, insights: false, plans: false, projects: false, tasks: false },
  };
}

const health = {
  workspace: { id: WS, kind: 'team' },
  generated_at: NOW,
  company: { flags: [], stale: { plans: [], projects: [], tasks: [] }, unowned_projects: [], unfiled_plans: [], unfiled_tasks: 0, plans_without_goal: [], projects_without_charter: [], watched_without_lead: [] },
  people: [{ user_id: MARA, name: 'Mara Okafor', direct_roles: 4, decisions_waiting: { n: 0 }, flags: [] }],
  roles: roles.map((r) => ({ role_id: r.id, short_id: r.short_id, handle: r.handle, name: r.name, status: 'active', reports_to: { kind: 'user', user_id: MARA }, area: { status: 'on_track', status_line: r.handle === 'head-of-people' ? 'On track: last review found nothing stale.' : `On track: ${plans.find((p) => p.project === r.scope[0])?.title ?? 'its area'} moving.`, sessions: [], waiting: [], signals: [] }, flags: [] })),
  truncated: { decisions: false, plans: false, projects: false, sessions: false, tasks: false },
};

const brief = (loose: Loose[]) => `@head-of-people · Head of People · reports to Mara Okafor

## Where it stands
- 2026-10-07 Company: Three leads own the three projects and the records match the work; nothing waits on Mara.

## Playbook
(empty)

Sessions under you: none. Loose sessions in Mara's inbox: ${loose.length}.`;

function readOf(s: Loose): string {
  return [`Session ${s.id} · ${s.title} · Mara Okafor · ${s.path} · ${s.state} · ${s.messages} messages`, '', `[1] Mara: ${s.said[0]}`, `[${s.messages}] assistant: ${s.said[1]}`].join('\n');
}

type Read = { argv: string[]; out: string; prefix?: boolean };

/** Every read the world answers, for the org-review snapshot and the role-wake fixture alike. */
function worldReads(loose: Loose[]): Read[] {
  const reads: Read[] = [
    { argv: ['brief'], out: brief(loose) },
    { argv: ['brief', '--json'], out: JSON.stringify({ role: { handle: 'head-of-people', name: 'Head of People' }, standing: ['2026-10-07 Company: Three leads own the three projects and the records match the work.'] }) },
    ...loose.map((s) => ({ argv: ['read', s.id], out: readOf(s), prefix: true })),
    ...loose.map((s) => ({ argv: ['summary', s.id], out: `${s.title}: ${s.said[1]}`, prefix: true })),
    ...tasks.map((t) => ({ argv: ['task', 'show', t.short_id], out: `${t.short_id} · ${t.title} · ${t.status} · plan ${t.plan} · project ${t.project}`, prefix: true })),
    ...plans.map((p) => ({ argv: ['plan', 'show', p.short_id], out: `${p.short_id} · ${p.title} · active · ${p.done}/${p.total} done`, prefix: true })),
    { argv: ['link'], out: 'https://codecast.sh/s/fernhill', prefix: true },
    { argv: ['org', 'proposals'], out: 'No open proposals.', prefix: true },
  ];
  for (const p of projects) {
    const body = [`${p.short_id} · ${p.title} · active · led by @${roles.find((r) => r.scope.includes(p.short_id))!.handle}`, p.description, '', ...plans.filter((x) => x.project === p.short_id).map((x) => `${x.short_id} ${x.title} (${x.done}/${x.total})`), ...tasks.filter((t) => t.project === p.short_id).map((t) => `  ${t.short_id} ${t.status} ${t.title}`)].join('\n');
    reads.push({ argv: ['project', 'show', p.short_id], out: body, prefix: true }, { argv: ['project', 'show', p.title], out: body, prefix: true });
  }
  return reads;
}

const orgLs = { generated_at: NOW, roles: roles.map((r) => ({ _id: r.id, short_id: r.short_id, handle: r.handle, name: r.name, status: 'active' })), people: [{ user_id: MARA, name: 'Mara Okafor', is_me: true }], anchors: [] };
const labelOf = (loose: Loose[]) => ({ files: Object.fromEntries(loose.filter((s) => s.files).map((s) => [s.id, s.files!])), keep: loose.filter((s) => s.keep).map((s) => s.id) });

function write(name: string, loose: Loose[]): void {
  const dir = join(homePaths().snapshots, 'org-review', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'reads'), { recursive: true });
  writeFileSync(join(dir, 'org-inputs.json'), JSON.stringify(inputs(loose), null, 1));
  writeFileSync(join(dir, 'org-health.json'), JSON.stringify(health, null, 1));
  writeFileSync(join(dir, 'org-ls.json'), JSON.stringify(orgLs, null, 1));
  writeFileSync(join(dir, 'captured.json'), JSON.stringify({ argv: [], values: { team: 'Fernhill', name }, captured_at: new Date(NOW).toISOString(), workspace: name, synthetic: true }, null, 1));
  for (const r of worldReads(loose)) writeServedRead(dir, r.argv, r.out, 0, { prefix: r.prefix });
  writeFrozenVerbs(dir, ['org', 'brief', EVERY_READ]);
  const { files, keep } = labelOf(loose);
  const labels = join(homePaths().labels, 'org-review', name);
  mkdirSync(labels, { recursive: true });
  writeFileSync(join(labels, 'grade-sets.json'), JSON.stringify({ must_not_close: [], should_close: [], name_it: [], never_name: [], files, keep }, null, 1));
  console.log(`${dir}: ${loose.length} loose sessions, ${Object.keys(files).length} to file, ${keep.length} to keep`);
}

// The Head of People's daily look (org-staffing.md S43) as a role-wake
// fixture: its trigger fires in its standing session over the same world, and
// the label holds it to the same filings. Committed, since the world is synthetic.
function writeLook(name: string, loose: Loose[], notes: string): void {
  const now = NOW;
  const answer = { count: loose.length, rows: loose.map((s) => ({ short_id: s.id, title: s.title, state: s.state, last_active_at: now - s.ago_days * DAY - 3_600_000, project_path: s.path })), last_look_at: now - DAY, new: loose.filter((s) => s.ago_days < 1).map((s) => s.id) };
  const fixture = {
    asOf: new Date(now).toISOString(),
    notes,
    // A session the last look already saw may stay: a daily look that re-proposed it every day would nag.
    label: { ...labelOf(loose), files: Object.fromEntries(Object.entries(labelOf(loose).files).map(([id, to]) => [id, answer.new.includes(id) ? to : [...to, 'stay']])) },
    snapshot: {
      captured_at: new Date(now).toISOString(),
      fixture: { trigger: 'tr-930', routine: 'inbox', role: { handle: 'head-of-people', name: 'Head of People', reports_to: 'Mara Okafor', scope: [], goals: [], charter: headOfPeopleOpening({ workspace: 'Fernhill', person: 'Mara Okafor' }).split('\n\n')[1] } },
      values: { role: 'head-of-people', team: 'Fernhill' },
      reads: [
        ...worldReads(loose).map((r) => (r.argv[0] === 'brief' ? { ...r, argv: ['brief', '@head-of-people', ...r.argv.slice(1)] } : r)),
        { argv: ['org', 'loose'], out: stripAnsi(looseLines(answer, now).join('\n')), prefix: true },
        { argv: ['org', 'inputs'], out: JSON.stringify(inputs(loose)), prefix: true },
        { argv: ['org', 'health'], out: JSON.stringify(health), prefix: true },
        { argv: ['org', 'ls'], out: JSON.stringify(orgLs), prefix: true },
        { argv: ['role', 'ls'], out: roles.map((r) => `@${r.handle} · ${r.name} · reports to Mara Okafor · looks after ${r.scope.map((x) => projects.find((p) => p.short_id === x)!.title).join(', ') || 'no project'}\n  ${r.charter}`).join('\n'), prefix: true },
        ...roles.map((r) => ({ argv: ['role', 'show', `@${r.handle}`], out: `@${r.handle} · ${r.name}\n${r.charter}`, prefix: true })),
        // A bare `cast org` prints the group's usage, as the CLI in this tree has it.
        { argv: ['org'], out: spawnSync('cast', ['org', '--help'], { encoding: 'utf8' }).stdout },
        { argv: ['org', 'show'], out: JSON.stringify(orgLs), prefix: true },
        { argv: ['task', 'ls'], out: 'No matching tasks.', prefix: true },
        { argv: ['org', 'where'], out: 'Workspace: Fernhill\nThis session: jx7hop1, the Head of People\nReports to: Mara Okafor\nRoles: @growth (Marketing site), @billing (Billing), @mobile (Mobile app), each reporting to Mara Okafor', prefix: true },
      ],
    },
  };
  const path = join(import.meta.dir, '..', 'role-wake', `${name}.json`);
  writeFileSync(path, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`${path}: ${Object.keys(fixture.label.files).length} to file, ${fixture.label.keep.length} to keep`);
}

// The busy world: the work that belongs to the leads is mostly still running.
const busy: Loose[] = [
  ...inbox.slice(0, 7).map((s) => ({ ...s, state: 'working', ago_days: 0 })),
  { id: 'jx7g004', title: 'Pricing page A/B test copy', path: site, state: 'working', ago_days: 0, messages: 52, files: ['@growth', 'ct-111'], said: ['Set up the A/B test on the pricing page headline.', 'Two variants live behind the flag; collecting the first day of numbers.'] },
  { id: 'jx7m002', title: 'iOS release 2.3 build failing on CI', path: mobl, state: 'needs_input', ago_days: 0, messages: 77, files: ['@mobile', 'stay'], said: ['The iOS 2.3 release build fails on CI at signing.', 'The profile expired; should I renew it with the team account?'] },
  inbox[8]!, inbox[9]!, inbox[10]!,
];

write('fernhill-inbox', inbox);
write('fernhill-busy', busy);
write('fernhill-calm', calm);
writeLook('inbox-look-files', inbox, "S43: the Head of People's daily look fires over Mara's inbox: eight loose sessions do the growth, billing and mobile leads' work (one on an open task, one finished) and three are hers. It files the eight and leaves her three.");
writeLook('inbox-look-calm', calm, "S43 control: the daily look fires, and every loose session in Mara's inbox is her own work. It files nothing and says so in a line.");
