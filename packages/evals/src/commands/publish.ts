import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from 'commander';
import type { RunDetail } from '@platform/evals';
import { parseSince } from '@platform/cli-kit/text';
import { esc, renderMatrixPage, renderSweepPage, shell } from '@platform/evals/html';
import { buildMatrix } from '@platform/evals/render';

import { codecastFreezeStore, isPublicFreeze } from '../adapters/freezes';
import { codecastRunSource } from '../adapters/runs';
import { homePaths, PUBLISH_TASK } from '../paths';
import { statusRows } from './status';

// One fixed directory, published behind the email gate and attached to the
// evals task. The email gate is a capture step, not secrecy (any address
// opens the page), so the run pages carry only runs of public freezes: the
// fixtures already committed to this public repo. A run of a private freeze
// replays a real workspace and never leaves EVALS_HOME.

export const PUBLISH_TITLE = 'Codecast evals';

export async function writeSite(opts: { since: string }): Promise<string> {
  const site = homePaths().site;
  mkdirSync(site, { recursive: true });
  const src = codecastRunSource();
  const since = parseSince(opts.since) ?? Date.now() - 86_400_000;
  const publicIds = new Set((await codecastFreezeStore().list()).filter(isPublicFreeze).map((f) => f.id));
  const all = await src.list({ since, limit: 400 });
  const rows = all.filter((r) => r.freezeId && publicIds.has(r.freezeId));
  if (rows.length < all.length) console.log(`left out ${all.length - rows.length} run(s) of private freezes: they replay real workspaces`);
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

/**
 * Publish the site and print its URL. Returns the exit code and the URL, so a
 * caller (check --signal) can cite the page as evidence.
 */
export async function publishSite(opts: { since: string; dry?: boolean }): Promise<{ code: number; url?: string }> {
  const site = await writeSite(opts);
  const args = ['publish', site, '--email-gate', '--task', PUBLISH_TASK, '--title', PUBLISH_TITLE];
  if (opts.dry) {
    console.log(`would run: cast ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
    return { code: 0 };
  }
  const r = spawnSync('cast', [...args, '--json'], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  const url = (() => {
    try {
      return (JSON.parse(r.stdout) as { url?: string }).url;
    } catch {
      return undefined;
    }
  })();
  console.log(url ? `published ${url}` : (r.stdout ?? '').trim());
  return { code: r.status ?? 1, url };
}

export function registerPublish(program: Command): void {
  program
    .command('publish')
    .description('write the status page and the run and matrix pages of public (fixture) freezes to EVALS_HOME/html/site, and publish them email gated on the evals task')
    .option('--since <t>', 'runs in the report (default 24h)', '24h')
    .option('--dry', 'write the pages, print the publish command, publish nothing')
    .action(async (flags: { since: string; dry?: boolean }) => {
      process.exitCode = (await publishSite(flags)).code;
    });
}
