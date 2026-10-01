import type { Command } from 'commander';

import { surfaces } from '../registry';
import { staleness } from '../state';
import type { SurfaceMeta } from '../surface';

// The precheck the cadence trigger runs before spending anything: exit 0 when
// some surface's declared sources changed at HEAD since its last run, exit 1
// when nothing did. Reads git and state.json only; no surface code loads.

export interface StaleFlags {
  route?: string;
  list?: boolean;
}

export function pickSurfaces(ids: string[], route?: string): SurfaceMeta[] {
  const all = surfaces();
  const unknown = ids.filter((id) => !all.some((s) => s.id === id));
  if (unknown.length) throw new Error(`no surface ${unknown.join(', ')}; surfaces: ${all.map((s) => s.id).join(', ')}`);
  return all.filter((s) => (!ids.length || ids.includes(s.id)) && (!route || s.route === route));
}

/** Prints the stale and blocked surfaces; returns the exit code. */
export function runStale(ids: string[], flags: StaleFlags): number {
  const { stale, blocked } = staleness(pickSurfaces(ids, flags.route));
  if (flags.list) {
    for (const s of stale) console.log(s.id);
    return stale.length ? 0 : 1;
  }
  for (const s of stale) console.log(`stale    ${s.id} (${s.route})${s.route === 'agent' ? ': manual run needed' : ''}`);
  for (const s of blocked) console.log(`blocked  ${s.id}: crashed twice on these sources; fix it, then ./evals check ${s.id}`);
  if (!stale.length) console.log(blocked.length ? 'nothing stale (blocked surfaces are not counted)' : 'nothing changed');
  return stale.length ? 0 : 1;
}

/** The fast path: `./evals stale` parsed by hand, so commander and the platform never load. */
export function staleMain(argv: string[]): number {
  const ids: string[] = [];
  const flags: StaleFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--list') flags.list = true;
    else if (a === '--route') flags.route = argv[++i];
    else if (a.startsWith('--route=')) flags.route = a.slice('--route='.length);
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
    .action((ids: string[], flags: StaleFlags) => {
      process.exitCode = runStale(ids, flags);
    });
}
