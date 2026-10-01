// One run on a page: who was in it, when everybody spoke, the story, the
// rooms, why the score is what it is, what the boundary caught, the event
// log, and the assistant's own runs with their tool calls.

import type { RunDetail, RunEvent, Score } from '../model';
import { bar, clock, dayOffset, esc, hours, money, secs, shell, statGrid, verdictPill } from './page';
import { lanesOf, messageCounts, renderCast, renderChips, renderFeed, renderRooms, renderStrip } from './story';

export function renderScoreSection(score: Score | null, status: string, error?: string | null): string {
  if (!score) {
    return `<div class="card"><p>${status === 'crash' ? 'No score was written: the run died before it could be judged.' : status === 'running' ? 'Not scored yet.' : 'This run was never scored.'}</p>${error ? `<div class="log">${esc(error)}</div>` : ''}</div>`;
  }
  const out: string[] = [];
  const failed = score.gates.filter((g) => !g.pass);
  if (failed.length) out.push(`<div class="card gate bad"><strong>Zero, because a gate failed.</strong> ${failed.map((g) => `<code class="mono">${esc(g.id)}</code>`).join(', ')}. A gate is a thing that would lose somebody's trust, so nothing elsewhere buys one back.</div>`);
  for (const f of score.missedFloors ?? []) out.push(`<div class="card gate bad"><strong>Failed on a floor.</strong> <code class="mono">${esc(f.id)}</code> is what this scenario hunts and it scored ${f.score.toFixed(2)}, under ${f.must.toFixed(2)}.</div>`);
  out.push('<p class="lede">Gates are decided in code on structural evidence and never ask a model. Any one failing scores the run zero. The judged checks are the half that needs reading.</p>');
  for (const g of score.gates) {
    const items = (g.evidence.excerpts?.length ?? 0) + (g.evidence.sends?.length ?? 0) + (g.evidence.rows?.length ?? 0);
    const evidence = items
      ? `<details><summary>the evidence (${items} items${g.evidence.scanned !== undefined ? `, ${g.evidence.scanned} scanned` : ''})</summary>${(g.evidence.excerpts ?? []).map((e) => `<div class="mono" style="font-size:12px;color:var(--faint)">${esc(e.where)}</div><blockquote>${esc(e.text)}</blockquote>`).join('')}${(g.evidence.sends ?? []).map((s) => `<div class="mono" style="font-size:12px;color:var(--faint)">#${s.seq} to ${esc(s.to)}</div><blockquote>${esc(s.text)}</blockquote>`).join('')}${(g.evidence.rows ?? []).map((r) => `<pre>${esc(r.table)}: ${esc(JSON.stringify(r.row))}</pre>`).join('')}</details>`
      : '';
    out.push(`<div class="card gate ${g.pass ? (g.evidence.vacuous ? 'vac' : '') : 'bad'}"><div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap"><span class="verdict v-${g.pass ? 'pass' : 'fail'}">${g.pass ? (g.evidence.vacuous ? 'HELD, NOTHING TO CHECK' : 'HELD') : 'FAILED'}</span><code class="mono">${esc(g.id)}</code>${g.decidedBy ? `<span class="tag">${esc(g.decidedBy)}</span>` : ''}</div>${g.title ? `<p style="margin:8px 0 4px"><strong>${esc(g.title)}</strong></p>` : ''}<p style="color:var(--dim);margin:0">${esc(g.evidence.summary)}</p>${evidence}</div>`);
  }
  if (score.checks.length) {
    out.push('<table style="margin-top:18px"><thead><tr><th>Judged check</th><th>What the judge said</th><th class="num">Weight</th><th class="num">Score</th></tr></thead><tbody>');
    for (const c of score.checks) {
      out.push(`<tr><td><code class="mono">${esc(c.id)}</code>${c.must != null ? `<span class="tag" style="margin-left:6px">floor ${c.must.toFixed(2)}</span>` : ''}${c.ask ? `<div style="color:var(--faint);font-size:12.5px;margin-top:3px">${esc(c.ask)}</div>` : ''}</td><td style="color:var(--dim);font-size:13.5px">${esc(c.reasoning ?? '')}${c.evidence ? `<blockquote>${esc(c.evidence)}</blockquote>` : ''}</td><td class="num">${c.weight}</td><td class="num">${bar(c.score)} ${c.score.toFixed(2)}</td></tr>`);
    }
    out.push('</tbody></table>');
  }
  if (score.perParticipant && Object.keys(score.perParticipant).length) {
    out.push(`<div class="side" style="margin-top:14px">${Object.entries(score.perParticipant).map(([who, v]) => `<div class="card"><div style="display:flex;gap:10px;align-items:center"><strong>${esc(who)}</strong><span class="mono" style="margin-left:auto">${bar(v.score)} ${v.score.toFixed(2)}</span></div><p style="color:var(--dim);font-size:13.5px;margin:8px 0 0">${esc(v.reasoning ?? '')}</p></div>`).join('')}</div>`);
  }
  return out.join('\n');
}

const summarize = (e: RunEvent): string => {
  const q = e.payload;
  const parts: string[] = [];
  for (const key of ['label', 'from', 'to', 'persona', 'reason', 'text', 'error', 'runId', 'host', 'url', 'id', 'evidence', 'scenario']) {
    const v = q[key];
    if (typeof v === 'string' && v) parts.push(`${key}=${v.slice(0, 90)}`);
    if (typeof v === 'number') parts.push(`${key}=${v}`);
  }
  if (q.detail && typeof q.detail === 'object') {
    const d = q.detail as Record<string, unknown>;
    if (typeof d.to === 'string') parts.push(`to=${d.to}`);
    if (typeof d.text === 'string') parts.push(`text=${d.text.slice(0, 90)}`);
  }
  return parts.join('  ') || (JSON.stringify(q) === '{}' ? '' : JSON.stringify(q).slice(0, 160));
};

export function renderEventsSection(events: RunEvent[], start: string): string {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const shown = events.filter((e) => e.kind !== 'time_advanced');
  const chips = `<div class="chips" data-filter="events"><button class="chip on" data-lane="all">all (${shown.length})</button>${[...counts.entries()].filter(([k]) => k !== 'time_advanced').sort((a, b) => b[1] - a[1]).map(([k, n]) => `<button class="chip" data-lane="${esc(k)}">${esc(k)} (${n})</button>`).join('')}</div>`;
  const rows = shown.map((e) => `<div class="ev" data-lane-of="events" data-lane="${esc(e.kind)}"><span class="seq">#${e.seq}</span><span class="at">${esc(dayOffset(e.virtualAt, start))}</span><span class="k ${esc(e.kind)}">${esc(e.kind)}</span><span class="s">${esc(summarize(e))}</span><pre>${esc(JSON.stringify(e.payload, null, 2))}</pre></div>`);
  return `${chips}<div class="events">${rows.join('')}</div><p class="lede" style="margin-top:8px;font-size:12.5px">${counts.get('time_advanced') ?? 0} time advances hidden. Click a row for its payload.</p>`;
}

export function renderAgentRuns(r: RunDetail): string {
  if (!r.agentRuns.length) return '';
  const cards = r.agentRuns.map((a) => {
    const spine = (a.steps ?? []).map((s) => (s.tool ? `<b>${esc(s.tool)}</b>${s.gate && typeof s.gate === 'object' && (s.gate as { outcome?: string }).outcome !== 'allowed' ? `<span style="color:var(--fail)">(${esc((s.gate as { outcome?: string }).outcome)})</span>` : ''}` : '')).filter(Boolean).join(' → ') || '(no tool calls)';
    const steps = (a.steps ?? []).map((s) => `<details><summary>${s.n} ${esc(s.tool ?? 'text turn')}</summary>${s.thinking ? `<blockquote>${esc(s.thinking)}</blockquote>` : ''}<pre>${esc(JSON.stringify({ input: s.input, output: s.output, gate: s.gate }, null, 2).slice(0, 6000))}</pre></details>`).join('');
    return `<div class="card"><div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap"><code class="mono">${esc(a.id.slice(0, 8))}</code><span class="tag">${esc(a.triggerType ?? 'run')}</span><span class="tag">${esc(a.status)}</span><span class="mono" style="color:var(--faint);font-size:12px">${esc(dayOffset(a.at, r.startedAt))}</span>${a.costUsd != null ? `<span class="mono" style="margin-left:auto;color:var(--dim);font-size:12px">${money(a.costUsd)}</span>` : ''}</div><div class="spine" style="margin-top:8px">${spine}</div>${a.reply ? `<blockquote>${esc(a.reply)}</blockquote>` : ''}${steps}</div>`;
  });
  return cards.join('');
}

/** The body of one run, for its own page and for a sweep page. */
export function renderRunSection(r: RunDetail, opts: { standalone?: boolean } = {}): string {
  const id = `run-${r.id}`;
  const out: string[] = [];
  out.push(`<section class="run" id="${esc(id)}">`);
  out.push(`<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:4px">${verdictPill(r.status, r.score)}${opts.standalone ? `<h1 style="display:inline">${esc(r.title)}</h1>` : `<h3 style="display:inline">${esc(r.title)}</h3>`}<span class="tag">${esc(r.scenario)} · seed ${r.seed}</span>${r.freezeId ? `<span class="tag">replay of ${esc(r.freezeId.slice(0, 8))}</span>` : ''}</div>`);
  if (r.hunts) out.push(`<p class="lede">Hunts: ${esc(r.hunts)}</p>`);
  if (r.notes) out.push(`<p class="lede">${esc(r.notes)}</p>`);
  const c = r.counters;
  if (c) {
    out.push(
      statGrid([
        ['simulated', hours(c.virtualElapsedMs)],
        ['real time', secs(c.realElapsedMs)],
        ['runs', String(c.runsExecuted ?? 0)],
        ['ticks', String(c.ticks ?? 0)],
        ['sends', String(r.sendsList.length)],
        ['blocked', String(r.blocked.length)],
        ['model', money(c.costUsd)],
        ['judge', money(r.verdict?.judgeCostUsd ?? 0)],
      ]),
    );
    out.push(`<p class="lede" style="margin-top:12px">Ended because <span class="mono">${esc(c.endedBecause ?? '?')}</span>${c.stopReason ? ` (${esc(c.stopReason)})` : ''}. ${c.steps ?? 0} steps, ${c.shifts ?? 0} shifts moving ${c.rowsShifted ?? 0} rows of virtual time.${r.model ? ` Model ${esc(r.model)}.` : ''}</p>`);
  }
  if (r.error) out.push(`<div class="card"><p>The run died before it could write a result.</p><div class="log">${esc(r.error)}</div></div>`);

  out.push(`<h2 id="${esc(id)}-cast">Who was in it</h2>`);
  out.push(renderCast(r.participants, messageCounts(r.messages)));

  out.push(`<h2 id="${esc(id)}-story">The story, both sides, in virtual time</h2>`);
  out.push(renderStrip(r.messages, r.participants, r.startedAt, r.virtualMs));
  out.push('<p class="lede">Everything above the last hop ran for real: the model chose these words, the outbound path cut them into parts, and the rail decided what became a page. Only the delivery was captured. What people said back came from simulated people who never saw the assistant\'s prompt.</p>');
  out.push(renderChips(`story-${r.id}`, lanesOf(r.messages)));
  out.push(renderFeed(r.messages, r.participants, r.startedAt, `story-${r.id}`));

  const rooms = renderRooms(r.messages, r.participants, r.startedAt);
  if (rooms) {
    out.push(`<h2 id="${esc(id)}-rooms">Room by room</h2>`);
    out.push(rooms);
  }

  out.push(`<h2 id="${esc(id)}-score">Why the score is what it is</h2>`);
  out.push(renderScoreSection(r.verdict, r.status, r.error));

  out.push(`<h2 id="${esc(id)}-boundary">What the boundary caught</h2>`);
  out.push('<p class="lede">Every call that would have left the process, by host: a delivery host is captured and answered with a canned success, model inference passes through, and anything on no rule blocks and fails the run.</p>');
  out.push(`<div class="card"><table><thead><tr><th>Boundary</th><th class="num">Calls</th></tr></thead><tbody>${r.captures.map((cpt) => `<tr><td><code class="mono">${esc(cpt.label)}</code></td><td class="num">${cpt.count}</td></tr>`).join('') || '<tr><td colspan="2" style="color:var(--faint)">nothing left the process</td></tr>'}</tbody></table>${r.blocked.length ? `<div class="log" style="color:var(--fail)">${r.blocked.map((b) => esc(`${clock(b.at)} BLOCKED ${b.method} ${b.url}`)).join('\n')}</div>` : ''}</div>`);

  if (r.agentRuns.length) {
    out.push(`<h2 id="${esc(id)}-runs">The assistant's runs</h2>`);
    out.push(renderAgentRuns(r));
  }

  out.push(`<h2 id="${esc(id)}-events">The run, event by event</h2>`);
  out.push(renderEventsSection(r.events, r.startedAt));

  if (r.evidenceDir) out.push(`<p class="foot">${esc(r.evidenceDir)}</p>`);
  out.push('</section>');
  return out.join('\n');
}

export function renderRunPage(r: RunDetail): string {
  const id = `run-${r.id}`;
  return shell(`${r.scenario} seed ${r.seed}`, renderRunSection(r, { standalone: true }), {
    kicker: `${r.scenario} · seed ${r.seed}`,
    nav: [
      [`#${id}-cast`, 'cast'],
      [`#${id}-story`, 'story'],
      [`#${id}-score`, 'score'],
      [`#${id}-boundary`, 'boundary'],
      [`#${id}-events`, 'events'],
    ],
  });
}
