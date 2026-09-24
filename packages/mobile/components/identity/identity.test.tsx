// Session faces on the phone (docs/architecture/session-characters.md S3).
// Rendered rather than asserted on JSX, because what matters is what reaches
// the screen: every avatar key draws its own file, a session nobody
// personified keeps the mark the surface drew before,
// and none of it brings a native library of its own into the bundle.
import { beforeAll, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { AVATAR_KEYS } from '@codecast/shared/contracts/orgAvatars';

// Host components only: a face is a View, an Image and nothing native.
mock.module('react-native', () => ({
  View: 'View',
  Image: 'Image',
  Text: 'Text',
  TextInput: 'TextInput',
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default },
  StyleSheet: { create: <T,>(s: T) => s, flatten: (s: unknown) => s, hairlineWidth: 1 },
}));

let TestRenderer: typeof import('react-test-renderer');
let identity: typeof import('./index');
let useInboxStore: typeof import('@codecast/web/store/inboxStore').useInboxStore;

beforeAll(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  // react-test-renderer prints a deprecation line on every create.
  const error = console.error;
  console.error = (...args: unknown[]) => { if (!String(args[0]).includes('react-test-renderer is deprecated')) error(...args); };
  TestRenderer = await import('react-test-renderer');
  identity = await import('./index');
  ({ useInboxStore } = await import('@codecast/web/store/inboxStore'));
  // The store import is the slow part on a loaded machine.
}, 120_000);

const ID = 'k97xcyp74gaa0q43my0mpnvnsd8ekyj4';
const ROLE = { _id: 'r1', short_id: 'ro-1', name: 'Growth', handle: 'growth', avatar: 'owl', status: 'active', tenure_kind: 'standing' as const };

function render(node: React.ReactElement) {
  let tree!: import('react-test-renderer').ReactTestRenderer;
  TestRenderer.act(() => { tree = TestRenderer.create(node); });
  return tree;
}

function setPersonifyAll(on: boolean) {
  TestRenderer.act(() => {
    useInboxStore.setState((s: any) => ({ ...s, clientState: { ...s.clientState, ui: { ...s.clientState?.ui, personify_sessions: on } } }));
  });
}

test('every avatar key draws its own file', () => {
  const sources = new Set<unknown>();
  for (const key of AVATAR_KEYS) {
    const tree = render(<identity.MobileSessionFace row={{ _id: ID, character_avatar: key }} size={24} />);
    const image = tree.root.findByType('Image' as never);
    expect(String(image.props.source)).toContain(`${key}`);
    expect(image.props.style).toMatchObject({ width: 24, height: 24, borderRadius: 12 });
    expect(tree.root.findByProps({ testID: `session-face-character-${key}` })).toBeTruthy();
    sources.add(image.props.source);
  }
  expect(sources.size).toBe(AVATAR_KEYS.length);
});

test("a role's standing session wears the role's face, with no ring", () => {
  const tree = render(<identity.MobileSessionFace row={{ _id: ID, standing_role_id: 'r1', role: ROLE }} size={22} />);
  expect(tree.root.findByProps({ testID: 'session-face-role-owl' }).props.accessibilityLabel).toBe('Growth');
  expect(tree.root.findAllByType('View' as never).some((v) => v.props.style?.borderColor)).toBe(false);
});

test('a badge is skipped under 16 px', () => {
  const small = render(<identity.MobileSessionFace row={{ _id: ID, character_avatar: 'fox' }} size={12} badge={<identity.MobileSessionFace row={{ _id: ID }} size={4} />} />);
  expect(small.root.findAllByType('Image' as never).length).toBe(1);
  const big = render(<identity.MobileSessionFace row={{ _id: ID, character_avatar: 'fox' }} size={18} badge={<identity.MobileSessionFace row={{ _id: ID }} size={4} />} />);
  expect(big.root.findAllByType('Image' as never).length).toBe(2);
});

test('a session nobody personified keeps the mark the surface drew before', () => {
  setPersonifyAll(false);
  const plain = render(<identity.MobileIdentityFace row={{ _id: ID }} fallback={React.createElement('Text', null, 'chip')} />);
  expect(plain.root.findAllByType('Image' as never).length).toBe(0);
  expect(plain.root.findByType('Text' as never).props.children).toBe('chip');

  const chosen = render(<identity.MobileIdentityFace row={{ _id: ID, character_avatar: 'otter' }} fallback={React.createElement('Text', null, 'chip')} />);
  expect(chosen.root.findByProps({ testID: 'session-face-character-otter' })).toBeTruthy();

  // The workspace switch gives every session a face, the same default the web draws.
  setPersonifyAll(true);
  const all = render(<identity.MobileIdentityFace row={{ _id: ID }} fallback={React.createElement('Text', null, 'chip')} />);
  expect(all.root.findAllByType('Image' as never).length).toBe(1);
  setPersonifyAll(false);
});

test('the title line leads with the name once personified, and is the bare title otherwise', () => {
  const text = (tree: import('react-test-renderer').ReactTestRenderer) => JSON.stringify(tree.toJSON());
  const plain = text(render(<identity.MobileSessionIdentityLine row={{ _id: ID }} title="Fix the sync" />));
  expect(plain).toContain('Fix the sync');
  const named = render(<identity.MobileSessionIdentityLine row={{ _id: ID, character_avatar: 'fox', character_name: 'Juniper' }} title="Fix the sync" />);
  const outer = named.root.findAllByType('Text' as never)[0];
  expect([outer.props.children].flat()[0]).toBe('Juniper');
  expect(text(named)).toContain(': Fix the sync');
});

// The Sep 14 crash came from two copies of a native library in one bundle. A
// face is an Image of a WebP file: this folder may import React Native itself,
// the app's own modules and the shared packages, and nothing else.
test('identity components bring no native library of their own', () => {
  const allowed = /^(react|react-native|@\/.+|@codecast\/(web|shared)\/.+|\.\/.+)$/;
  const offenders: string[] = [];
  for (const file of fs.readdirSync(import.meta.dir)) {
    if (!/\.tsx?$/.test(file) || /\.test\./.test(file)) continue;
    const src = fs.readFileSync(path.join(import.meta.dir, file), 'utf8');
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (!allowed.test(m[1])) offenders.push(`${file}: ${m[1]}`);
    }
  }
  expect(offenders).toEqual([]);
});
