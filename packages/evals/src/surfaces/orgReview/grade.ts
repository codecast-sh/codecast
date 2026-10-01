import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';

import type { CheckResult, Freeze, GateResult, Score } from '@platform/evals';

import { routeGates, scoreOf } from '../../adapters/replay';
import { homePaths } from '../../paths';
import { gate, type AgentResult } from '../../surface';
import { meta } from './meta';
import { assembleProposals, proposalFiles, type AssembledProposal } from './assemble';
import { checkProposal } from './checkProposal';

// The mechanical half of the org rubric for one sample (the port of
// ~/.cache/org-eval/bin/grade.py): the same sets, bands and pools, against the
// workspace's hand labels in EVALS_HOME/labels/org-review/<ws>/grade-sets.json.
// gradeAuto() returns the exact object grade.py wrote to grade-auto.json, and
// grade.test.ts regrades saved rounds with both to prove it. gradeDir() turns
// it into gates and checks. The workspace comes from the freeze, never a path.

export interface GradeSets {
  must_not_close: string[];
  should_close: string[];
  found_by_a_run?: string[];
  name_it: string[];
  never_name: string[];
  must_not_reopen?: string[];
  either?: string[];
}

/** Python's sorted() over strings: by code point. */
const sorted = (xs: Iterable<string>): string[] => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const and = (a: Iterable<string>, b: Set<string>): Set<string> => new Set([...a].filter((x) => b.has(x)));
const minus = (a: Iterable<string>, ...bs: Set<string>[]): Set<string> => new Set([...a].filter((x) => !bs.some((b) => b.has(x))));

// Python's str.isspace() set (re's \s and strip() agree on it), and \w as a lookaround, so a
// count or a handle match never differs from grade.py on text outside ASCII.
const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_SPLIT = new RegExp(`[${PY_WS}]+`, 'u');
const PY_STRIP = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'gu');
const HYPHENATED = /@?(?<![\p{L}\p{N}_])([a-z][a-z0-9]*(?:-[a-z0-9]+)+)(?![\p{L}\p{N}_])/gu;
const AT_HANDLE = /@([a-z][a-z0-9-]*)/g;

/** f'{a.get("title","")}': a missing key is "", a null is "None". */
const pyField = (d: Record<string, unknown>, k: string): string => (k in d ? (d[k] === null ? 'None' : String(d[k])) : '');

export interface GradeAuto {
  changes: number;
  kinds: Record<string, number>;
  asks: Array<[string, number]>;
  summary_words: number;
  roles: string[];
  scopes: Record<string, string[]>;
  seats: string[];
  retires: string[];
  records: { grade: number; closed_total: number; reopened: string[]; wrong_reopen: string[]; wrong_close: string[]; right_close: string[]; missed: string[]; reachable: string[]; recall: string; closed_outside_sample: string[] };
  roles_named: { grade: number; phantom: string[]; mentioned: string[] };
  repeats: { seats: string[]; handles: string[] };
  sessions: { grade: number; named_ok: string[]; named_bad: string[]; named_missing: string[] };
  coverage: { before: string; after: string; still_without_lead: string[] };
}

/** One sample's grade-auto.json, field for field as grade.py computes it. `pool` is every handle a letter could wrongly remember. */
export function gradeAuto(spec: { changes: any[]; summary_md?: string; asks?: any[] }, inputs: any, sets: GradeSets, pool: Set<string>): GradeAuto {
  const mustNotClose = new Set(sets.must_not_close);
  const shouldClose = new Set([...sets.should_close, ...(sets.found_by_a_run ?? [])]);
  const foundByARun = new Set(sets.found_by_a_run ?? []);
  const nameIt = new Set(sets.name_it);
  const neverName = new Set(sets.never_name);
  const mustNotReopen = new Set(sets.must_not_reopen ?? []);
  const changes = spec.changes;
  const kinds: Record<string, number> = {};
  const closed = new Map<string, string>();
  const roles: string[] = [];
  const seats: string[] = [];
  const retires: string[] = [];
  const scopes: Record<string, string[]> = {};
  const reopened: string[] = [];
  for (const row of changes) {
    const c = row.change;
    kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
    if (c.kind === 'task_status' && (c.status === 'done' || c.status === 'dropped')) closed.set(c.task, c.status);
    if (c.kind === 'plan_status' && (c.status === 'done' || c.status === 'abandoned')) closed.set(c.plan, c.status);
    if (c.kind === 'plan_status' && c.status === 'active') reopened.push(c.plan);
    if (c.kind === 'role') {
      roles.push(c.handle);
      scopes[c.handle] = (c.scope || {}).projects ?? [];
      if (c.seat) seats.push(c.seat.existing);
    }
    if (c.kind === 'retire') retires.push(c.handle);
    // A session is named when a role takes it as its seat or adopts it.
    if (c.kind === 'adopt' && c.conversation) seats.push(c.conversation);
  }
  const closedIds = new Set(closed.keys());
  const wrongClose = sorted(and(closedIds, mustNotClose));
  const rightClose = sorted(and(closedIds, shouldClose));
  const missed = sorted(minus(shouldClose, closedIds));
  const outsideSampleClose = sorted(minus(closedIds, mustNotClose, shouldClose));
  // Recall is measured on what the served inputs flag: a record the inputs never showed cannot be missed.
  const flagged = new Set<string>((['plans', 'tasks'] as const).flatMap((k) => inputs.activity.stale[k].map((r: any) => r.short_id)));
  const reachable = and(shouldClose, new Set([...flagged, ...foundByARun]));
  const hit = and(rightClose, reachable);
  const records = wrongClose.length ? 0 : hit.size >= 0.7 * reachable.size ? 3 : hit.size >= 0.4 * reachable.size ? 2 : 1;
  const seatSet = new Set(seats);
  const namedOk = sorted(and(seatSet, nameIt));
  const namedBad = sorted(and(seatSet, neverName));
  const namedMissing = sorted(minus(nameIt, seatSet));
  const sessionsGrade = namedBad.length ? 0 : !namedMissing.length ? 3 : namedOk.length ? 2 : 1;
  // Coverage after apply: which projects with work have a lead once the roles are in.
  const titleOf = new Map<string, string>();
  for (const p of inputs.projects) if (p.short_id) titleOf.set(p.short_id, p.title);
  for (const p of inputs.projects) titleOf.set(p.id, p.title);
  const ledBefore = new Set<string>(inputs.coverage.projects.filter((p: any) => p.lead).map((p: any) => p.title));
  const ledNew = new Set<string>();
  for (const refs of Object.values(scopes)) for (const r of refs) ledNew.add(titleOf.get(r) ?? r);
  const withWork: string[] = inputs.coverage.projects.map((p: any) => p.title);
  const after = withWork.filter((t) => ledBefore.has(t) || ledNew.has(t));
  const asks: any[] = spec.asks ?? [];
  // Roles a letter or an ask names must exist: a row of the inputs' org.roles, or a role change in this proposal.
  const knownHandles = new Set<string>([...inputs.org.roles.map((r: any) => r.handle), ...roles]);
  const namedText = [spec.summary_md ?? '', ...asks.map((a) => `${pyField(a, 'title')} ${pyField(a, 'why')} ${pyField(a, 'effect')}`)].join(' ');
  const tokens = new Set<string>([...[...namedText.matchAll(HYPHENATED)].map((m) => m[1]!), ...[...namedText.matchAll(AT_HANDLE)].map((m) => m[1]!)]);
  const mentioned = and(tokens, new Set([...pool, ...knownHandles]));
  const phantom = sorted([...mentioned].filter((h) => !knownHandles.has(h)));
  const summaryWords = (spec.summary_md ?? '').replace(PY_STRIP, '').split(PY_SPLIT).length;
  const seatedRoles = new Set<string>(inputs.org.roles.filter((r: any) => r.seat).map((r: any) => r.seat.session));
  const existingHandles = new Set<string>(inputs.org.roles.map((r: any) => r.handle));
  return {
    changes: changes.length,
    kinds,
    asks: asks.map((a) => [a.title, a.seqs.length]),
    summary_words: summaryWords,
    roles,
    scopes,
    seats,
    retires,
    records: { grade: records, closed_total: closed.size, reopened: sorted(reopened), wrong_reopen: sorted(and(reopened, mustNotReopen)), wrong_close: wrongClose, right_close: rightClose, missed, reachable: sorted(reachable), recall: `${hit.size} of ${reachable.size}`, closed_outside_sample: outsideSampleClose },
    roles_named: { grade: phantom.length ? 0 : 3, phantom, mentioned: sorted(mentioned) },
    // An update run repeats an accepted change when it seats a session a role already holds, or proposes a handle that exists.
    repeats: { seats: sorted(and(seats, seatedRoles)), handles: sorted(and(roles, existingHandles)) },
    sessions: { grade: sessionsGrade, named_ok: namedOk, named_bad: namedBad, named_missing: namedMissing },
    coverage: { before: `${ledBefore.size} of ${withWork.length}`, after: `${after.length} of ${withWork.length}`, still_without_lead: withWork.filter((t) => !after.includes(t)) },
  };
}

// ── Where a workspace's labels, snapshots and runs live ──────────────────────

const readJson = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
/** A JSON file's value, or null when it is missing or does not parse. */
export const tryJson = (path: string): any => {
  try {
    return readJson(path);
  } catch {
    return null;
  }
};

/** The old org loop's home: an archive since the migration, which grading never writes into. */
export const ORG_EVAL_CACHE = join(homedir(), '.cache', 'org-eval');

/** Throws when dir sits inside the archive: grading writes grade-auto.json and proposal.json into the dir it grades. */
export function refuseArchive(dir: string, archive = ORG_EVAL_CACHE): void {
  if (!existsSync(archive) || !existsSync(dir)) return;
  const rel = relative(realpathSync(archive), realpathSync(dir));
  if (rel.split('/')[0] !== '..') throw new Error(`${dir} is inside ${archive}, which stays an untouched archive; copy the dir out and grade the copy`);
}

export const SURFACE = 'org-review';
export const labelsDir = (ws: string): string => join(homePaths().labels, SURFACE, ws);
export const snapshotsRoot = (): string => join(homePaths().snapshots, SURFACE);

/** The label key of a workspace name: "Union" files under labels/org-review/union. */
export const workspaceKey = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Which workspace a served dir was captured from: captured.json says so, else its inputs name it. */
export function snapshotWorkspace(dir: string): string | null {
  const captured = tryJson(join(dir, 'captured.json'));
  if (captured?.workspace) return String(captured.workspace);
  const name = tryJson(join(dir, 'org-inputs.json'))?.workspace?.name;
  return name ? workspaceKey(String(name)) : null;
}

export function loadGradeSets(ws: string): GradeSets {
  const path = join(labelsDir(ws), 'grade-sets.json');
  if (!existsSync(path)) throw new Error(`no grade sets for ${ws} at ${path}; the hand labels live in the private labels repo (./evals doctor)`);
  return readJson(path) as GradeSets;
}

/** The role handles a proposal's changes add and an inputs file's roster holds. */
export const roleHandles = (d: any): string[] => [
  ...(d?.changes ?? []).filter((r: any) => r?.change?.kind === 'role').map((r: any) => r.change.handle),
  ...((d?.org ?? {}).roles ?? []).map((r: any) => r.handle),
];

/**
 * Every handle a letter could wrongly remember, as grade.py's pool was: the
 * historical pool saved with the labels (every role any old round proposed,
 * every old served roster), every snapshot's roster, and every role a run of
 * this surface proposed for the workspace since.
 */
export function handlePool(ws: string): Set<string> {
  const pool = new Set<string>(tryJson(join(labelsDir(ws), 'handle-pool.json')) ?? []);
  const snaps = snapshotsRoot();
  if (existsSync(snaps)) {
    for (const name of readdirSync(snaps)) {
      const dir = join(snaps, name);
      if (statSync(dir).isDirectory() && snapshotWorkspace(dir) === ws) for (const h of roleHandles(tryJson(join(dir, 'org-inputs.json')))) pool.add(h);
    }
  }
  const runs = homePaths().runs;
  if (existsSync(runs)) {
    for (const name of readdirSync(runs)) {
      if (!name.startsWith(`${SURFACE}-`)) continue;
      if (tryJson(join(runs, name, 'hashes.json'))?.workspace !== ws) continue;
      for (const h of roleHandles(tryJson(join(runs, name, 'proposal.json')))) pool.add(h);
    }
  }
  return pool;
}

// ── From a run dir to a Score ────────────────────────────────────────────────

export interface OrgGradeContext {
  workspace: string;
  /** The served dir the run read: its org-inputs.json is what recall and coverage count against. */
  servedDir: string;
  sets: GradeSets;
  pool: Set<string>;
  /** Grade the frozen reads from the dir's calls.log; a replay leaves this to the route gate. */
  frozenReads?: boolean;
}

export interface OrgGrade {
  auto: GradeAuto;
  spec: AssembledProposal;
  gates: GateResult[];
  checks: CheckResult[];
}

const ratio = (s: string): number => {
  const [a, b] = s.split(' of ').map(Number);
  return b ? a! / b : 1;
};
const callsLog = (dir: string): string[] => {
  const hits = [join(dir, 'calls.log'), ...(existsSync(dir) ? readdirSync(dir).filter((d) => /^agent\d+$/.test(d)).map((d) => join(dir, d, 'agent', 'calls.log')) : [])];
  return hits.filter(existsSync).flatMap((p) => readFileSync(p, 'utf8').split('\n').filter(Boolean));
};

/** Assembles the dir's proposals (an old single proposal.json is read as is), grades it, and writes grade-auto.json beside it as grade.py did. */
export function gradeDir(dir: string, ctx: OrgGradeContext): OrgGrade {
  refuseArchive(dir);
  const files = proposalFiles(dir);
  const spec: AssembledProposal = files.length || !existsSync(join(dir, 'proposal.json')) ? assembleProposals(dir) : readJson(join(dir, 'proposal.json'));
  const inputs = readJson(join(ctx.servedDir, 'org-inputs.json'));
  const auto = gradeAuto(spec, inputs, ctx.sets, ctx.pool);
  writeFileSync(join(dir, 'grade-auto.json'), JSON.stringify(auto, null, 1));

  const parsed = files.map((f) => ({ file: basename(f), errors: checkProposal(readJson(f)).errors }));
  const broken = parsed.filter((p) => p.errors.length);
  const r = auto.records;
  const gates: GateResult[] = [
    gate('spec-parses', files.length > 0 && !broken.length, !files.length ? 'no proposals/op-*.json was written' : broken.length ? broken.map((b) => `${b.file}: ${JSON.stringify(b.errors).slice(0, 300)}`).join('; ') : `${files.length} proposal file(s) parse`),
    gate('no-wrong-close', !r.wrong_close.length, r.wrong_close.length ? `closes ${r.wrong_close.join(', ')}, which the labels say must stay open` : `closes ${r.closed_total}, none the labels say must stay open`),
    gate('no-never-name', !auto.sessions.named_bad.length, auto.sessions.named_bad.length ? `names ${auto.sessions.named_bad.join(', ')}, which the labels say is a finished job` : 'names no session the labels rule out'),
    gate('no-phantom-handle', !auto.roles_named.phantom.length, auto.roles_named.phantom.length ? `the letter names ${auto.roles_named.phantom.map((h) => `@${h}`).join(', ')}, a role neither the inputs nor this proposal has` : 'every role the letter names exists'),
  ];
  // A dir graded with no replay gets the route's frozen-reads gate over the calls.log it kept.
  if (ctx.frozenReads) gates.push(...routeGates(meta, { calls: [], agents: [{ calls: callsLog(dir), model: meta.model, modelUsage: {}, isError: false, exitCode: 0 } as unknown as AgentResult] }).filter((g) => g.id === 'frozen-reads'));
  const repeated = [...auto.repeats.seats, ...auto.repeats.handles];
  const checks: CheckResult[] = [
    { id: 'records', ask: 'records: 3 at 70% recall of the reachable stale records, 2 at 40%, else 1; 0 on a wrong close', weight: 1, score: r.grade / 3, evidence: `recall ${r.recall}; missed ${r.missed.length}; closed outside the sample ${r.closed_outside_sample.length}` },
    { id: 'sessions', ask: 'named sessions: 3 when every session the labels name is seated, 2 when some are, 1 when none, 0 on a ruled-out one', weight: 1, score: auto.sessions.grade / 3, evidence: auto.sessions.named_missing.length ? `missing ${auto.sessions.named_missing.join(', ')}` : 'every labelled session is named' },
    { id: 'roles_named', ask: 'every role the letter and the asks name exists', weight: 1, score: auto.roles_named.grade / 3, evidence: `mentioned ${auto.roles_named.mentioned.join(', ') || 'none'}` },
    { id: 'coverage', ask: 'projects with work that have a lead after the proposal', weight: 1, score: ratio(auto.coverage.after), evidence: `before ${auto.coverage.before}, after ${auto.coverage.after}` },
    { id: 'repeats', ask: 'proposes no seat or handle the inputs already hold', weight: 1, score: repeated.length ? 0 : 1, evidence: repeated.length ? `repeats ${repeated.join(', ')}` : 'repeats nothing' },
    // grade.py records the count with no band; it is shown, and moves no score.
    { id: 'summary_words', ask: 'words in the letter', weight: 0, score: 1, evidence: String(auto.summary_words) },
  ];
  return { auto, spec, gates, checks };
}

/** The workspace and served dir a freeze names (meta.workspace, meta.snapshot). */
export function freezeContext(f: Pick<Freeze, 'id' | 'meta'>): { workspace: string; servedDir: string } {
  const m = (f.meta ?? {}) as { workspace?: string; snapshot?: string };
  if (!m.workspace || !m.snapshot) throw new Error(`freeze ${f.id.slice(0, 8)} names no workspace and snapshot; org-review freezes come from ./evals freeze create org-review@<snapshot>`);
  return { workspace: m.workspace, servedDir: join(homePaths().snapshots, m.snapshot) };
}

/** `./evals grade org-review <dir> --freeze <id>`: an existing dir (an old round, a run folder) graded with no replay. */
export function gradeExisting(dir: string, label: GradeSets | undefined, freeze: Freeze | undefined): Score {
  if (!freeze) throw new Error('org-review grades against a freeze: pass --freeze <id> (the workspace comes from the freeze, not the path)');
  const { workspace, servedDir } = freezeContext(freeze);
  const ran = tryJson(join(dir, 'hashes.json'))?.served;
  if (ran && !basename(servedDir).endsWith(String(ran))) console.error(`note: ${dir} ran on served "${ran}", graded against ${basename(servedDir)}`);
  const g = gradeDir(dir, { workspace, servedDir, sets: label ?? loadGradeSets(workspace), pool: handlePool(workspace), frozenReads: true });
  return scoreOf(g.gates, g.checks);
}
