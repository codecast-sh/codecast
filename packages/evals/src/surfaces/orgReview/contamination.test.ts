import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { foreignRecords, proposalRecordIds, recordOwners } from './contamination';
import { gradeDir, type GradeSets } from './grade';

// ct-56832: a Union rep read a codecast rep's /tmp scratch and proposed 48
// codecast closes. The own-workspace gate fails a proposal that touches a
// record another workspace's snapshot or labels hold, and names the ids.

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const close = (task: string) => ({ change: { kind: 'task_status', task, status: 'done', reason: 'shipped' } });

/** Two workspaces on record, as snapshots and labels hold them. */
function world() {
  const root = tmp('org-own-');
  const acme = join(root, 'snapshots', 'acme-base1');
  const globex = join(root, 'snapshots', 'globex-base1');
  const inputs = (name: string, tasks: string[], session: string) => ({
    workspace: { name },
    projects: [{ id: `${name.toLowerCase().padEnd(32, '0')}`, short_id: `pj-${name.toLowerCase()}`, title: name }],
    coverage: { projects: [{ title: name, lead: null }] },
    org: { roles: [{ handle: `${name.toLowerCase()}-lead`, seat: { session } }] },
    activity: { stale: { plans: [], tasks: tasks.map((short_id) => ({ short_id })) } },
  });
  mkdirSync(acme, { recursive: true });
  mkdirSync(join(globex, 'reads'), { recursive: true });
  writeFileSync(join(acme, 'org-inputs.json'), JSON.stringify(inputs('Acme', ['ct-1', 'ct-2'], 'jx7aaaa')));
  writeFileSync(join(globex, 'org-inputs.json'), JSON.stringify(inputs('Globex', ['ct-50', 'ct-51'], 'jx7gggg')));
  // A captured record read counts as the workspace's too, a full session id among them.
  writeFileSync(join(globex, 'reads', 'k.out'), 'ct-52 | Open | plan pl-9\n  jx7hhhhxxxxxxxxxxxxxxxxxxxxxxxxx  a session');
  const globexLabels = join(root, 'labels', 'globex');
  mkdirSync(globexLabels, { recursive: true });
  writeFileSync(join(globexLabels, 'grade-sets.json'), JSON.stringify({ must_not_close: ['ct-60'] }));
  const owners = recordOwners([
    { workspace: 'acme', dir: acme },
    { workspace: 'globex', dir: globex },
    { workspace: 'globex', dir: globexLabels },
  ]);
  return { acme, owners };
}

describe('own-workspace gate', () => {
  test('a proposal names record ids in any field, and titles or handles are not ids', () => {
    const ids = proposalRecordIds([
      close('ct-1'),
      { change: { kind: 'role', handle: 'qa-lead', seat: { existing: 'jx7aaaa' }, scope: { projects: ['Acme', 'pj-acme'], plans: ['pl-3'] } } },
      { change: { kind: 'file', plan: 'plan:pl-4', project: 'project:pj-acme' } },
      { change: { kind: 'initiative_owner', initiative: 'in-4', owner: '@growth' } },
    ]);
    expect(ids).toEqual(['ct-1', 'jx7aaaa', 'pj-acme', 'pl-3', 'pl-4', 'in-4']);
  });

  test("ids another workspace holds are foreign, each with its owner; the freeze's own and unknown ids are not", () => {
    const { owners } = world();
    const foreign = foreignRecords([close('ct-1'), close('ct-50'), close('ct-52'), close('ct-60'), close('ct-999'), { change: { kind: 'adopt', handle: 'x', conversation: 'jx7hhhh' } }], 'acme', owners);
    expect(foreign).toEqual([
      { id: 'ct-50', owners: ['globex'] },
      { id: 'ct-52', owners: ['globex'] },
      { id: 'ct-60', owners: ['globex'] },
      { id: 'jx7hhhh', owners: ['globex'] },
    ]);
    expect(foreignRecords([close('ct-50')], 'globex', owners)).toEqual([]);
  });

  test('gradeDir fails own-workspace and names the foreign ids; a clean proposal passes it', () => {
    const { acme, owners } = world();
    const sets: GradeSets = { must_not_close: [], should_close: ['ct-1'], name_it: [], never_name: [] };
    const grade = (changes: object[]) => {
      const run = tmp('org-own-run-');
      mkdirSync(join(run, 'proposals'));
      writeFileSync(join(run, 'proposals', 'op-1.json'), JSON.stringify({ title: 't', summary_md: 's', changes }));
      return gradeDir(run, { workspace: 'acme', servedDir: acme, sets, pool: new Set(), owners }).gates.find((g) => g.id === 'own-workspace')!;
    };
    const mixed = grade([close('ct-1'), close('ct-50'), close('ct-51')]);
    expect(mixed.pass).toBe(false);
    expect(mixed.evidence.summary).toBe('touches 2 record(s) another workspace holds, not acme: ct-50 (globex), ct-51 (globex)');
    const clean = grade([close('ct-1'), close('ct-2')]);
    expect(clean.pass).toBe(true);
  });
});
