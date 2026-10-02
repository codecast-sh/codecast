import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { editionRequest, skipHeadline, storyPromptInput, storyRequest } from '../../../convex/convex/changesProse';
import { CHEAP_MODEL, STRONG_MODEL } from '../../../convex/convex/lib/anthropic';
import { loadSurface, surfaceMeta } from '../registry';
import type { CallResult, ReplayResult, SurfaceImpl, SurfaceRequest } from '../surface';
import { captureFromFile, idsIn } from './changesCommon';
import edition, { editionSurfaceRequest, type ChangesEditionLabel, type ChangesEditionSnap } from './changesEdition';
import story, { storySurfaceRequest, type ChangesStoryLabel, type ChangesStorySnap } from './changesStory';

// changes-story and changes-edition (docs/proposals/changes-page.md 7.9):
// each fixture posts what prod's builder makes from the same input, and each
// gate passes a good reply and fails the reply it exists to catch. No model
// calls.

const DIR = join(import.meta.dir, '..', '..', 'fixtures');
const cases = <S, L>(surface: string) =>
  readdirSync(join(DIR, surface))
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ kase: f.replace(/\.json$/, ''), ...(JSON.parse(readFileSync(join(DIR, surface, f), 'utf8')) as { snapshot: S; label: L }) }));
const stories = cases<ChangesStorySnap, ChangesStoryLabel>('changes-story');
const editions = cases<ChangesEditionSnap, ChangesEditionLabel>('changes-edition');
const storyCase = (k: string) => stories.find((c) => c.kase === k)!;
const editionCase = (k: string) => editions.find((c) => c.kase === k)!;

const call = (request: SurfaceRequest, text: string): CallResult => ({
  request, text, outputTokens: 80, stopReason: 'end_turn', modelUsage: { [request.model]: { outputTokens: 80 } }, costUsd: 0, isError: false, exitCode: 0, dir: '/tmp/x', realMs: 0,
});

async function replayWith(impl: SurfaceImpl, snap: unknown, text: string, label?: unknown) {
  const calls: CallResult[] = [];
  const out = await impl.replay(snap, {
    dry: false, model: 'm', runDir: '/tmp/x', freeze: {} as never,
    async call(req) {
      const c = call(req, text);
      calls.push(c);
      return c;
    },
    agent: async () => {
      throw new Error('no agents here');
    },
  });
  const r: ReplayResult = { ...out, calls, agents: [] };
  const gates = impl.gates(snap, r, label);
  return { out: r, sent: calls, gates: Object.fromEntries(gates.map((g) => [g.id, g.pass])), evidence: Object.fromEntries(gates.map((g) => [g.id, g.evidence?.summary ?? ''])), checks: impl.checks?.(snap, r, label) ?? [] };
}

const storyReply = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ headline: 'Failed webhook deliveries now retry for about an hour', dek: 'A delivery that failed once used to be dropped; it now retries with backoff.', body: '', kind: 'fix', importance: 4, why_source: 'session', risk_lines: {}, ...o });

const editionReply = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ edition_headline: 'Webhooks retry, digests go out at local time, and cli 1.4.2 ships', standfirst: 'Two backend changes make deliveries more reliable. The CLI release fixes hangs on flaky networks.', lead_story_key: 's1', section_order: ['api', 'cli', 'web'], brief_story_keys: ['s7', 's8', 's9'], ...o });

describe('registration', () => {
  test('both surfaces are call surfaces on the prod model and load', async () => {
    for (const id of ['changes-story', 'changes-edition']) {
      expect(surfaceMeta(id)?.route).toBe('call');
      expect(surfaceMeta(id)?.model).toBe(CHEAP_MODEL);
      expect(typeof (await loadSurface(id)).replay).toBe('function');
    }
  });
});

describe('changes-story fixtures', () => {
  test('the five cases the spec names are here', () => {
    expect(stories.map((c) => c.kase).sort()).toEqual(['batch-commit', 'commit-only-no-why', 'hidden-member', 'private-session-withheld']);
    expect(editions.map((c) => c.kase)).toContain('branch-flood');
  });

  for (const c of stories) {
    test(`${c.kase} posts prod's request and never takes the skip path`, () => {
      const s = c.snapshot;
      expect(storySurfaceRequest(s)).toEqual(storyRequest(storyPromptInput(s.story, s.commits, s.sessions, s.prs)));
      expect(skipHeadline(s.story, s.commits)).toBeNull();
    });

    test(`${c.kase} keeps everything the gate withheld out of the prompt`, () => {
      const req = storySurfaceRequest(c.snapshot);
      const sent = `${req.system}\n${req.prompt}`;
      for (const w of c.snapshot.withheld ?? []) {
        for (const word of [w.session, w.owner, ...w.phrases]) expect(sent).not.toContain(word);
      }
      for (const name of c.snapshot.people ?? []) expect(sent).not.toContain(name);
    });
  }

  test('the batch commit reaches the prompt as its api slice', () => {
    const { prompt } = storySurfaceRequest(storyCase('batch-commit').snapshot);
    expect(prompt).toContain('Only its api part belongs to this story');
    expect(prompt).toContain('+220 -40 chore: sweep before the 2.3 cut');
  });

  test('a withheld case has no session in the prompt and lists what was withheld for the judge', () => {
    const c = storyCase('private-session-withheld');
    expect(storySurfaceRequest(c.snapshot).prompt).not.toContain('Notes from the agent sessions');
    const msgs = story.describe(c.snapshot);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].text).toContain('jx7p4vq by Priya Raman (private session)');
  });
});

describe('changes-story gates', () => {
  const batch = storyCase('batch-commit');

  test('a good reply passes every gate and the why-source check', async () => {
    const r = await replayWith(story, batch.snapshot, storyReply(), batch.label);
    expect(r.gates).toEqual({ parse: true, lengths: true, 'no-em-dash': true, 'no-leak': true });
    expect(r.checks.find((x) => x.id === 'why-source')?.score).toBe(1);
    expect(r.out.reply).toContain('Headline: Failed webhook deliveries now retry');
  });

  test('a reply that is not JSON fails parse and lengths', async () => {
    const r = await replayWith(story, batch.snapshot, 'Webhooks retry now.', batch.label);
    expect(r.gates.parse).toBe(false);
    expect(r.gates.lengths).toBe(false);
  });

  test('a why source the story lacks is unusable to prod', async () => {
    const r = await replayWith(story, batch.snapshot, storyReply({ why_source: 'pr' }), batch.label);
    expect(r.gates.parse).toBe(false);
  });

  test('a headline over 90 characters, a long dek or a fourth sentence fails lengths', async () => {
    for (const o of [{ headline: 'x'.repeat(91) }, { dek: 'y'.repeat(161) }, { body: 'One. Two. Three. Four.' }]) {
      const r = await replayWith(story, batch.snapshot, storyReply(o), batch.label);
      expect(r.gates.parse).toBe(true);
      expect(r.gates.lengths).toBe(false);
    }
  });

  test('an em dash anywhere in the reply fails', async () => {
    const r = await replayWith(story, batch.snapshot, storyReply({ dek: 'Deliveries retry — for an hour.' }), batch.label);
    expect(r.gates['no-em-dash']).toBe(false);
  });

  test('a reason given where no input states one fails why-none', async () => {
    const c = storyCase('commit-only-no-why');
    const good = await replayWith(story, c.snapshot, storyReply({ headline: 'Invoices sort by due date by default', why_source: 'none', kind: 'feature' }), c.label);
    expect(good.gates['why-none']).toBe(true);
    const bad = await replayWith(story, c.snapshot, storyReply({ headline: 'Invoices sort by due date by default', why_source: 'commit', kind: 'feature' }), c.label);
    expect(bad.gates['why-none']).toBe(false);
  });

  test('naming a withheld owner, session or phrase fails the leak gate', async () => {
    const c = storyCase('private-session-withheld');
    const clean = await replayWith(story, c.snapshot, storyReply({ headline: 'Account activity can be exported as CSV', why_source: 'none' }), c.label);
    expect(clean.gates['no-leak']).toBe(true);
    for (const leak of ['Priya built a CSV export', 'Export from jx7p4vq', 'Export for the Halvorsen audit']) {
      const r = await replayWith(story, c.snapshot, storyReply({ headline: leak, why_source: 'none' }), c.label);
      expect(r.gates['no-leak']).toBe(false);
    }
  });

  test('an id the prompt never carried fails the leak gate; one it carried passes', async () => {
    const c = storyCase('hidden-member');
    const carried = await replayWith(story, c.snapshot, storyReply({ headline: 'Digests go out at 8am local time (#212)', why_source: 'pr', risk_lines: { schema: 'A migration adds a workspace timezone column.' } }), c.label);
    expect(carried.gates['no-leak']).toBe(true);
    expect(carried.checks.map((x) => [x.id, x.score])).toEqual([['why-source', 1], ['risk-lines', 1]]);
    const invented = await replayWith(story, c.snapshot, storyReply({ headline: 'Digests go out at local time, see ct-881', why_source: 'pr' }), c.label);
    expect(invented.gates['no-leak']).toBe(false);
    expect(invented.evidence['no-leak']).toContain('id ct-881');
  });

  test('a skip path story is refused rather than replayed', async () => {
    const c = storyCase('commit-only-no-why');
    const one = { ...c.snapshot, story: { ...c.snapshot.story, commit_shas: [c.snapshot.commits[1].sha], area_counts: { web: 2 } }, commits: [{ ...c.snapshot.commits[1], subject: 'feat(web): sort every invoice list by due date by default, oldest first' }] };
    await expect(replayWith(story, one, storyReply())).rejects.toThrow('skip path');
  });
});

describe('changes-edition', () => {
  const day = editionCase('release-day');
  const flood = editionCase('branch-flood');

  test("each fixture posts prod's request, and a big day goes to the strong model", () => {
    for (const c of editions) expect(editionSurfaceRequest(c.snapshot)).toEqual(editionRequest(c.snapshot.input));
    expect(editionSurfaceRequest(day.snapshot).model).toBe(CHEAP_MODEL);
    expect(flood.snapshot.input.stories.length).toBeGreaterThan(40);
    expect(editionSurfaceRequest(flood.snapshot).model).toBe(STRONG_MODEL);
  });

  test('a good reply passes every gate and the lead check', async () => {
    const r = await replayWith(edition, day.snapshot, editionReply(), day.label);
    expect(r.gates).toEqual({ parse: true, lengths: true, 'known-refs': true, 'no-em-dash': true, 'no-leak': true });
    expect(r.checks).toEqual([expect.objectContaining({ id: 'lead', score: 1 })]);
    expect(r.out.reply).toContain('Lead: s1 Webhook deliveries now retry');
  });

  test('an unknown lead is unusable; an invented ref or area fails known-refs', async () => {
    expect((await replayWith(edition, day.snapshot, editionReply({ lead_story_key: 's99' }), day.label)).gates.parse).toBe(false);
    const r = await replayWith(edition, day.snapshot, editionReply({ section_order: ['api', 'payments'], brief_story_keys: ['s7', 's42'] }), day.label);
    expect(r.gates.parse).toBe(true);
    expect(r.gates['known-refs']).toBe(false);
    expect(r.evidence['known-refs']).toBe('names what the day does not have: story s42, area payments');
  });

  test('a long headline or a standfirst over 60 words fails lengths', async () => {
    for (const o of [{ edition_headline: 'h'.repeat(111) }, { standfirst: Array.from({ length: 61 }, () => 'word').join(' ') }]) {
      expect((await replayWith(edition, day.snapshot, editionReply(o), day.label)).gates.lengths).toBe(false);
    }
  });

  test('naming a person fails the leak gate: the edition input carries no names', async () => {
    const r = await replayWith(edition, flood.snapshot, editionReply({ edition_headline: 'Hana Sato lands the sync conflict fix', lead_story_key: 's1', section_order: [], brief_story_keys: [] }), flood.label);
    expect(r.gates['no-leak']).toBe(false);
    expect(r.evidence['no-leak']).toContain('person Hana Sato');
  });
});

describe('common', () => {
  test('idsIn reads session ids, short ids and PR numbers', () => {
    expect(idsIn('see jx7c6zk, CT-12 and #412, not ab#3')).toEqual(['jx7c6zk', 'ct-12', '#412']);
  });

  test('a real day is captured from a fixture-shaped file, and only from one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'changes-capture-'));
    const path = join(dir, 'codecast-day.json');
    writeFileSync(path, JSON.stringify({ asOf: '2026-10-02T23:00:00.000Z', snapshot: { input: { stories: [] } } }));
    const got = captureFromFile('changes-edition', `file:${path}`, 'forms');
    expect(got.snapshot).toEqual({ input: { stories: [] } });
    expect(got.asOf).toBe('2026-10-02T23:00:00.000Z');
    expect(got.subject).toEqual({ kind: 'changes-edition', id: 'codecast-day', title: 'changes-edition codecast-day' });
    expect(() => captureFromFile('changes-edition', 'jx7c6zk:12', 'forms')).toThrow('forms');
  });
});
