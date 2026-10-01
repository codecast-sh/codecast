import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from 'commander';
import type { RunDetail } from '@platform/evals';
import { parseSince } from '@platform/cli-kit/text';
import { esc, renderMatrixPage, renderSweepPage, shell } from '@platform/evals/html';
import { buildMatrix } from '@platform/evals/render';

import { codecastRunSource } from '../adapters/runs';
import { homePaths, PUBLISH_TASK } from '../paths';
import { statusRows } from './status';

// One fixed directory, always published behind the email gate and attached to
// the evals task. There is no ungated path: the pages carry replies to real
// moments.

export const PUBLISH_TITLE = 'Codecast evals';

export async function writeSite(opts: { since: string }): Promise<string> {
  const site = homePaths().site;
  mkdirSync(site, { recursive: true });
  const src = codecastRunSource();
  const since = parseSince(opts.since) ?? Date.now() - 86_400_000;
  const rows = await src.list({ since, limit: 400 });
  const details = (await Promise.all(rows.map((r) => src.get(r.id)))).filter((d): d is RunDetail => Boolean(d));
  writeFileSync(join(site, 'report.html'), renderSweepPage(details, { title: `${PUBLISH_TITLE}: runs since ${opts.since}`, links: false }));
  writeFileSync(join(site, 'matrix.html'), renderMatrixPage(buildMatrix(rows, new Map(details.map((d) => [d.id, d]))), { title: `${PUBLISH_TITLE}: models by freeze` }));
  const status = await statusRows();
  const table = `<table><thead><tr>${['surface', 'route', 'model', 'freezes', 'last run', 'pass (last 5)', 'state'].map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${status
    .map((r) => `<tr>${[r.id, r.route, r.model, r.freezes, r.lastRun, r.passRate, r.mark].map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
  writeFileSync(join(site, 'index.html'), shell(PUBLISH_TITLE, `<h1>${PUBLISH_TITLE}</h1>${table}<p><a href="report.html">Every run since ${esc(opts.since)}</a> · <a href="matrix.html">Models by freeze</a></p>`, { nav: [['report.html', 'runs'], ['matrix.html', 'matrix']] }));
  return site;
}

export async function publishSite(opts: { since: string; dry?: boolean }): Promise<number> {
  const site = await writeSite(opts);
  const args = ['publish', site, '--email-gate', '--task', PUBLISH_TASK, '--title', PUBLISH_TITLE];
  if (opts.dry) {
    console.log(`would run: cast ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
    return 0;
  }
  const r = spawnSync('cast', args, { stdio: 'inherit' });
  return r.status ?? 1;
}

export function registerPublish(program: Command): void {
  program
    .command('publish')
    .description(`write the status, run and matrix pages to EVALS_HOME/html/site and publish them, email gated, on ${PUBLISH_TASK}`)
    .option('--since <t>', 'runs in the report (default 24h)', '24h')
    .option('--dry', 'write the pages, print the publish command, publish nothing')
    .action(async (flags: { since: string; dry?: boolean }) => {
      process.exitCode = await publishSite(flags);
    });
}
