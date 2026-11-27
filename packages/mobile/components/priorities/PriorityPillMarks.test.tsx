// A priority pill's lead: the owner's face, then the rank badge, or the
// target when the priority has no rank.
import { beforeAll, expect, mock, test } from 'bun:test';
import React from 'react';

const host = (name: string) => name;
mock.module('react-native', () => ({
  View: host('View'), Text: host('Text'), Image: host('Image'),
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
}));
mock.module('@expo/vector-icons/Feather', () => ({ default: host('Feather') }));
mock.module('@/components/Themed', () => ({ Text: host('Text') }));
mock.module('@/components/owners/OwnerFace', () => ({ PersonFace: host('PersonFace') }));

let TestRenderer: typeof import('react-test-renderer');
let marks: typeof import('./PriorityPillMarks');

beforeAll(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const error = console.error;
  console.error = (...args: unknown[]) => { if (!String(args[0]).includes('react-test-renderer is deprecated')) error(...args); };
  TestRenderer = await import('react-test-renderer');
  marks = await import('./PriorityPillMarks');
});

function render(row: { owner: string; owner_image: string | null; rank: number | null }) {
  let r!: import('react-test-renderer').ReactTestRenderer;
  TestRenderer.act(() => { r = TestRenderer.create(<marks.PriorityPillMarks row={row} />); });
  return r.root;
}

test('a ranked priority shows the owner face, then its rank in the badge', () => {
  const root = render({ owner: 'Sarah Chen', owner_image: 'https://img/sarah.png', rank: 3 });
  const face = root.findByType('PersonFace' as any);
  expect(face.props).toMatchObject({ name: 'Sarah Chen', image: 'https://img/sarah.png' });
  const badge = root.findByProps({ testID: 'priority-rank-badge' });
  expect(badge.findByType('Text' as any).props.children).toBe(3);
  expect(root.findAllByProps({ testID: 'priority-target' })).toHaveLength(0);
});

test('a priority with no rank wears the target in the badge place', () => {
  const root = render({ owner: 'Sarah Chen', owner_image: null, rank: null });
  expect(root.findByType('PersonFace' as any).props.image).toBeNull();
  expect(root.findAllByProps({ testID: 'priority-rank-badge' })).toHaveLength(0);
  expect(root.findByProps({ testID: 'priority-target' }).props.name).toBe('target');
});
