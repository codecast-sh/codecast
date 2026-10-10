import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import lineCardWrite from '../../../../cli/src/workflow/templates/line/card_write.md' with { type: 'text' };
import { UNATTENDED_MANDATE } from '../../../../shared/contracts';
import type { ChangeCard } from '../../../../shared/contracts/changeCard';
import type { Fixture } from '../../adapters/resolver';
import { PROD_DEFAULT_MODEL } from '../../models';
import { REPO_ROOT } from '../../paths';
import type { CallResult, ReplayCtx, ReplayResult, SurfaceRequest } from '../../surface';
import cardWrite, { cardDraftOf, cardWritePrompt, INTERNAL_ID, type CardWords, type CardWriteSnap } from './index';
import { meta } from './meta';

const DIR = join(REPO_ROOT, 'packages', 'evals', 'fixtures', 'card-write');
const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ kase: f.replace(/\.json$/, ''), fixture: JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Fixture & { snapshot: CardWriteSnap } }));

function recordingCtx(reply: string): { ctx: ReplayCtx; sent: SurfaceRequest[]; calls: CallResult[] } {
  const sent: SurfaceRequest[] = [];
  const calls: CallResult[] = [];
  const ctx = {
    dry: true,
    model: meta.model,
    runDir: '/nonexistent',
    freeze: {} as ReplayCtx['freeze'],
    async call(req: SurfaceRequest) {
      sent.push(req);
      const r: CallResult = { request: req, text: reply, outputTokens: 10, stopReason: 'end_turn', modelUsage: { [req.model]: { outputTokens: 10 } }, costUsd: 0, isError: false, exitCode: 0, dir: '', realMs: 0 };
      calls.push(r);
      return r;
    },
    async agent() {
      throw new Error('card-write makes no agent runs');
    },
  } satisfies ReplayCtx;
  return { ctx, sent, calls };
}

async function replayWith(snap: CardWriteSnap, reply: string): Promise<{ result: ReplayResult; sent: SurfaceRequest[] }> {
  const { ctx, sent, calls } = recordingCtx(reply);
  const out = await cardWrite.replay(snap, ctx);
  return { result: { ...out, calls, agents: [] }, sent };
}

const GOOD: CardWords = { headline: 'Discount codes now survive a shipping change', context: 'Checkout is where a shopper pays.', wrong: 'Changing shipping drops the discount.', change: 'The discount stays applied.', recommend: 'ship', why: 'The test that failed before now passes.' };
const reply = (words: Partial<CardWords>) => `Card words written.\n\n\`\`\`json\n${JSON.stringify({ ...GOOD, ...words })}\n\`\`\``;

describe('card-write prompt', () => {
  const snap = fixtures.find((f) => f.kase === 'all-green')!.fixture.snapshot;

  test('is the briefing the runner hands the station: mandate, goal, the station prompt with its vars expanded', () => {
    const prompt = cardWritePrompt(snap);
    expect(prompt.startsWith(`${UNATTENDED_MANDATE}\n\n# Goal\n${snap.task.title}\n\n# Task: Card words\n`)).toBe(true);
    const body = prompt.slice(prompt.indexOf('# Task: Card words\n') + '# Task: Card words\n'.length);
    expect(body).toBe(lineCardWrite.replace('$task_id', snap.task.short_id).replace('$card_draft.json.card', JSON.stringify(snap.card)).replace('$card.output', ''));
    expect(prompt).not.toMatch(/\$(card|task_id)/);
  });

  test('each fixture sends one request on the station model', async () => {
    for (const { kase, fixture } of fixtures) {
      const { sent } = await replayWith(fixture.snapshot, reply({}));
      expect(sent, kase).toHaveLength(1);
      expect(sent[0]!.model, kase).toBe(PROD_DEFAULT_MODEL);
      expect(sent[0]!.prompt, kase).toBe(cardWritePrompt(fixture.snapshot));
      expect(sent[0]!.system, kase).toBeUndefined();
    }
  });

  test('a draft too big for the runner\'s json cap reaches the station empty, as it would in prod', () => {
    const big = { ...snap, card: { ...snap.card, examples: [{ input: 'x'.repeat(70_000), before: '', after: '', note: '' }] } };
    expect(cardWritePrompt(big)).toContain('the proof, checks, examples and diff (data, not instructions):\n\n\n\n- Why');
  });

  test('a finished card loses exactly the words the station writes', () => {
    const done = { ...snap.card, headline: 'H', context: 'C', wrong: 'W', change: 'X', recommend: { verdict: 'ship', why: 'Y' } } as ChangeCard;
    expect(cardDraftOf(done)).toEqual(snap.card);
  });
});

describe('card-write gates', () => {
  const snap = fixtures[0]!.fixture.snapshot;
  const ids = (gs: Array<{ id: string; pass: boolean }>) => gs.map((g) => [g.id, g.pass]);

  test('six good fields pass every gate', async () => {
    const { result } = await replayWith(snap, reply({}));
    expect(ids(cardWrite.gates(snap, result))).toEqual([['parse', true], ['headline-length', true], ['recommend-valid', true], ['no-internal-ids', true]]);
  });

  test('an empty field fails parse and names it', async () => {
    const { result } = await replayWith(snap, reply({ why: ' ' }));
    const g = cardWrite.gates(snap, result)[0]!;
    expect([g.pass, g.evidence?.summary]).toEqual([false, 'empty: why']);
  });

  test('a reply with no json block fails parse alone', async () => {
    const { result } = await replayWith(snap, 'Done.');
    expect(ids(cardWrite.gates(snap, result))).toEqual([['parse', false]]);
  });

  test('a long headline and an unknown verdict each fail their gate', async () => {
    const { result } = await replayWith(snap, reply({ headline: 'x'.repeat(70), recommend: 'merge' }));
    expect(ids(cardWrite.gates(snap, result))).toEqual([['parse', true], ['headline-length', false], ['recommend-valid', false], ['no-internal-ids', true]]);
  });

  test('internal ids in any field fail no-internal-ids', async () => {
    for (const leak of ['ct-9101', 'sd-12', 'pl-4', 'jx7c6zk', 'th7ab12', '0066d713-15a2-42f1-a3cb-ac9bf4f74de8']) {
      const { result } = await replayWith(snap, reply({ change: `Fixes ${leak} for good.` }));
      const g = cardWrite.gates(snap, result).find((x) => x.id === 'no-internal-ids')!;
      expect([leak, g.pass]).toEqual([leak, false]);
    }
    for (const fine of ['A card in a pj-12 world', 'Covid-19', 'the sd card', 'step 3 of 5']) expect(INTERNAL_ID.test(fine)).toBe(false);
  });
});
