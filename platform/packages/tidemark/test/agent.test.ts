import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider, type Context, type FauxProviderRegistration } from '@mariozechner/pi-ai';

import { historySection, historyTools, memorySection, runScopedAgent, type ToolScoper } from '../src/agent';
import { asOfAt } from '../src/asof';
import { memoryRunStore } from '../src/stores/memory';
import { DAY, P, T0, ada, bram, viewerOf, world } from './helpers';

// Seeding long histories is slow on a loaded machine; the 5s default is too tight.
setDefaultTimeout(120_000);

let faux: FauxProviderRegistration;
beforeEach(() => {
  faux = registerFauxProvider({ models: [{ id: 'claude-sonnet-5-5' }] });
});
afterEach(() => faux.unregister());

/** Rendered blocks, counted by their closing tags (the note quotes an opening tag). */
const closings = (text: string) => text.split('[/block:').length - 1;

const run = { runId: 'run-1', agentId: 'helper', scope: ada, partition: P, reason: 'check_in' };

async function setup(profile = {}) {
  const w = world({ compress: { maxActivities: 3 } }, 220);
  await w.seedDays(ada, 200, 3);
  await w.seedDays(bram, 30, 3);
  await w.compress();
  const [tool] = historyTools(w.history, { run, viewer: viewerOf(ada), profile: { id: 'helper', ...profile }, clock: w.clock });
  const call = (args: Record<string, unknown>) => Promise.resolve(tool.run(args as never, { callId: 'c', charge: () => {}, remainingUsd: () => Infinity })).then((out) => (typeof out === 'string' ? out : (out.content as string)));
  return { w, tool, call };
}

describe('read_history', () => {
  test('is a read tool with every zoom verb in its schema', async () => {
    const { tool } = await setup();
    expect(tool.name).toBe('read_history');
    expect(tool.risk).toBe('read');
    expect(Object.keys((tool.parameters as { properties: object }).properties).sort()).toEqual(['from', 'item', 'lines', 'query', 'scope', 'to', 'zoom']);
  });

  test('no arguments reads the cover; item opens; zoom out goes coarser; from/to focuses; query searches', async () => {
    const { call } = await setup();
    const cover = await call({});
    expect(cover).toContain('## Older History (summary)');
    expect(cover).toContain('[block:b:0.199@person:ada');
    expect(await call({ item: 'b:5.0@person:ada' })).toContain('opened: the blocks it was written from');
    expect(await call({ item: 'b:0.7@person:ada' })).toContain('ada day 7 #1');
    expect(await call({ item: 'b:4.0@person:ada', zoom: 'out' })).toContain('[block:b:5.0@person:ada');
    const march = await call({ from: '2026-03-01', to: '2026-03-31', lines: 4 });
    expect(march).toContain('## Focus 2026-03-01 to 2026-03-31: summaries');
    // March is leaves [59, 90): four lines cannot tile it with aligned blocks, so the fewest that can (five) render.
    expect(closings(march)).toBe(5);
    expect(closings(await call({ from: '2026-03-01', to: '2026-03-31', lines: 8 }))).toBe(8);
    expect(await call({ query: 'day 12 #2' })).toContain('ada day 12 #2');
  });

  test('lines is clamped by the profile, and below by one', async () => {
    const { call } = await setup({ history: { maxCoverLines: 8 } });
    const blocks = closings;
    expect(blocks(await call({ from: '2026-01-01', to: '2026-07-01', lines: 500 }))).toBe(8);
    expect(blocks(await call({ from: '2026-01-01', to: '2026-07-01', lines: 0 }))).toBeGreaterThanOrEqual(1);
    expect(blocks(await call({ from: '2026-01-01', to: '2026-07-01', lines: -3 }))).toBeGreaterThanOrEqual(1);
    expect(blocks(await call({ from: '2026-01-01', to: '2026-07-01', lines: Number.NaN }))).toBeLessThanOrEqual(8);
    const { call: roomy } = await setup({ history: { coverLines: 12 } });
    expect(blocks(await roomy({ from: '2026-01-01', to: '2026-07-01' }))).toBe(12);
  });

  test('refusals come back as steering text, never as a thrown error', async () => {
    const { call } = await setup();
    expect(await call({ scope: 'person:bram' })).toBe('The scope person:bram is not readable from this run.');
    expect(await call({ item: 'b:0.0@person:bram' })).toContain('No history item');
    expect(await call({ scope: 'nonsense' })).toContain('is not a scope');
    expect(await call({ from: 'last tuesday' })).toContain('dates like 2026-03-01');
    expect(await call({ query: '   ' })).toBe(await call({}));
    expect(await call({ item: 's:note|1|2', zoom: 'out' })).toContain('works on a block or an entry');
  });

  test('a replayed run reads as of its instant, and to never reaches past it', async () => {
    const { w } = await setup();
    const past = { ...run, asOf: asOfAt(w.store, T0 + 50 * DAY) };
    const [tool] = historyTools(w.history, { run: past, viewer: viewerOf(ada), clock: w.clock });
    const result = await tool.run({ from: '2026-01-01', to: '2026-12-31' } as never, { callId: 'c', charge: () => {}, remainingUsd: () => Infinity });
    const out = typeof result === 'string' ? result : String(result.content);
    expect(out).toContain('day 49');
    expect(out).not.toContain('day 50 ');
    expect(out).not.toContain('day 120');
  });

  test('a host extension answers its own arguments first', async () => {
    const { w } = await setup();
    const [tool] = historyTools(w.history, {
      run,
      viewer: viewerOf(ada),
      extensions: [{ describe: 'emails: list recent emails.', run: async (args) => (args.emails ? 'three emails' : null) }],
    });
    expect(tool.description).toContain('emails: list recent emails.');
    expect(await tool.run({ emails: true } as never, { callId: 'c', charge: () => {}, remainingUsd: () => Infinity })).toBe('three emails');
  });
});

describe('runScopedAgent', () => {
  test('records the run, assembles context, lets the model zoom, and records every row', async () => {
    const { w } = await setup();
    await w.store.write({ agentId: 'helper', scope: ada, partition: P, header: 'likes tea', content: 'Green.', createdAtMs: T0 });
    const runs = memoryRunStore();
    let seen: Context | undefined;
    faux.setResponses([
      (context) => {
        seen = context;
        return fauxAssistantMessage([fauxText('Let me look closer.'), fauxToolCall('read_history', { item: 'b:4.0@person:ada' }, { id: 'call_1' })], { stopReason: 'toolUse' });
      },
      (context) => {
        const result = JSON.stringify(context.messages[context.messages.length - 1]);
        return fauxAssistantMessage(result.includes('opened: the blocks it was written from') ? 'Ada has been steady since January.' : 'the zoom failed');
      },
    ]);
    const result = await runScopedAgent({
      run,
      profile: { id: 'helper', history: { coverLines: 16 } },
      sections: [{ key: 'identity', tier: 'stable', render: () => 'You keep track of people.' }, memorySection(w.store, { clock: w.clock }), historySection(w.history, { viewer: viewerOf(ada) })],
      tools: historyTools(w.history, { run, viewer: viewerOf(ada) }),
      model: faux.getModel(),
      ceilingUsd: 1,
      deadlineMs: 30_000,
      runs,
      input: 'Time for the weekly check-in.',
      clock: w.clock,
    });
    expect(result.reason).toBe('done');
    expect(result.messages[result.messages.length - 1].content).toBe('Ada has been steady since January.');
    expect(seen!.systemPrompt).toContain('You keep track of people.\n\n## Memory');
    expect(seen!.systemPrompt).toContain('## Older History (summary)');
    expect(result.context.sizes.history).toBeGreaterThan(0);
    const record = runs.runs.get('run-1')!;
    expect(record.steps.length).toBe(result.messages.length);
    expect(record.end?.reason).toBe('done');
  });

  test('scopers withhold tools and state the fact instead', async () => {
    const { w } = await setup();
    const runs = memoryRunStore();
    let seen: Context | undefined;
    faux.setResponses([
      (context) => {
        seen = context;
        return fauxAssistantMessage('ok');
      },
    ]);
    const noHistory: ToolScoper = (_run, tools) => ({ tools: tools.filter((t) => t.name !== 'read_history'), facts: ['History lookups are off for this run; answer from the context above.'] });
    const result = await runScopedAgent({ run, profile: { id: 'helper' }, sections: [], tools: historyTools(w.history, { run, viewer: viewerOf(ada) }), scopers: [noHistory], model: faux.getModel(), ceilingUsd: 1, deadlineMs: 30_000, runs, input: 'hi', clock: w.clock });
    expect(result.context.facts).toEqual(['History lookups are off for this run; answer from the context above.']);
    expect(seen!.tools ?? []).toEqual([]);
    expect(seen!.systemPrompt).toContain('## This run\nHistory lookups are off');
  });

  test('a run cancelled in its store stops before its next model call and is recorded as cancelled', async () => {
    const { w } = await setup();
    const runs = memoryRunStore();
    const { defineTool, Type } = await import('@platform/agent');
    const slow = defineTool({ name: 'slow', description: 'Takes a while.', parameters: Type.Object({}), risk: 'read', run: async () => (await new Promise((r) => setTimeout(r, 300)), 'finished') });
    let calls = 0;
    faux.setResponses([
      () => (calls++, fauxAssistantMessage([fauxToolCall('slow', {}, { id: 'call_1' })], { stopReason: 'toolUse' })),
      () => (calls++, fauxAssistantMessage('should not be reached')),
    ]);
    const pending = runScopedAgent({ run, profile: { id: 'helper' }, sections: [], tools: [slow], model: faux.getModel(), ceilingUsd: 1, deadlineMs: 30_000, runs, input: 'hi', clock: w.clock, cancelPollMs: 10 });
    await new Promise((r) => setTimeout(r, 100));
    runs.cancel('run-1');
    const result = await pending;
    expect(result.reason).toBe('error');
    expect(calls).toBe(1);
    expect(runs.runs.get('run-1')!.end?.reason).toBe('cancelled');
  });
});
