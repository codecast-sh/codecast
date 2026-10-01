// The whole suite on one page: the table first, then every run in full.

import type { RunDetail } from '../model';
import { bar, esc, money, secs, shell, statGrid, verdictPill } from './page';
import { renderRunSection } from './run';

export function renderSweepPage(runs: RunDetail[], opts: { title?: string; stamp?: string; dry?: boolean; links?: boolean } = {}): string {
  const passed = runs.filter((r) => r.status === 'pass').length;
  const gateFailures = runs.reduce((n, r) => n + r.gatesFailed.length, 0);
  const cost = runs.reduce((n, r) => n + r.costUsd, 0);
  const real = runs.reduce((n, r) => n + r.realMs, 0);
  const rows = runs
    .map((r) => {
      const worst = [...(r.verdict?.checks ?? [])].sort((a, b) => a.score - b.score)[0];
      const href = opts.links ? `${esc(r.id)}/report.html` : `#run-${esc(r.id)}`;
      return `<tr><td style="white-space:nowrap"><a href="${href}">${esc(r.scenario)}</a></td><td class="num">${r.seed}</td><td>${verdictPill(r.status, null)}</td><td class="num">${r.score !== null ? `${bar(r.score)} ${r.score.toFixed(2)}` : '&mdash;'}</td><td>${r.gatesFailed.length ? r.gatesFailed.map((g) => `<code class="mono" style="color:var(--fail)">${esc(g)}</code>`).join(' ') : `<span style="color:var(--faint)">${r.verdict?.gates.length ?? 0} held</span>`}</td><td style="font-size:13px;color:var(--dim)">${worst ? `<code class="mono">${esc(worst.id)}</code> ${worst.score.toFixed(2)}` : ''}</td><td class="num">${r.sendsList.length}</td><td class="num">${secs(r.realMs)}</td><td class="num">${money(r.costUsd)}</td></tr>`;
    })
    .join('');
  const seeds = new Set(runs.map((r) => r.seed));
  const nav: Array<[string, string]> = runs.map((r) => [`#run-${r.id}`, `${r.scenario}${seeds.size > 1 ? `·${r.seed}` : ''}`]);
  const title = opts.title ?? `The suite, ${opts.stamp ? new Date(opts.stamp.slice(0, 10)).toDateString() : new Date().toDateString()}`;
  const body =
    `<h1>${esc(title)}</h1>` +
    `<p class="lede">Every scenario is a piece of work somebody actually wants done, run against the whole product against simulated people. Nothing reached anybody: the boundary captures the last hop and blocks any host on no rule.${opts.dry ? ' <strong>Scripted model: this run proves the wiring and nothing about the product.</strong>' : ''}</p>` +
    `<div style="margin:22px 0">${statGrid([
      ['scenarios passed', `${passed}/${runs.length}`],
      ['gates failed', String(gateFailures)],
      ['real time', secs(real)],
      ['cost', money(cost)],
    ])}</div>` +
    `<p class="lede">The bar is not a percentage. A gate is a thing that would lose somebody's trust, so a suite with one gate failing has not passed at all.</p>` +
    `<h2>Every run</h2><table><thead><tr><th>Scenario</th><th class="num">Seed</th><th>Verdict</th><th class="num">Score</th><th>Gates</th><th>Lowest judged check</th><th class="num">Sends</th><th class="num">Real</th><th class="num">Cost</th></tr></thead><tbody>${rows}</tbody></table>` +
    runs.map((r) => `<div style="margin-top:56px;border-top:1px solid var(--line);padding-top:24px">${renderRunSection(r)}</div>`).join('\n');
  return shell(title, body, { kicker: 'suite', nav });
}
