// The matrix page: models against subjects, the per model totals, and cost
// against pass rate drawn so the tradeoff is one glance.

import type { Matrix } from '../render/matrix';
import { cellWord } from '../render/matrix';
import { bar, esc, money, secs, shell, statGrid } from './page';

const DASH = '&mdash;';

function scatter(m: Matrix): string {
  const pts = m.totals.filter((t) => t.meanTurnCostUsd !== null);
  if (pts.length < 2) return '';
  const W = 560;
  const H = 260;
  const pad = { l: 56, r: 24, t: 18, b: 44 };
  const maxCost = Math.max(...pts.map((t) => t.meanTurnCostUsd!)) * 1.15 || 1;
  const x = (c: number) => pad.l + (c / maxCost) * (W - pad.l - pad.r);
  const y = (rate: number) => pad.t + (1 - rate) * (H - pad.t - pad.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    `<h2>Cost against pass rate</h2><p class="lede">One point per model: the mean cost of an assistant turn across the x axis, the share of runs that passed up the y axis. The corner to want is top left.</p>` +
    `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block;font-family:inherit;font-size:12px">` +
    ticks.map((t) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)" stroke-width="1"/><text x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end" fill="var(--dim)">${Math.round(t * 100)}%</text>`).join('') +
    `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}" stroke="var(--dim)"/>` +
    [0, 0.5, 1].map((f) => `<text x="${x(maxCost * f)}" y="${H - pad.b + 18}" text-anchor="middle" fill="var(--dim)">${money(maxCost * f)}</text>`).join('') +
    `<text x="${(pad.l + W - pad.r) / 2}" y="${H - 6}" text-anchor="middle" fill="var(--dim)">mean cost of a turn</text>` +
    pts
      .map((t, i) => {
        const cx = x(t.meanTurnCostUsd!);
        const cy = y(t.passRate);
        const above = i % 2 === 0;
        return `<circle cx="${cx}" cy="${cy}" r="6" fill="var(--accent, #6ee7b7)" stroke="var(--bg, #000)" stroke-width="2"/><text x="${cx}" y="${above ? cy - 12 : cy + 20}" text-anchor="middle" fill="var(--text)">${esc(t.model.replace(/^claude-/, ''))}</text>`;
      })
      .join('') +
    `</svg>`
  );
}

export function renderMatrixPage(m: Matrix, opts: { title?: string; stamp?: string } = {}): string {
  const runs = m.totals.reduce((n, t) => n + t.reps, 0);
  const cost = m.totals.reduce((n, t) => n + t.costUsd, 0);
  const cell = (model: string, subject: string) => m.cells.find((c) => c.model === model && c.subject === subject);
  const tone = (c: ReturnType<typeof cell>) => (!c ? 'var(--faint)' : c.crashed ? 'var(--fail)' : c.passed === c.reps ? 'var(--pass, #6ee7b7)' : c.passed === 0 ? 'var(--fail)' : 'var(--warn, #ffd166)');
  const grid =
    `<table><thead><tr><th>Subject</th>${m.models.map((model) => `<th class="num">${esc(model)}</th>`).join('')}</tr></thead><tbody>` +
    m.subjects
      .map((s) => `<tr><td style="white-space:nowrap">${esc(s)}</td>${m.models.map((model) => `<td class="num" style="color:${tone(cell(model, s))}">${esc(cellWord(cell(model, s))) || DASH}</td>`).join('')}</tr>`)
      .join('') +
    `</tbody></table>`;
  const totals =
    `<table><thead><tr><th>Model</th><th class="num">Passed</th><th class="num">Rate</th><th class="num">Mean score</th><th class="num">Cost</th><th class="num">Turns</th><th class="num">Cost / turn</th><th class="num">Time / turn</th><th class="num">Tokens in / turn</th></tr></thead><tbody>` +
    m.totals
      .map(
        (t) =>
          `<tr><td><code class="mono">${esc(t.model)}</code></td><td class="num">${t.passed}/${t.reps}${t.crashed ? ` <span style="color:var(--fail)">!${t.crashed}</span>` : ''}</td><td class="num">${bar(t.passRate)} ${Math.round(t.passRate * 100)}%</td><td class="num">${t.meanScore !== null ? t.meanScore.toFixed(2) : DASH}</td><td class="num">${money(t.costUsd)}</td><td class="num">${t.turns}</td><td class="num">${t.meanTurnCostUsd !== null ? money(t.meanTurnCostUsd) : DASH}</td><td class="num">${t.meanTurnMs !== null ? secs(t.meanTurnMs) : DASH}</td><td class="num">${t.meanTurnTokensIn !== null ? `${Math.round(t.meanTurnTokensIn / 1000)}k` : DASH}</td></tr>`,
      )
      .join('') +
    `</tbody></table>`;
  const title = opts.title ?? `Models against the suite, ${opts.stamp ? new Date(opts.stamp.slice(0, 10)).toDateString() : new Date().toDateString()}`;
  const body =
    `<h1>${esc(title)}</h1>` +
    `<p class="lede">Every subject is a scenario or a frozen production moment; every column is a model the assistant ran on. A cell is passed of reps and the mean score. The same scoring decided every cell, gates in code and judged checks by one judge model, so the columns differ only in the assistant.</p>` +
    `<div style="margin:22px 0">${statGrid([
      ['runs', String(runs)],
      ['models', String(m.models.length)],
      ['subjects', String(m.subjects.length)],
      ['cost', money(cost)],
    ])}</div>` +
    `<h2>The matrix</h2>${grid}` +
    `<h2>Per model</h2>${totals}` +
    scatter(m) +
    (m.unlabelled ? `<p class="lede">${m.unlabelled} run(s) carried no model label and are counted under the ladder default, the models in .env when they ran.</p>` : '');
  return shell(title, body, { kicker: 'matrix' });
}
