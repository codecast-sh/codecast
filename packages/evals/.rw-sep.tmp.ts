// Throwaway: separation between two named check batches, per freeze and pooled.
import { surfaceRuns } from './src/adapters/runs';
import { separationLine } from './src/stats';
import { repPassed } from './src/adapters/replay';
const [base, variant, gateId] = process.argv.slice(2);
const runs = (await surfaceRuns('role-wake')).filter((r) => r.status !== 'dry' && r.status !== 'crash');
const pick = (b: string) => runs.filter((r) => r.batch === b);
const A = pick(base), B = pick(variant);
const s = (r: any) => r.score ?? 0;
const ids = [...new Set([...A, ...B].map((r) => r.freezeId))];
for (const id of ids) {
  const a = A.filter((r) => r.freezeId === id), b = B.filter((r) => r.freezeId === id);
  const fmt = (xs: any[]) => `${xs.filter(repPassed).length}/${xs.length} pass, scores ${xs.map((r) => s(r).toFixed(2)).join(' ')} status ${[...new Set(xs.map((r) => r.status))].join(',')}`;
  console.log(`${String(id).slice(0, 8)}\n  base    ${fmt(a)}\n  variant ${fmt(b)}\n  ${separationLine(b.map(s), a.map(s))}`);
}
console.log(`pooled: ${separationLine(B.map(s), A.map(s))}`);
const cost = (xs: any[]) => xs.reduce((t, r) => t + (r.costUsd ?? 0), 0);
console.log(`cost base $${cost(A).toFixed(2)} variant $${cost(B).toFixed(2)}`);
