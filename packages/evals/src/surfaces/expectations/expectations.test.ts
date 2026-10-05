import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fixturesDir } from '../../paths';
import impl, { briefing, type ExpectationsLabel, type ExpectationsSnap } from './index';

const fixture = (name: string) => JSON.parse(readFileSync(join(fixturesDir(), 'expectations', `${name}.json`), 'utf8')) as { snapshot: ExpectationsSnap; label: ExpectationsLabel };

/** A finished run whose agent wrote `proposal` (or nothing). */
function runWith(proposal: string | null) {
  const runSubdir = mkdtempSync(join(tmpdir(), 'xp-surface-'));
  mkdirSync(runSubdir, { recursive: true });
  if (proposal !== null) writeFileSync(join(runSubdir, 'proposal.md'), proposal);
  return { reply: '', calls: [], agents: [{ runSubdir, said: [], turns: [], wrote: [[]], calls: [], costUsd: 0, modelUsage: {}, isError: false, exitCode: 0, model: 'm', realMs: 0 }] } as any;
}
const failing = (gates: { id: string; pass: boolean }[]) => gates.filter((g) => !g.pass).map((g) => g.id);

describe('expectations surface', () => {
  const infra = fixture('infra-agent-notes');
  const quiet = fixture('callers-quiet');

  test('the briefing is the routine prompt filled for the project, then the harness note', () => {
    const text = briefing(infra.snapshot);
    expect(text).toContain('cast expectations show --project\npj-41 --json');
    expect(text).not.toContain('{{');
    expect(text).toContain('Write the proposal to proposal.md in the current directory');
  });

  test("a proposal grounded in the two rulings passes; one citing an agent's shipped note fails persons-words-only", () => {
    const good = `# Two rulings from the window
since: 2026-10-02T00:00:00.000Z
until: 2026-10-05T18:00:00.000Z

## add
part: Contact data
text: The address a contact gives us wins over the enrichment vendor's guess, which is kept only as a spare.
- decision sd-140 (2026-10-03): "The address the contact gives us wins. Keep the vendor's guess only as a spare."

## add
part: Domain fleet
text: The domain fleet runs on a paid Workers tier, so a crawl cannot take every landing page down at once.
- chat #infra/j17infra0mara0ruling (2026-10-02): "A crawl should never be able to take every landing page down at once."
`;
    const out = runWith(good);
    expect(failing(impl.gates(infra.snapshot, out, infra.label))).toEqual([]);
    expect(impl.checks!(infra.snapshot, out, infra.label)[0]!.score).toBe(1);

    const borrowed = `${good}
## add
part: Email sending
text: A delivery outranks a later temporary bounce.
- task ct-61001 (2026-10-03): "a delivery now outranks a later temporary bounce"
`;
    expect(failing(impl.gates(infra.snapshot, runWith(borrowed), infra.label))).toEqual(['persons-words-only']);
  });

  test('a window that held nothing passes empty from the cursor; a change, a wrong window or no file fails', () => {
    const empty = '# Nothing for Callers in this window\nsince: 2026-10-05T17:00:00.000Z\nuntil: 2026-10-05T18:20:00.000Z\n';
    expect(failing(impl.gates(quiet.snapshot, runWith(empty), quiet.label))).toEqual([]);
    const late = empty.replace('17:00:00', '17:45:09');
    expect(failing(impl.gates(quiet.snapshot, runWith(late), quiet.label))).toEqual(['window']);
    const added = `${empty}\n## add\npart: Callbacks\ntext: We call back only when asked.\n- chat #callers/j17callers0digest (2026-10-05): "we only call back when they asked us to"\n`;
    expect(failing(impl.gates(quiet.snapshot, runWith(added), quiet.label))).toEqual(['persons-words-only', 'nothing-to-change']);
    expect(failing(impl.gates(quiet.snapshot, runWith(null), quiet.label))).toEqual(['proposal-written']);
  });
});
