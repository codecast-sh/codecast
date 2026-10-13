import type { ConvoMessage } from '@platform/evals';

import { STRONG_MODEL } from './models';
import type { SurfaceImpl, SurfaceMeta } from './surface';

// `echo`: a surface for tests only (registered when CODECAST_EVALS_TEST=1).
// Its replay sends the fixture's text through ctx.call and passes when the
// reply equals it, which a --dry call always does; a fixture with
// `crash: true` throws before calling, for the crash-streak test.

export const echoMeta: SurfaceMeta = {
  id: 'echo',
  title: 'Echo (tests only)',
  route: 'call',
  // A model the replay can send as prod does; a test names another to see how check treats it.
  model: process.env.CODECAST_EVALS_TEST_ECHO_MODEL || STRONG_MODEL,
  sources: ['packages/evals/src/testSurface.ts'],
  reps: { check: 2 },
  maxUsdPerRep: 0.001,
  criteria: null,
};

interface EchoSnap {
  text: string;
  crash?: boolean;
}

export const echoImpl: SurfaceImpl = {
  refForms: 'echo@ takes only fixtures, like echo@fixture:a',
  async capture() {
    throw new Error('echo takes only fixtures, like echo@fixture:a');
  },
  async replay(snap: EchoSnap, ctx) {
    if (snap.crash) throw new Error('echo was told to crash');
    const r = await ctx.call({ model: ctx.model, prompt: snap.text, max_tokens: 50, temperature: 0 });
    return { reply: r.text };
  },
  gates(snap: EchoSnap, out) {
    const pass = out.reply === snap.text;
    return [{ id: 'echoed', pass, decidedBy: 'mechanical', evidence: { summary: pass ? 'the reply is the prompt' : `the reply differs: ${out.reply.slice(0, 80)}` } }];
  },
  describe(snap: EchoSnap): ConvoMessage[] {
    return [{ n: 1, id: 'echo-1', at: '2026-01-01T00:00:00.000Z', channel: 'session', isGroup: false, direction: 'in', from: 'user', text: snap.text }];
  },
  productionReply: () => null,
};
