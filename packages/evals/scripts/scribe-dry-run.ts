#!/usr/bin/env bun
// A dry run of the Scribe prompt (shared/contracts/scribePrompt.ts) over a real
// huddle, graded from the board it leaves (ct-102408). The model runs through
// packages/cli/scripts/prompt-dry-run.ts, its `cast board` writes answered by
// the evals fake (src/fakes/cast/board.ts), which runs the real board verbs.
//
//   bun packages/evals/scripts/scribe-dry-run.ts prepare --call <call.json> --listings <dir> --out <run-root> [--from 1 --to 220 --from 378 --to 452] [--max-chunks 15]
//   bun packages/evals/scripts/scribe-dry-run.ts run --out <run-root> [--model claude-opus-5-5]
//   bun packages/evals/scripts/scribe-dry-run.ts grade --out <run-root>
//
// `prepare` reads a call as `cast call <id> --json` prints it and the
// workspace's listings (priorities.txt, goals.txt, plans.txt, tasks.txt, each
// what the live CLI printed once), and writes into <run-root>: prompt.md
// (scribeInstructions), chunkNN.md (each led by scribeChunkHeader as convex
// builds it) and seed.json (the fake's world: the board with one person's
// sticky, the call, the listings). The call and the listings are real data:
// keep <run-root> in EVALS_HOME, never in the repo.
//
// Chunks: the stretches' lines in order, a chunk closing at 2.5 s of silence
// once it holds 20 lines, or at 28 lines: about 25 lines each. The first chunk
// a route delivers carries the full brief, and every HUDDLE_REBRIEF_EVERY-th.
//
// `run` needs a cast built from this checkout first on PATH, since the harness
// reads the command tree from it; it makes one under <run-root>/bin.
// `grade` reads <run-root>/run.harness/fake/world.json and the run's
// calls.log and replies, and writes grade.json and grade.md.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { artifactView, type ArtifactElement } from '@codecast/shared/artifacts';
import { addressesAgent, formatTranscriptChunk, HUDDLE_REBRIEF_EVERY, isHuddlePass, needsFullBrief } from '@codecast/shared/contracts';
import { scribeChunkHeader, scribeInstructions } from '@codecast/shared/contracts/scribePrompt';

import { enclosingFrameKeys, frameCollapsed, frameRef, hiddenKeys } from '../../shared/artifacts/boardFrames';

import { boardElements } from '../src/fakes/cast/board';
import type { FakeBoard, FakeWorld, WorldSeed } from '../src/fakes/cast/world';
import { FAKE_MODULE } from '../src/fakes/seed';

const REPO = resolve(import.meta.dir, '../../..');
const HARNESS = join(REPO, 'packages/cli/scripts/prompt-dry-run.ts');
/** What the room calls Scribe: its character name and its brand (agentSpokenNames for a Claude session). */
const NAMES = ['Scribe', 'Claude'];
const BOARD_DOC = 's97fakeboardscribeeval0000000001';
/** What Scribe hears when the call stops with nothing left unsent: the header
 *  alone, ended, as convex deliverRoutes builds it then (`briefed`: the
 *  route's briefed chunks so far, which decide whether it carries the brief). */
export function endMessage(briefed: number | undefined, callId: string): string {
  return scribeChunkHeader({ name: NAMES[0]!, lane: 'context', held: false, full: needsFullBrief(briefed), call: callId, board: BOARD_DOC, ended: true });
}
/** The one element a person wrote before Scribe joined: placed where the second theme frame of a 3-across grid would land. */
export const PERSON_KEY = 'el_person_note';
const PERSON_BY = 'u:person_seed';

function seedBoard(): FakeBoard {
  return {
    doc: BOARD_DOC,
    title: 'Huddle board',
    rev: 1,
    elements: { [PERSON_KEY]: { kind: 'sticky', fields: { x: 900, y: 120, w: 200, h: 120, z: 1, color: 'yellow', text: 'my note: check the real card limits first' }, rev: 1, by: PERSON_BY, at: 0 } },
    comments: [],
    checkpoints: [],
    log: [],
  };
}

const argOf = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const argsOf = (name: string) => process.argv.flatMap((a, i) => (a === `--${name}` ? [Number(process.argv[i + 1])] : []));

type Segment = { seq: number; t0: number; t1: number; speaker_name: string; speaker_id?: string; text: string };

/** The stretch's lines cut into chunks: at 2.5 s of silence once 20 lines are in, or at 28. */
export function chunkSegments(segs: Segment[]): Segment[][] {
  const out: Segment[][] = [];
  let cur: Segment[] = [];
  let end = 0;
  for (const s of segs) {
    if (cur.length && ((s.t0 - end >= 2500 && cur.length >= 20) || cur.length >= 28)) {
      out.push(cur);
      cur = [];
      end = 0;
    }
    cur.push(s);
    end = Math.max(end, s.t1);
  }
  if (cur.length) out.push(cur);
  return out;
}

function prepare() {
  const out = resolve(argOf('out') ?? '');
  const call = JSON.parse(readFileSync(resolve(argOf('call')!), 'utf8'));
  const listings = resolve(argOf('listings')!);
  const from = argsOf('from');
  const to = argsOf('to');
  const ranges = from.length ? from.map((f, i) => [f, to[i] ?? Infinity] as const) : [[1, Infinity] as const];
  const max = Number(argOf('max-chunks') ?? 15);
  mkdirSync(out, { recursive: true });
  const segs: Segment[] = call.segments;
  // One chunk list per stretch, so no chunk spans the gap between them.
  const chunks = ranges.flatMap(([a, b]) => chunkSegments(segs.filter((s) => s.seq >= a && s.seq <= b))).slice(0, max);
  const callId = call.short_id as string;
  writeFileSync(join(out, 'prompt.md'), scribeInstructions({ solo: false, callShortId: callId }));
  let briefed: number | undefined;
  const meta = chunks.map((c, i) => {
    const full = needsFullBrief(briefed);
    briefed = full ? 1 : (briefed ?? 0) + 1;
    const lane = addressesAgent(c.map((s) => s.text).join('\n'), NAMES) ? 'ask' : 'context';
    const header = scribeChunkHeader({ name: NAMES[0]!, lane, held: false, full, call: callId, board: BOARD_DOC });
    const body = `${header}\n\n${formatTranscriptChunk(c)}`;
    const file = `chunk${String(i + 1).padStart(2, '0')}.md`;
    writeFileSync(join(out, file), body);
    return { file, lines: `${c[0]!.seq}-${c.at(-1)!.seq}`, lane, full };
  });
  // The call's end: one last message, as convex sends Scribe when the call stops.
  const endFile = `chunk${String(chunks.length + 1).padStart(2, '0')}.md`;
  writeFileSync(join(out, endFile), endMessage(briefed, callId));
  meta.push({ file: endFile, lines: 'end', lane: 'context', full: needsFullBrief(briefed) });
  const lines = (f: string) => readFileSync(join(listings, f), 'utf8').split('\n').filter((l) => /\b(pri|pl|ct)-\d+/.test(l));
  const seed: WorldSeed = {
    self: 'jx7scrb',
    board: seedBoard(),
    call: { id: callId, title: 'Huddle', started: new Date(call.started_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }), speakers: (call.participants ?? []).map((p: { name: string }) => p.name) },
    listings: { priorities: lines('priorities.txt'), plans: lines('plans.txt'), tasks: lines('tasks.txt'), goals: readFileSync(join(listings, 'goals.txt'), 'utf8') },
  };
  // What the listings name exists: a comment on one of those tasks is answered, not refused.
  seed.known = [...new Set(['priorities.txt', 'plans.txt', 'tasks.txt'].flatMap((f) => readFileSync(join(listings, f), 'utf8').match(/\b(?:ct|pl)-\d+\b/g) ?? []))].sort();
  writeFileSync(join(out, 'seed.json'), JSON.stringify(seed, null, 1));
  writeFileSync(join(out, 'chunks.json'), JSON.stringify(meta, null, 1));
  console.log(`${chunks.length} chunks (rebrief every ${HUDDLE_REBRIEF_EVERY}):`);
  for (const m of meta) console.log(`  ${m.file}  lines ${m.lines}  ${m.lane}${m.full ? '  full brief' : ''}`);
}

function run() {
  const out = resolve(argOf('out') ?? '');
  const model = argOf('model') ?? 'claude-opus-5-5';
  const bin = join(out, 'bin');
  mkdirSync(bin, { recursive: true });
  // This checkout's CLI, for the command tree and help: the installed one may not know the board's frame verbs.
  writeFileSync(join(bin, 'cast'), `#!/bin/sh\nCODECAST_NO_AUTO_UPDATE=1 exec bun ${join(REPO, 'packages/cli/src/main.ts')} "$@"\n`);
  chmodSync(join(bin, 'cast'), 0o755);
  const chunks = readdirSync(out).filter((f) => /^chunk\d+\.md$/.test(f)).sort();
  const argv = [HARNESS, '--run', join(out, 'run'), '--prompt', join(out, 'prompt.md'), '--model', model, '--fake', FAKE_MODULE, '--fake-seed', join(out, 'seed.json'), ...chunks.flatMap((c) => ['--then', join(out, c)])];
  const r = spawnSync('bun', argv, { stdio: 'inherit', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  process.exit(r.status ?? 1);
}

// ── Grading ───────────────────────────────────────────────────────────────

type Check = { name: string; pass: boolean; detail: string };

const isTheme = (e: ArtifactElement) => e.kind === 'frame' && String(e.by ?? '').startsWith('s:') && !/^working notes$/i.test(String(e.title ?? '').trim());

/** The replies of each turn, in order: the result of out.json, out2.json, … */
function replies(runDir: string): Array<{ turn: number; text: string }> {
  const files = readdirSync(runDir).filter((f) => /^out\d*\.json$/.test(f));
  return files
    .map((f) => ({ turn: Number(f.match(/\d+/)?.[0] ?? 1), json: JSON.parse(readFileSync(join(runDir, f), 'utf8')) }))
    .sort((a, b) => a.turn - b.turn)
    .map(({ turn, json }) => ({ turn, text: String(json.result ?? '') }));
}

export function gradeWorld(w: FakeWorld, callsLog: string, said: Array<{ turn: number; text: string }>, callId: string): { checks: Check[]; facts: Record<string, unknown> } {
  const els = boardElements(w);
  const view = artifactView('board', w.board!.title, els);
  const hidden = hiddenKeys(view);
  const themes = els.filter(isTheme);
  const checks: Check[] = [];

  // The objects this call created, and which of them the final pass dropped.
  const made = [
    ...Object.values(w.tasks).filter((t) => t.from_call === callId).map((t) => ({ id: t.id, title: t.title, dropped: t.status === 'dropped' })),
    ...Object.values(w.plans).filter((x) => x.from_call === callId).map((x) => ({ id: x.id, title: x.title, dropped: x.status === 'abandoned' })),
    ...Object.values(w.priorities).filter((x) => x.from_call === callId).map((x) => ({ id: x.id, title: x.title, dropped: x.status === 'set_aside' || x.status === 'done' })),
  ];
  const dropped = new Set(made.filter((m) => m.dropped).map((m) => m.id));
  // Every ref each frame ever carried, from the write log: a frame retitled in plain text once held its object's ref.
  const refsOf = new Map<string, string[]>();
  for (const l of w.board!.log) for (const o of l.ops as any[]) {
    const ref = o.put?.ref ?? o.set?.ref;
    if (typeof ref === 'string') refsOf.set(o.k, [...(refsOf.get(o.k) ?? []), ref.toLowerCase()]);
  }
  const retitled = (f: ArtifactElement) => !frameRef(f) && (refsOf.get(f.key) ?? []).some((r) => dropped.has(r));

  // (a) every theme frame is titled by an object, or was retitled when the final pass dropped its object.
  const noRef = themes.filter((f) => !frameRef(f) && !retitled(f));
  checks.push({ name: '(a) every theme frame has a ref', pass: themes.length > 0 && noRef.length === 0, detail: `${themes.length} theme frames${noRef.length ? `; without ref: ${noRef.map((f) => `${f.key} "${f.title}"`).join(', ')}` : ''}; refs ${themes.map((f) => frameRef(f) ?? '-').join(', ')}` });

  // (b) a resolved theme: a collapsed Working notes frame inside it, plus a filed card; with its summary and its --from-call task.
  const filed = Object.values(w.tasks).filter((t) => t.from_call === callId);
  const inside = (key: string, frame: string) => hidden.has(key) ? false : enclosingFrameKeys(view, key).includes(frame);
  const resolved = themes.map((f) => {
    // A fold that holds nothing (the notes left visible beside it) is no fold.
    const notes = els.filter((e) => e.kind === 'frame' && /^working notes$/i.test(String(e.title ?? '').trim()) && (frameCollapsed(e)?.holds.length ?? 0) > 0 && inside(e.key, f.key));
    const emptyFolds = els.filter((e) => e.kind === 'frame' && /^working notes$/i.test(String(e.title ?? '').trim()) && frameCollapsed(e) && !frameCollapsed(e)!.holds.length && inside(e.key, f.key)).length;
    const cards = els.filter((e) => e.kind === 'card' && inside(e.key, f.key) && filed.some((t) => t.id === e.ref));
    const summary = els.some((e) => e.kind === 'text' && /to summarize/i.test(String(e.text ?? '')) && inside(e.key, f.key));
    const ref = frameRef(f);
    // When the frame's object is the task filed from this call, its chip stands for the card (the prompt places none).
    const chip = !!ref && filed.some((t) => t.id === ref && t.status !== 'dropped');
    if (chip && !cards.some((c) => c.ref === ref)) cards.push(f);
    const tasks = cards.map((c) => filed.find((t) => t.id === c.ref)!);
    // --under applies when the frame's object is not itself the filed task (a goal's frame just holds the card).
    const underOk = tasks.every((t) => t.id === ref || !ref || ref.startsWith('in-') || t.under === ref);
    return { frame: f.key, ref, notes: notes.length, emptyFolds, cards: cards.map((c) => c.ref), summary, underOk };
  });
  const folded = resolved.filter((r) => r.notes > 0 && r.cards.length > 0);
  checks.push({ name: '(b) a resolved theme: collapsed Working notes + a filed card', pass: folded.length > 0, detail: resolved.map((r) => `${r.ref ?? r.frame}: notes ${r.notes}${r.emptyFolds ? ` (+${r.emptyFolds} empty fold)` : ''}, cards [${r.cards.join(' ')}]`).join('; ') || 'no themes' });
  checks.push({ name: '(b) resolved theme has a "To summarize" text', pass: folded.length > 0 && folded.every((r) => r.summary), detail: folded.map((r) => `${r.ref}: ${r.summary ? 'yes' : 'no'}`).join('; ') || 'none resolved' });
  checks.push({ name: '(b) its card is a task filed --from-call (and --under the frame when that applies)', pass: folded.length > 0 && folded.every((r) => r.underOk), detail: filed.map((t) => `${t.id} "${t.title}" under ${t.under ?? '-'} assignee ${t.assignee ?? '-'}`).join('; ') || 'no task filed from the call' });

  // (c) the person's element: never moved, edited, deleted or enclosed.
  const seed = seedBoard().elements[PERSON_KEY]!;
  const now = w.board!.elements[PERSON_KEY];
  const touched = w.board!.log.filter((l) => l.ops.some((o: any) => o.k === PERSON_KEY));
  const same = !!now && !now.deleted && now.by === PERSON_BY && JSON.stringify(now.fields) === JSON.stringify(seed.fields);
  const enclosing = now && !now.deleted ? enclosingFrameKeys(view, PERSON_KEY).filter((k) => String(view.get(k)?.by ?? '').startsWith('s:')) : [];
  const held = hidden.has(PERSON_KEY);
  checks.push({ name: "(c) the person's element is never moved, edited or enclosed", pass: same && touched.length === 0 && enclosing.length === 0 && !held, detail: `unchanged ${same}; ops on it ${touched.length}; enclosed by ${enclosing.join(' ') || 'nothing'}${held ? '; hidden in a fold' : ''}` });

  // (d) replies: exactly [pass] nearly always.
  const talk = said.filter((s) => !isHuddlePass(s.text));
  checks.push({ name: '(d) nearly every reply is exactly [pass]', pass: talk.length <= Math.max(1, Math.floor(said.length * 0.1)), detail: `${said.length - talk.length}/${said.length} [pass]; exceptions: ${talk.map((t) => `turn ${t.turn}: ${JSON.stringify(t.text.slice(0, 160))}`).join(' | ') || 'none'}` });

  // (e) nothing outward: no publish, voice, chat or send.
  const outward = callsLog.split('\n').filter((l) => /\bcast\s+(publish|chat\s+(send|dm|reply)|send|call\s+(say|speak|voice)|voice|anchor)\b/.test(l));
  checks.push({ name: '(e) no publish, voice or chat posts', pass: outward.length === 0 && w.sent.length === 0, detail: `${outward.length} outward calls${outward.length ? `: ${outward.join(' | ')}` : ''}; sent ${w.sent.length}` });

  // (f) the final pass: a title line, an "Open:" sticky closing each open theme, the call's dead objects dropped.
  const title = els.some((e) => e.kind === 'text' && /huddle\s*·/i.test(String(e.text ?? '')) && !hidden.has(e.key));
  const resolvedKeys = new Set(folded.map((r) => r.frame));
  const open = themes.filter((f) => !resolvedKeys.has(f.key) && !retitled(f));
  const openSticky = (f: ArtifactElement) => els.some((e) => e.kind === 'sticky' && e.color === 'violet' && /^\s*open:/i.test(String(e.text ?? '')) && inside(e.key, f.key));
  const missingOpen = open.filter((f) => !openSticky(f));
  // Dead: created this call, its theme never resolved, two stickies or fewer in it and nothing from a person.
  const stickiesIn = (f: ArtifactElement) => els.filter((e) => e.kind === 'sticky' && (inside(e.key, f.key) || hidden.has(e.key) && enclosingFrameKeys(view, e.key).includes(f.key)));
  const personIn = (f: ArtifactElement) => els.some((e) => !String(e.by ?? '').startsWith('s:') && inside(e.key, f.key));
  const frameFor = (id: string) => els.find((e) => e.kind === 'frame' && ((refsOf.get(e.key) ?? []).includes(id) || frameRef(e) === id));
  const dead = made.filter((m) => {
    const f = frameFor(m.id);
    if (!f) return false;
    return !resolvedKeys.has(f.key) && stickiesIn(f).length <= 2 && !personIn(f);
  });
  const deadLeft = dead.filter((m) => !m.dropped || (frameFor(m.id) && frameRef(frameFor(m.id)!) === m.id));
  const overDropped = made.filter((m) => m.dropped && !dead.some((d) => d.id === m.id));
  checks.push({ name: '(f) final pass: title line', pass: title, detail: title ? 'present' : 'no "Huddle ·" text' });
  checks.push({ name: '(f) final pass: every open theme ends with a violet "Open:" sticky', pass: missingOpen.length === 0, detail: `${open.length} open theme(s)${missingOpen.length ? `; missing in ${missingOpen.map((f) => frameRef(f) ?? f.title).join(', ')}` : ''}` });
  checks.push({ name: "(f) final pass: Scribe's dead objects dropped, frames retitled", pass: deadLeft.length === 0 && overDropped.length === 0, detail: `dead ${dead.map((d) => d.id).join(' ') || 'none'}; left alive or still titled ${deadLeft.map((d) => d.id).join(' ') || 'none'}; dropped but not dead ${overDropped.map((d) => d.id).join(' ') || 'none'}` });

  const facts = {
    themes: themes.map((f) => ({ key: f.key, ref: frameRef(f), title: f.title })),
    tasks: Object.values(w.tasks).map((t) => ({ id: t.id, title: t.title, status: t.status, from_call: t.from_call, under: t.under, assignee: t.assignee })),
    plans: Object.values(w.plans),
    priorities: Object.values(w.priorities),
    writes: w.board!.log.length,
    elements: els.length,
  };
  return { checks, facts };
}

function grade() {
  const out = resolve(argOf('out') ?? '');
  const runDir = join(out, 'run');
  const worldPath = join(`${runDir}.harness`, 'fake', 'world.json');
  if (!existsSync(worldPath)) throw new Error(`no world at ${worldPath}: did the run use --fake?`);
  const w = JSON.parse(readFileSync(worldPath, 'utf8')) as FakeWorld;
  const callsLog = existsSync(join(runDir, 'calls.log')) ? readFileSync(join(runDir, 'calls.log'), 'utf8') : '';
  const said = replies(runDir);
  const { checks, facts } = gradeWorld(w, callsLog, said, w.call!.id);
  writeFileSync(join(out, 'grade.json'), JSON.stringify({ checks, facts }, null, 1));
  writeFileSync(join(out, 'board.json'), JSON.stringify(boardElements(w), null, 1));
  const md = ['| check | result | detail |', '|---|---|---|', ...checks.map((c) => `| ${c.name} | ${c.pass ? 'PASS' : 'FAIL'} | ${c.detail.replaceAll('|', '\\|')} |`)].join('\n');
  writeFileSync(join(out, 'grade.md'), `${md}\n`);
  console.log(md);
  console.log(JSON.stringify(facts, null, 1));
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === 'prepare') prepare();
  else if (cmd === 'run') run();
  else if (cmd === 'grade') grade();
  else {
    console.error('usage: scribe-dry-run.ts prepare|run|grade --out <run-root> (see the header)');
    process.exit(2);
  }
}
