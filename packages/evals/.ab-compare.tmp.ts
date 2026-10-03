// Throwaway: per-freeze separation between two named batches (deleted after use).
import { surfaceRuns } from './src/adapters/runs';
import { batchSet } from './src/commands/check';
import { separationLine, median } from './src/stats';
const [surface, base, variant] = process.argv.slice(2);
const runs = await surfaceRuns(surface!);
const a = batchSet(runs, base!), b = batchSet(runs, variant!);
const sc = (r: any) => (r.status === 'crash' ? null : r.score ?? 0);
const ids = [...new Set([...a, ...b].map((r) => r.freezeId))];
const all: [number[], number[]] = [[], []];
for (const id of ids) {
  const xa = a.filter((r) => r.freezeId === id && r.status !== 'crash'), xb = b.filter((r) => r.freezeId === id && r.status !== 'crash');
  const sa = xa.map((r) => sc(r)!), sb = xb.map((r) => sc(r)!);
  all[0].push(...sa); all[1].push(...sb);
  const pass = (xs: any[]) => xs.filter((r) => r.status === 'pass').length;
  const gates = (xs: any[]) => xs.flatMap((r) => r.gatesFailed).join(',');
  console.log(`${id?.slice(0, 8)}  base ${pass(xa)}/${xa.length} [${sa.map((x) => x.toFixed(2)).join(' ')}] ${gates(xa)}\n          var  ${pass(xb)}/${xb.length} [${sb.map((x) => x.toFixed(2)).join(' ')}] ${gates(xb)}\n          ${separationLine(sb, sa)}`);
}
console.log(`pooled: ${separationLine(all[1], all[0])}  medians ${median(all[1]).toFixed(2)} vs ${median(all[0]).toFixed(2)}`);
const cost = (xs: any[]) => xs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
console.log(`cost: base $${cost(a).toFixed(2)} (${a.length} reps), var $${cost(b).toFixed(2)} (${b.length} reps)`);
