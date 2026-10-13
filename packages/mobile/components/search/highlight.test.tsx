// The phone marks a search's words the way the web does: the same terms
// (parseQueryTerms), in plain text and inside rendered markdown runs, with
// anything that is not text (a pill, a link) left alone.
import { beforeAll, expect, mock, test } from 'bun:test';
import React from 'react';

mock.module('react-native', () => ({
  View: 'View',
  Image: 'Image',
  Text: 'Text',
  TextInput: 'TextInput',
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default },
  StyleSheet: { create: <T,>(s: T) => s, flatten: (s: unknown) => s, hairlineWidth: 1 },
}));

let hl: typeof import('./highlight');
let RNText: typeof import('@/components/Themed').Text;

beforeAll(async () => {
  hl = await import('./highlight');
  RNText = (await import('@/components/Themed')).Text;
});

/** The marked stretches of a node list, in order. */
function marked(node: React.ReactNode): string[] {
  const out: string[] = [];
  const walk = (n: React.ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!React.isValidElement<{ style?: { backgroundColor?: string }; children?: React.ReactNode }>(n)) return;
    if (n.props.style?.backgroundColor && typeof n.props.children === 'string') out.push(n.props.children);
    else walk(n.props.children);
  };
  walk(node);
  return out;
}

test('plain text marks each word found, and a miss is the bare string', () => {
  expect(marked(hl.markedRuns('the caller pages miss live data', 'call page'))).toEqual(['call', 'page']);
  expect(hl.markedRuns('nothing here', 'zebra')).toBe('nothing here');
  expect(hl.markedRuns('anything', undefined)).toBe('anything');
});

test('markdown runs are marked inside their own styling; a pill passes through', () => {
  const Pill = () => null;
  const nodes = [
    <RNText key="a">open the call </RNText>,
    <RNText key="b" style={{ fontWeight: '700' }}>page</RNText>,
    <Pill key="c" />,
  ];
  const out = hl.markInlineNodes(nodes, 'call page');
  expect(marked(out)).toEqual(['call', 'page']);
  expect((out[1] as React.ReactElement<{ style: unknown }>).props.style).toEqual({ fontWeight: '700' });
  expect(out[2]).toBe(nodes[2]);
});
