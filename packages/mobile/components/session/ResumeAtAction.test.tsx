// The phone's Resume press on a run that stopped at Landing unknown or Land cut off (ResumeAtAction, shown on the run
// card and the run screen): a native button that resumes the run at Land (convex failedRunResume.resume), reads
// Resuming… while the server takes it, and says a refusal in the server's own words. Convex is faked.
import { beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import React from 'react';

const host = (name: string) => name;
mock.module('react-native', () => ({
  View: host('View'), Text: host('Text'), Pressable: host('Pressable'),
  StyleSheet: { create: <T,>(s: T) => s, flatten: (s: unknown) => s, hairlineWidth: 1 },
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default },
}));
mock.module('@/components/Themed', () => ({ Text: host('Text') }));
mock.module('@/constants/Theme', () => ({ CHROME_FONT_CAP: 1.3, useTheme: () => ({ blue: '#00f', red: '#f00' }) }));

const calls: { name: string; args: any }[] = [];
let answer: () => Promise<unknown> = async () => ({});
const realConvex = await import('convex/react');
const { getFunctionName } = await import('convex/server');
const { ConvexError } = await import('convex/values');
mock.module('convex/react', () => ({ ...realConvex, useMutation: (ref: any) => (args: any) => (calls.push({ name: getFunctionName(ref), args }), answer()) }));

let TestRenderer: typeof import('react-test-renderer');
let ResumeAtAction: typeof import('./ResumeAtAction').ResumeAtAction;
beforeAll(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const error = console.error;
  console.error = (...args: unknown[]) => { if (!String(args[0]).includes('react-test-renderer is deprecated')) error(...args); };
  TestRenderer = await import('react-test-renderer');
  ({ ResumeAtAction } = await import('./ResumeAtAction'));
});
beforeEach(() => { calls.length = 0; });

async function mount() {
  let r!: import('react-test-renderer').ReactTestRenderer;
  await TestRenderer.act(async () => { r = TestRenderer.create(<ResumeAtAction runId="run_1" resume={{ at: 'land', label: 'Land' }} />); });
  const press = () => r.root.findByProps({ testID: 'resume-at' });
  const words = () => press().findByType('Text' as any).props.children;
  const tap = () => TestRenderer.act(async () => { press().props.onPress(); await new Promise((x) => setTimeout(x, 0)); });
  const refused = () => r.root.findAllByProps({ testID: 'resume-at-refused' }).map((n) => [].concat(n.props.children).join(''));
  return { press, words, tap, refused };
}

test('Resume at Land resumes the run at Land and reads Resuming… while the server takes it', async () => {
  answer = () => new Promise(() => {});
  const m = await mount();
  expect(m.words()).toBe('Resume at Land');
  await m.tap();
  expect(calls).toEqual([{ name: 'failedRunResume:resume', args: { run_id: 'run_1', at: 'land' } }]);
  expect([m.words(), m.press().props.disabled]).toEqual(['Resuming…', true]);
  await m.tap();
  expect(calls.length).toBe(1);
});

test("a refusal says the server's own words under the press, which can be tried again", async () => {
  answer = async () => { throw new ConvexError("Only the run's owner resumes it"); };
  const m = await mount();
  await m.tap();
  expect(m.refused()).toEqual(["Could not resume: Only the run's owner resumes it"]);
  expect([m.words(), m.press().props.disabled]).toEqual(['Resume at Land', false]);
});
