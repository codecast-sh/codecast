// Pure renderers for the run views: the list, one run, its story, its
// events, its score, two runs against each other, one scenario over time.

import { hr, padEnd, renderFields, renderNext, renderTable, truncate, wrapText, type Palette, type RenderOpts } from '@platform/cli-kit/render';
import { formatCost, formatDayOffset, formatDuration, formatVirtual, shortId } from '@platform/cli-kit/format';
import { relativeTime } from '@platform/cli-kit/text';

import type { RunDetail, RunEvent, RunSummary, Score } from '../model';
import { bar, makePalette, messageBody, messageHead, nameOf, verdictWord, voices } from './common';
import { age } from './freeze';
import { renderParticipants, windowMessages, type ConversationViewOpts } from './convo';

const statusStyle = (p: Palette, s: RunSummary['status']) => (s === 'pass' ? p.green : s === 'fail' ? p.red : s === 'crash' ? (x: string) => p.bold(p.red(x)) : s === 'running' ? p.cyan : p.dim);

export function renderRunList(rows: RunSummary[], o: RenderOpts & { cli?: string; title?: string }): string {
  const p = makePalette(o.color);
  const cli = o.cli ?? 'xrun';
  const passed = rows.filter((r) => r.status === 'pass').length;
  const lines = [`${p.bold(p.cyan(o.title ?? 'Runs'))}  ${p.dim(`${rows.length} runs, newest first · ${passed} passed · ${formatCost(rows.reduce((n, r) => n + r.costUsd, 0))}`)}`, ''];
  if (!rows.length) lines.push(p.dim('  no runs yet'));
  lines.push(
    ...renderTable(
      rows,
      [
        { header: 'run', width: 44, value: (r) => r.id, style: () => p.dim },
        { header: 'age', width: 5, align: 'right', value: (r) => relativeTime(Date.parse(r.createdAt)) },
        { header: 'verdict', width: 10, value: (r) => (r.status === 'pass' || r.status === 'fail' ? `${r.status.toUpperCase()} ${r.score!.toFixed(2)}` : r.status), style: (r) => statusStyle(p, r.status) },
        { header: 'sends', width: 5, align: 'right', value: (r) => String(r.sends) },
        { header: 'virt', width: 5, align: 'right', value: (r) => (r.virtualMs ? formatVirtual(r.virtualMs) : '') },
        { header: 'real', width: 5, align: 'right', value: (r) => (r.realMs ? formatDuration(r.realMs) : '') },
        { header: 'cost', width: 7, align: 'right', value: (r) => formatCost(r.costUsd) },
        { header: 'why', value: (r) => [...r.gatesFailed.map((g) => `gate ${g}`), ...r.missedFloors.map((f) => `floor ${f}`), r.notes ?? ''].filter(Boolean).join('; ') || (r.status === 'pass' ? r.title : ''), style: (r) => (r.gatesFailed.length || r.missedFloors.length ? p.red : p.dim) },
      ],
      p,
      o.width,
    ),
  );
  lines.push('');
  const first = rows[0];
  lines.push(
    ...renderNext(
      [
        [`${cli} runs show ${first ? first.id : '<run>'}`, 'one run: the story, the score, the sends'],
        [`${cli} runs list --scenario ${first?.scenario ?? '<scenario>'} -n 20`, 'one scenario over time'],
        [`${cli} runs html ${first ? first.id : '<run>'} --open`, 'the page'],
      ],
      p,
    ),
  );
  return lines.join('\n');
}

export function renderScore(score: Score | null, o: RenderOpts, summaryOnly = false): string[] {
  const p = makePalette(o.color);
  if (!score) return [p.dim('unscored: no score.json was written')];
  const lines: string[] = [];
  lines.push(`${verdictWord(score.pass, score.score, p)}  ${p.dim(`pass mark ${score.passMark.toFixed(2)}${score.judgeModel ? ` · judge ${score.judgeModel}` : ''}${score.judgeCostUsd ? ` ${formatCost(score.judgeCostUsd)}` : ''}`)}`);
  const failed = score.gates.filter((g) => !g.pass);
  if (failed.length) lines.push(p.red(`zero, because a gate failed: ${failed.map((g) => g.id).join(', ')}`));
  for (const f of score.missedFloors ?? []) lines.push(p.red(`failed on a floor: ${f.id} scored ${f.score.toFixed(2)} under ${f.must.toFixed(2)}`));
  if (summaryOnly) return lines;
  lines.push('', p.dim('gates, decided in code'));
  for (const g of score.gates) {
    const mark = g.pass ? (g.evidence.vacuous ? p.dim('held·') : p.green('held ')) : p.red('FAIL ');
    lines.push(`  ${mark} ${padEnd(g.id, 30)} ${p.dim(truncate(g.evidence.summary.replace(/\s+/g, ' '), Math.max(20, o.width - 40)))}`);
    if (!g.pass || o.full) {
      for (const ex of g.evidence.excerpts ?? []) lines.push(`         ${p.dim(ex.where)}`, ...wrapText(ex.text, o.width - 12).map((l) => `           ${p.dim('>')} ${l}`));
      for (const s of g.evidence.sends ?? []) lines.push(`         ${p.dim(`send #${s.seq} to ${s.to ?? '?'}`)}`, ...wrapText(s.text, o.width - 12).map((l) => `           ${p.dim('>')} ${l}`));
    }
  }
  if (score.checks.length) {
    lines.push('', p.dim('judged checks'));
    for (const c of score.checks) {
      const floor = c.must != null ? p.dim(` floor ${c.must.toFixed(2)}`) : '';
      lines.push(`  ${bar(c.score, 10, p)} ${c.score.toFixed(2)}  ${padEnd(c.id, 28)} ${p.dim(`×${c.weight}`)}${floor}`);
      if (c.reasoning) lines.push(...wrapText(c.reasoning, o.width - 8).map((l) => `        ${p.dim(l)}`));
      if (o.full && c.evidence) lines.push(...wrapText(c.evidence, o.width - 10).map((l) => `          ${p.dim('>')} ${l}`));
    }
  }
  if (score.perParticipant && Object.keys(score.perParticipant).length) {
    lines.push('', p.dim('per side'));
    for (const [who, v] of Object.entries(score.perParticipant)) lines.push(`  ${bar(v.score, 10, p)} ${v.score.toFixed(2)}  ${who}${v.reasoning ? `  ${p.dim(truncate(v.reasoning, o.width - 30))}` : ''}`);
  }
  return lines;
}

export function renderRunHeader(r: RunDetail, o: RenderOpts): string[] {
  const p = makePalette(o.color);
  const lines = [`${p.bold(p.cyan(r.title))}  ${p.dim(`${r.scenario} · seed ${r.seed} · ${r.id}`)}`];
  if (r.hunts) lines.push(p.dim(`hunts: ${r.hunts}`));
  if (r.freezeId) lines.push(p.dim(`replay of freeze ${shortId(r.freezeId)}${r.notes ? ` · ${r.notes}` : ''}${r.model ? ` · ${r.model}` : ''}`));
  const c = r.counters;
  lines.push(
    ...renderFields(
      [
        ['ran', `${age(r.createdAt)}${c ? `, ${formatDuration(c.realElapsedMs)} real for ${formatVirtual(c.virtualElapsedMs)} virtual` : ''}`],
        ['ended', c ? `${c.endedBecause ?? '?'}${c.stopReason ? ` (${c.stopReason})` : ''}` : r.status],
        ['work', c ? `${c.steps ?? 0} steps · ${c.runsExecuted ?? 0} runs · ${c.ticks ?? 0} ticks · ${c.shifts ?? 0} shifts moving ${c.rowsShifted ?? 0} rows` : ''],
        ['said', `${r.sendsList.length} sends · ${r.messages.filter((m) => m.direction === 'in').length} inbound · ${r.blocked.length} blocked`],
        ['cost', `${formatCost(c?.costUsd ?? 0)} model${r.verdict?.judgeCostUsd ? ` + ${formatCost(r.verdict.judgeCostUsd)} judge` : ''}`],
      ],
      p,
    ),
  );
  return lines;
}

export function renderRun(r: RunDetail, o: ConversationViewOpts): string {
  const p = makePalette(o.color);
  const cli = o.cli ?? 'xrun';
  const lines = [...renderRunHeader(r, o), ''];
  if (r.error) lines.push(p.red('crashed:'), ...r.error.split('\n').map((l) => `  ${p.red(l)}`), '');
  lines.push(p.dim('who'), ...renderParticipants(r.participants, p), '');
  lines.push(p.dim('score'), ...renderScore(r.verdict, o, !o.full).map((l) => `  ${l}`), '');
  lines.push(p.dim('the story, both sides, in virtual time'));
  lines.push(...renderStory(r, { ...o, last: o.last ?? (o.full ? undefined : 30), system: o.system ?? true }).split('\n').map((l) => (l ? `  ${l}` : l)));
  if (r.captures.length) {
    lines.push(p.dim('what the boundary caught'));
    for (const cpt of r.captures) lines.push(`  ${padEnd(cpt.label, 20)} ${cpt.count}`);
    lines.push('');
  }
  if (r.evidenceDir) lines.push(p.dim(`evidence ${r.evidenceDir}`), '');
  lines.push(
    ...renderNext(
      [
        [`${cli} runs story ${r.id} --full`, 'every message, untruncated'],
        [`${cli} runs score ${r.id} --full`, 'every gate with its evidence'],
        [`${cli} runs events ${r.id}`, "the driver's event log"],
        [`${cli} runs html ${r.id} --open`, 'the page'],
      ],
      p,
    ),
  );
  return lines.join('\n');
}

export function renderStory(r: RunDetail, o: ConversationViewOpts): string {
  const p = makePalette(o.color);
  const voice = voices(r.participants, p);
  const { shown, hiddenBefore, hiddenAfter } = windowMessages(r.messages, { ...o, system: o.system ?? true });
  const lines: string[] = [];
  if (hiddenBefore) lines.push(p.dim(`… ${hiddenBefore} earlier (--from 1 --to ${shown[0]?.n ?? 1})`), '');
  for (const m of shown) {
    lines.push(messageHead(m, r.participants, p, voice, { start: r.startedAt || null }));
    lines.push(...messageBody(m, o.width, o.full ? undefined : (o.lines ?? 6), p));
    lines.push('');
  }
  if (!shown.length) lines.push(p.dim('nothing was said'), '');
  if (hiddenAfter) lines.push(p.dim(`… ${hiddenAfter} later`), '');
  return lines.join('\n');
}

const KIND_STYLE = (p: Palette, kind: string, q: Record<string, unknown>) => {
  if (kind === 'boundary_blocked' || kind === 'job_failed') return (s: string) => p.bold(p.red(s));
  if (kind === 'send_captured') return p.green;
  if (kind === 'inbound_injected') return p.cyan;
  if (kind === 'persona_replied' || kind === 'persona_scheduled') return p.magenta;
  if (kind === 'persona_silent') return p.dim;
  if (kind === 'gate') return q.pass ? p.green : p.red;
  if (kind === 'time_advanced' || kind === 'maintenance_tick') return p.dim;
  return (s: string) => s;
};

const short = (v: unknown, max: number): string => truncate((typeof v === 'string' ? v : JSON.stringify(v) ?? '').replace(/\s+/g, ' '), max);

export function describeEvent(e: RunEvent, width: number): string {
  const q = e.payload;
  switch (e.kind) {
    case 'run_started':
      return `run started · ${q.scenario} seed ${q.seed}${q.horizonHours ? ` · horizon ${q.horizonHours}h` : ''}`;
    case 'run_finished':
      return `run finished · ${q.endedBecause}${q.stopReason ? ` (${q.stopReason})` : ''} · ${q.steps} steps`;
    case 'time_advanced':
      return `advanced ${q.byMs ? `${(Number(q.byMs) / 60_000).toFixed(0)} min` : ''}${q.rowsShifted != null ? ` · ${q.rowsShifted} rows` : ''}`;
    case 'inbound_injected':
      return `in from ${q.from}${q.identity ? ` (${q.identity})` : ''}: ${short(q.text, width - 40)}`;
    case 'send_captured': {
      const d = (q.detail ?? {}) as Record<string, unknown>;
      return `out ${q.label ?? ''} → ${d.to ?? d.channel ?? '?'}: ${short(d.text ?? '(unreadable)', width - 40)}`;
    }
    case 'persona_scheduled':
      return `${q.persona} will answer in ${Number(q.delayHours ?? 0).toFixed(1)}h · ${q.reason ?? ''}`;
    case 'persona_replied':
      return `${q.persona} answered · ${short(q.text, width - 40)}`;
    case 'persona_silent':
      return `${q.persona} stays silent · ${q.reason ?? ''}`;
    case 'scenario_step':
      return `beat · ${q.label}`;
    case 'job_executed':
      return `run ${shortId(String(q.runId ?? ''))} executed${q.realMs ? ` · ${formatDuration(Number(q.realMs))}` : ''}`;
    case 'job_failed':
      return `run ${shortId(String(q.runId ?? ''))} FAILED · ${short(q.error, width - 30)}`;
    case 'maintenance_tick':
      return `tick${Array.isArray(q.failed) && q.failed.length ? ` · failed ${JSON.stringify(q.failed)}` : ''}`;
    case 'boundary_blocked':
      return `BLOCKED ${q.method} ${q.url ?? q.host}`;
    case 'gate':
      return `gate ${q.id} ${q.pass ? 'held' : 'FAILED'} · ${short(q.evidence, width - 40)}`;
    case 'judge_call':
      return `judge ${q.judge ?? ''} · ${q.checks} checks · ${formatCost(Number(q.costUsd ?? 0))}`;
    case 'note':
      return `note · ${short(q.text, width - 20)}`;
    case 'roster':
      return `roster · ${Array.isArray(q.personas) ? q.personas.length : 0} personas`;
    default:
      return `${e.kind} ${short(q, width - 30)}`;
  }
}

export function renderEventLine(e: RunEvent, start: string | null, p: Palette, width: number): string {
  const when = start ? formatDayOffset(e.virtualAt, start) : e.virtualAt.slice(5, 16).replace('T', ' ');
  return `${p.dim(String(e.seq).padStart(5))} ${p.dim(when)} ${KIND_STYLE(p, e.kind, e.payload)(describeEvent(e, width))}`;
}

export function renderEvents(r: RunDetail, o: RenderOpts & { kinds?: string[]; last?: number; cli?: string }): string {
  const p = makePalette(o.color);
  const cli = o.cli ?? 'xrun';
  let rows = r.events.filter((e) => e.kind !== 'time_advanced' || o.full);
  if (o.kinds?.length) rows = rows.filter((e) => o.kinds!.includes(e.kind));
  const hidden = o.last && rows.length > o.last ? rows.length - o.last : 0;
  if (hidden) rows = rows.slice(-o.last!);
  const counts = new Map<string, number>();
  for (const e of r.events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const lines = [`${p.bold(p.cyan('Events'))} ${p.dim(r.id)}  ${p.dim([...counts.entries()].map(([k, n]) => `${k} ${n}`).join(' · '))}`, ''];
  if (hidden) lines.push(p.dim(`… ${hidden} earlier (--last ${rows.length + hidden})`));
  for (const e of rows) lines.push(renderEventLine(e, r.startedAt || null, p, o.width));
  lines.push('', ...renderNext([[`${cli} runs events ${r.id} --kind send_captured,inbound_injected`, 'only what was said'], [`${cli} runs events ${r.id} --full`, 'with every time advance']], p));
  return lines.join('\n');
}

export function renderRunDiff(a: RunDetail, b: RunDetail, o: RenderOpts & { cli?: string }): string {
  const p = makePalette(o.color);
  const lines = [`${p.bold(p.cyan('Diff'))}  ${p.dim(`${a.id}  vs  ${b.id}`)}`, ''];
  const half = Math.floor((o.width - 3) / 2);
  const col = (r: RunDetail): string[] => {
    const out = [`${p.bold(r.id.slice(0, half))}`, verdictWord(r.verdict?.pass ?? null, r.verdict?.score ?? null, p), ...(r.notes ? [p.dim(truncate(r.notes, half))] : []), ''];
    for (const g of r.verdict?.gates ?? []) out.push(`${g.pass ? p.green('held') : p.red('FAIL')} ${truncate(g.id, half - 5)}`);
    out.push('');
    for (const c of r.verdict?.checks ?? []) out.push(`${bar(c.score, 6, p)} ${c.score.toFixed(2)} ${truncate(c.id, half - 12)}`);
    out.push('');
    for (const m of r.messages.filter((x) => x.direction === 'out')) {
      out.push(p.dim(`→ ${m.to ? nameOf(r.participants, m.to) : '?'} ${formatDayOffset(m.at, r.startedAt)}`));
      out.push(...wrapText(m.text, half).map((l) => l));
      out.push('');
    }
    return out;
  };
  const left = col(a);
  const right = col(b);
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i++) lines.push(`${padEnd(left[i] ?? '', half)} ${p.dim('│')} ${right[i] ?? ''}`);
  const word = (pass: boolean) => (pass ? 'held' : 'failed');
  const flips = diffRuns(a, b).map((d) => (d.kind === 'gate' ? `${d.id}: ${word(d.before)} → ${word(d.after)}` : `${d.id}: ${d.before.toFixed(2)} → ${d.after.toFixed(2)}`));
  lines.push('', p.dim('what moved'), ...(flips.length ? flips.map((f) => `  ${f}`) : [p.dim(`  nothing by ${CHECK_MOVE} or a gate`)]));
  return lines.join('\n');
}

/** How far a check's score must move between two runs to count as a move. */
export const CHECK_MOVE = 0.2;

/** One thing that moved between two runs: a gate that flipped, or a check that moved by CHECK_MOVE or more. */
export type RunDiffEntry =
  | { kind: 'gate'; id: string; before: boolean; after: boolean }
  | { kind: 'check'; id: string; before: number; after: number };

/** The part of a run diffRuns reads; a RunDetail fits, and so does a bare `{ verdict: score.json }`. */
export interface DiffableRun {
  verdict?: { gates?: ReadonlyArray<{ id: string; pass: boolean }>; checks?: ReadonlyArray<{ id: string; score: number }> } | null;
}

/** What moved from run a to run b, in b's order: gates first, then checks. Ids on only one side are not moves. */
export function diffRuns(a: DiffableRun, b: DiffableRun): RunDiffEntry[] {
  const out: RunDiffEntry[] = [];
  const ga = new Map((a.verdict?.gates ?? []).map((g) => [g.id, g.pass]));
  for (const g of b.verdict?.gates ?? []) {
    const before = ga.get(g.id);
    if (before !== undefined && before !== g.pass) out.push({ kind: 'gate', id: g.id, before, after: g.pass });
  }
  const ca = new Map((a.verdict?.checks ?? []).map((c) => [c.id, c.score]));
  for (const c of b.verdict?.checks ?? []) {
    const before = ca.get(c.id);
    if (before !== undefined && Math.abs(before - c.score) >= CHECK_MOVE) out.push({ kind: 'check', id: c.id, before, after: c.score });
  }
  return out;
}

/** One scenario over time: a pass strip and the rows behind it. */
export function renderHistory(rows: RunSummary[], scenario: string, o: RenderOpts & { cli?: string }): string {
  const p = makePalette(o.color);
  const strip = [...rows].reverse().map((r) => (r.status === 'pass' ? p.green('✓') : r.status === 'fail' ? p.red('✗') : r.status === 'crash' ? p.yellow('!') : p.dim('·'))).join('');
  const lines = [`${p.bold(p.cyan(scenario))}  ${p.dim(`${rows.length} runs, oldest → newest`)}  ${strip}`, ''];
  lines.push(...renderRunList(rows, { ...o, title: `Runs of ${scenario}` }).split('\n').slice(2));
  return lines.join('\n');
}

export { hr };
