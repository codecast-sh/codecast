import type { Command } from 'commander';
import { fmt } from '@platform/cli-kit/colors';
import { formatCost } from '@platform/cli-kit/format';
import { pad, relativeTime } from '@platform/cli-kit/text';

import { codecastFreezeStore, isPublicFreeze } from '../adapters/freezes';
import { hasSnapshot } from '../adapters/resolver';
import { surfaceRuns } from '../adapters/runs';
import { surfaces } from '../registry';
import { checkCostUsd, dirtySurfaces, readState, staleness, suggestedBudget } from '../state';

// `./evals` with no arguments: one row per surface, so a reader sees what
// exists, what ran, what is stale and what a default check would cost before
// running anything.

export interface StatusRow {
  id: string;
  route: string;
  model: string;
  freezes: string;
  lastRun: string;
  passRate: string;
  mark: string;
  estimate: string;
  /** The number behind `estimate`: what a default `check` of this surface estimates. */
  estimateUsd: number;
}

export async function statusRows(): Promise<StatusRow[]> {
  const metas = surfaces();
  const state = readState();
  const { stale, blocked } = staleness(metas, state);
  const dirty = dirtySurfaces(metas);
  const freezes = await codecastFreezeStore().list();
  return Promise.all(
    metas.map(async (m) => {
      const mine = freezes.filter((f) => (f.meta as { surface?: string } | undefined)?.surface === m.id);
      const pub = mine.filter(isPublicFreeze).length;
      const missing = mine.filter((f) => !hasSnapshot(f)).length;
      const runs = await surfaceRuns(m.id, { limit: 50 });
      const last5 = runs.filter((r) => r.status === 'pass' || r.status === 'fail' || r.status === 'crash').slice(0, 5);
      const estimateUsd = checkCostUsd(m, mine.length - missing, state);
      const marks = [stale.some((s) => s.id === m.id) ? 'stale' : '', blocked.some((s) => s.id === m.id) ? 'blocked' : '', dirty.has(m.id) ? 'dirty' : ''].filter(Boolean);
      return {
        id: m.id,
        route: m.route,
        model: m.model,
        freezes: `${pub}/${mine.length - pub}${missing ? ` (${missing} missing here)` : ''}`,
        lastRun: runs[0] ? relativeTime(Date.parse(runs[0].createdAt)) : 'never',
        passRate: last5.length ? `${last5.filter((r) => r.status === 'pass').length}/${last5.length}` : '-',
        mark: marks.join(' ') || 'fresh',
        estimate: formatCost(estimateUsd),
        estimateUsd,
      };
    }),
  );
}

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description('one row per surface: route, model, freezes (public/private), last run, pass rate, stale or blocked, cost of a default check')
    .option('--json', 'machine readable output')
    .action(async (flags: { json?: boolean }) => {
      const rows = await statusRows();
      if (flags.json) return console.log(JSON.stringify(rows, null, 2));
      const cols: Array<[Exclude<keyof StatusRow, 'estimateUsd'>, string, number]> = [
        ['id', 'surface', 13],
        ['route', 'route', 6],
        ['model', 'model', 26],
        ['freezes', 'freezes pub/priv', 17],
        ['lastRun', 'last run', 10],
        ['passRate', 'pass(5)', 8],
        ['mark', 'state', 13],
        ['estimate', 'check costs', 11],
      ];
      console.log(fmt.muted(cols.map(([, h, w]) => pad(h, w)).join(' ')));
      for (const r of rows) console.log(cols.map(([k, , w]) => pad(r[k], w)).join(' '));
      console.log(fmt.muted('state: fresh ran on these sources · stale its sources changed at HEAD since its last run · dirty its sources are edited in the checkout (check --stale waits for a commit) · blocked crashed twice on these sources'));
      // The suggested budget comes from the same estimate `check` refuses on, so
      // the hint never names a command that would refuse, and it names a
      // command that has something to run: what changed at HEAD, then the
      // prompt under edit in the checkout.
      const call = rows.filter((r) => r.route === 'call' && !r.freezes.startsWith('0/0'));
      const stale = call.filter((r) => r.mark.includes('stale'));
      const dirty = call.filter((r) => r.mark.includes('dirty'));
      const empty = rows.filter((r) => r.freezes.startsWith('0/0')).map((r) => r.id);
      const budget = (picked: StatusRow[]) => suggestedBudget(picked.reduce((s, r) => s + r.estimateUsd, 0));
      console.log('');
      if (stale.length) console.log(`Next: ./evals check ${stale.map((r) => r.id).join(' ')} --budget ${budget(stale)}`);
      else if (dirty.length) console.log(`Next: ./evals check ${dirty.map((r) => r.id).join(' ')} --budget ${budget(dirty)}  (the prompts edited in the checkout)`);
      else if (empty.length) console.log(`Next: ./evals freeze create ${empty[0]}@fixture:<case>`);
      else if (call.length) console.log(`Next: nothing changed; ./evals check ${call[0]!.id} --budget ${budget([call[0]!])} re-runs one by hand`);
    });
}
