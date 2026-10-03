import type { Command } from 'commander';

import { surfaces } from '../registry';
import { changedSince, DAILY_USD, spentToday, staleness } from '../state';
import type { SurfaceMeta } from '../surface';

// The precheck the cadence trigger runs before spending anything: exit 0 when
// some surface's declared sources changed at HEAD since its last run, exit 1
// when nothing did. Reads git and state.json only; no surface code loads.
// With --base it answers the line's question instead: which surfaces does
// this branch touch since it left <ref>, committed or still in the checkout.

export interface StaleFlags {
  route?: string;
  list?: boolean;
  base?: string;
  /** The --budget the check behind this precheck passes: a surface refused at a smaller budget is due again. */
  budget?: number;
}

export function pickSurfaces(ids: string[], route?: string): SurfaceMeta[] {
  const all = surfaces();
  const unknown = ids.filter((id) => !all.some((s) => s.id === id));
  if (unknown.length) throw new Error(`no surface ${unknown.join(', ')}; surfaces: ${all.map((s) => s.id).join(', ')}`);
  return all.filter((s) => (!ids.length || ids.includes(s.id)) && (!route || s.route === route));
}

/**
 * Prints the stale and blocked surfaces; returns the exit code. The code
 * counts only what `check --stale` would act on, so a surface waiting on a
 * dirty checkout is shown but never fires the trigger.
 */
export function runStale(ids: string[], flags: StaleFlags): number {
  if (flags.base) {
    const { base, changed } = changedSince(pickSurfaces(ids, flags.route), flags.base);
    if (flags.list) for (const s of changed) console.log(s.id);
    else {
      for (const s of changed) console.log(`changed  ${s.id} (${s.route})`);
      if (!changed.length) console.log(`no surface's sources differ from ${flags.base} (${base.slice(0, 9)})`);
    }
    return changed.length ? 0 : 1;
  }
  const { stale, waiting, due, blocked } = staleness(pickSurfaces(ids, flags.route), undefined, undefined, flags.budget);
  // An unattended day that spent its ceiling fires nothing more; `check --stale` would only refuse.
  const spent = spentToday();
  if (due.length && spent >= DAILY_USD) {
    if (!flags.list) console.log(`${due.length} surface(s) due, but $${spent.toFixed(2)} spent today reaches the $${DAILY_USD} daily ceiling: nothing fires until tomorrow`);
    return 1;
  }
  if (flags.list) {
    for (const s of due) console.log(s.id);
    return due.length ? 0 : 1;
  }
  for (const s of stale) console.log(`stale    ${s.id} (${s.route})${s.route === 'agent' ? ': manual run needed' : waiting.includes(s) ? ': sources dirty in the checkout, waits for a commit' : ''}`);
  for (const s of blocked) console.log(`blocked  ${s.id}: crashed twice on these sources; fix it, then ./evals check ${s.id}`);
  if (!due.length) console.log(stale.length || blocked.length ? 'nothing to run (dirty and blocked surfaces are not counted)' : 'nothing changed');
  return due.length ? 0 : 1;
}

/** A flag's positive number, or null: NaN would disable every spend check. `check`'s parsers share it. */
export const positiveValue = (v: string | undefined, integer = false): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && (!integer || Number.isInteger(n)) ? n : null;
};

const budgetArg = (v: string | undefined): number => {
  const n = positiveValue(v);
  if (n == null) throw new Error(`--budget takes a positive number, not "${v ?? ''}"`);
  return n;
};

/**
 * The fast path: `./evals stale` parsed by hand, so commander and the platform
 * never load. It throws on a bad argument; index.ts prints that as one line
 * and exits 2, never 1, which is the precheck's "nothing changed".
 */
export function staleMain(argv: string[]): number {
  const ids: string[] = [];
  const flags: StaleFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--list') flags.list = true;
    else if (a === '--route') flags.route = argv[++i];
    else if (a.startsWith('--route=')) flags.route = a.slice('--route='.length);
    else if (a === '--base') flags.base = argv[++i];
    else if (a.startsWith('--base=')) flags.base = a.slice('--base='.length);
    else if (a === '--budget' || a.startsWith('--budget=')) flags.budget = budgetArg(a === '--budget' ? argv[++i] : a.slice('--budget='.length));
    else if (a.startsWith('-')) throw new Error(`stale has no option ${a}; it takes --route, --list, --base and --budget`);
    else ids.push(a);
  }
  return runStale(ids, flags);
}

export function registerStale(program: Command): void {
  program
    .command('stale [surfaces...]')
    .description('the precheck: exit 0 when a surface changed at HEAD since its last run, 1 when nothing did')
    .option('--route <route>', 'call or agent')
    .option('--list', 'only the stale surface ids')
    .option('--base <ref>', 'instead: the surfaces whose sources differ since the branch left <ref> (committed or dirty)')
    .option('--budget <usd>', "the check's --budget: a surface refused at a smaller one is due again", budgetArg)
    .action((ids: string[], flags: StaleFlags) => {
      process.exitCode = runStale(ids, flags);
    });
}
