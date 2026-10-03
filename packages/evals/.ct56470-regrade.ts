// scratch: regrade org-review reps on current labels without writing into run dirs
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gradeDir, freezeContext, loadGradeSets, handlePool } from './src/surfaces/orgReview/grade';
import { scoreOf } from './src/adapters/replay';
const runs = join(process.env.HOME!, '.local/share/codecast/evals/runs');
const freezes = join(process.env.HOME!, '.local/share/codecast/evals/freezes');
const batches = new Set(process.argv.slice(2));
const freezeMeta = new Map<string, any>();
const findFreeze = (id: string) => {
  if (freezeMeta.has(id)) return freezeMeta.get(id);
  const hits = execFind(id); freezeMeta.set(id, hits); return hits;
};
function execFind(id: string): any {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
  for (const f of walk(freezes)) { if (!f.endsWith('.json')) continue; try { const j = JSON.parse(readFileSync(f, 'utf8')); if (j.id === id) return j; } catch {} }
  throw new Error('no freeze ' + id);
}
const out: any[] = [];
for (const d of readdirSync(runs)) {
  if (!d.startsWith('org-review-')) continue;
  const dir = join(runs, d);
  let run: any; try { run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')); } catch { continue; }
  if (!batches.has(run.batch) || !existsSync(join(dir, 'score.json'))) continue;
  const stored = JSON.parse(readFileSync(join(dir, 'score.json'), 'utf8'));
  const fz = findFreeze(run.freezeId);
  const { workspace, servedDir } = freezeContext(fz);
  const tmp = mkdtempSync(join(tmpdir(), 'rg-'));
  cpSync(dir, tmp, { recursive: true, filter: (s) => !s.includes('live-reads') && !s.endsWith('stream.jsonl') });
  const g = gradeDir(tmp, { workspace, servedDir, sets: loadGradeSets(workspace), pool: handlePool(workspace) });
  rmSync(tmp, { recursive: true, force: true });
  const orgIds = new Set(g.gates.map((x) => x.id));
  const gates = [...stored.gates.filter((x: any) => !orgIds.has(x.id)), ...g.gates];
  const s = scoreOf(gates, g.checks);
  out.push({ d, batch: run.batch, freeze: fz.meta.snapshot.split('/').pop(), seed: d.match(/seed(\d+)/)![1], pass: s.pass, score: s.score,
    fails: gates.filter((x: any) => !x.pass).map((x: any) => x.id), wrong: g.auto.records.wrong_close, bad: g.auto.sessions.named_bad, closed: g.auto.records.closed_total, cost: run.costUsd });
}
console.log(JSON.stringify(out));
