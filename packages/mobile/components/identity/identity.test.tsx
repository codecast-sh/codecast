// Session faces on the phone (docs/architecture/session-characters.md S3).
// Rendered rather than asserted on JSX, because what matters is what reaches
// the screen: every avatar key draws its own file, a session nobody
// personified keeps the mark the surface drew before, a viewer with
// characters off sees a role's icon tile and title and no animal anywhere,
// and none of it brings a native library outside the baseline into the bundle.
import { beforeAll, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { AVATAR_KEYS } from '@codecast/shared/contracts/orgAvatars';
import { roleIdentity } from '@codecast/shared/contracts/orgIdentity';
import { ROLE_ICON_EXAMPLES } from '@codecast/shared/contracts/roleIconExamples';

// Host components only: a face is a View, an Image, or a role's tile drawn
// through SvgXml.
mock.module('react-native-svg', () => ({ SvgXml: 'SvgXml' }));
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

function setUI(patch: Record<string, unknown>) {
  TestRenderer.act(() => {
    useInboxStore.setState((s: any) => ({ ...s, clientState: { ...s.clientState, ui: { ...s.clientState?.ui, ...patch } } }));
  });
}
const setPersonifyAll = (on: boolean) => setUI({ personify_sessions: on });
const setCharacters = (on: boolean) => setUI({ show_characters: on });

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
  // The role's given name (org-staffing.md S30), never its title.
  expect(tree.root.findByProps({ testID: 'session-face-role-owl' }).props.accessibilityLabel).toBe(roleIdentity(ROLE).name);
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

// A teammate's role session reached from outside the inbox has only a thin
// session row; the role pointer rides the conversation row and the role's
// name and face live in the viewer's role rows (viewerRoles). The speaker is the role, not the agent.
test("an agent speaks as its role's given name, found through the conversation row and the role rows", () => {
  const HAZEL = {
    _id: 'r9', short_id: 'ro-9', name: 'Engineering Co-worker', handle: 'eng', avatar: 'hare', status: 'active', given_name: 'Hazel',
    scope: { project_ids: [] }, reports_to: { kind: 'user', user_id: 'u1' },
  };
  TestRenderer.act(() => {
    useInboxStore.setState((s: any) => ({
      ...s,
      sessions: { ...s.sessions, [ID]: { _id: ID, title: 'Fix the sync', agent_type: 'claude_code' } },
      conversations: { ...s.conversations, [ID]: { _id: ID, standing_role_id: 'r9' } },
      viewerRoles: { [HAZEL._id]: HAZEL },
    }));
  });
  function Speaker() {
    const row = identity.useSessionIdentityRow(ID);
    return <identity.MobileAgentSpeaker row={row} agentType="claude_code" size={16} mark={React.createElement('Text', null, 'dot')} />;
  }
  const tree = render(<Speaker />);
  expect(tree.root.findByProps({ testID: 'session-face-role-hare' })).toBeTruthy();
  const names = tree.root.findAllByType('Text' as never).map((t) => t.props.children);
  expect(names).toContain('Hazel');
  expect(names).not.toContain('dot');

  // A plain session keeps the agent's mark and product name.
  const plain = render(<identity.MobileAgentSpeaker row={{ _id: 'other' }} agentType="claude_code" mark={React.createElement('Text', null, 'dot')} />);
  expect(plain.root.findAllByType('Image' as never).length).toBe(0);
  expect(plain.root.findAllByType('Text' as never).map((t) => t.props.children)).toEqual(['dot', 'Claude']);
  TestRenderer.act(() => { tree.unmount(); plain.unmount(); });
  TestRenderer.act(() => {
    useInboxStore.setState((s: any) => {
      const { [ID]: _s, ...sessions } = s.sessions;
      const { [ID]: _c, ...conversations } = s.conversations;
      return { ...s, sessions, conversations, viewerRoles: {} };
    });
  });
});

// With characters off (show_characters, roleIcon.ts) a role wears its drawn
// icon on a tile and is named by its title; nothing else wears a face or an
// invented name.
const DB = ROLE_ICON_EXAMPLES[0];
const ICON_ROLE = { ...ROLE, name: DB.title, given_name: 'Hazel', icon: DB.icon };

test("characters off: a role draws its icon tile and is named by its title", () => {
  setCharacters(false);
  const tree = render(<identity.MobileSessionFace row={{ _id: ID, standing_role_id: 'r1', role: ICON_ROLE }} size={22} />);
  const face = tree.root.findByProps({ testID: `session-face-tile-${DB.icon.concept}` });
  expect(face.props.accessibilityLabel).toBe(DB.title);
  expect(tree.root.findAllByType('Image' as never).length).toBe(0);
  const svg = tree.root.findByType('SvgXml' as never);
  expect(String(svg.props.xml)).toStartWith('<svg');
  expect(svg.props.width).toBe(Math.round(22 * 0.76));

  // No icon yet: the title's first letter on the same tile.
  const bare = render(<identity.MobileSessionFace row={{ _id: ID, standing_role_id: 'r1', role: ROLE }} size={22} />);
  expect(bare.root.findByProps({ testID: 'role-tile-monogram' })).toBeTruthy();
  expect(bare.root.findAllByType('SvgXml' as never).length).toBe(0);
  expect(JSON.stringify(bare.toJSON())).toContain('"G"');

  const line = render(<identity.MobileSessionIdentityLine row={{ _id: ID, standing_role_id: 'r1', role: ICON_ROLE }} title="Fix the sync" />);
  const text = JSON.stringify(line.toJSON());
  expect(text).toContain(DB.title);
  expect(text).not.toContain('Hazel');
  setCharacters(true);
});

test('characters off: a personified session renders plain, even with personify-all on', () => {
  setCharacters(false);
  setPersonifyAll(true);
  const face = render(<identity.MobileIdentityFace row={{ _id: ID, character_avatar: 'otter' }} fallback={React.createElement('Text', null, 'chip')} />);
  expect(face.root.findAllByType('Image' as never).length).toBe(0);
  expect(face.root.findByType('Text' as never).props.children).toBe('chip');
  // A face drawn outright (a preview) has nothing to draw but its badge.
  expect(render(<identity.MobileSessionFace row={{ _id: ID, character_avatar: 'otter' }} size={18} />).toJSON()).toBeNull();
  const line = JSON.stringify(render(<identity.MobileSessionIdentityLine row={{ _id: ID, character_avatar: 'fox', character_name: 'Juniper' }} title="Fix the sync" />).toJSON());
  expect(line).toContain('Fix the sync');
  expect(line).not.toContain('Juniper');
  const speaker = render(<identity.MobileAgentSpeaker row={{ _id: ID, character_avatar: 'fox', character_name: 'Juniper' }} agentType="claude_code" mark={React.createElement('Text', null, 'dot')} />);
  expect(speaker.root.findAllByType('Text' as never).map((t) => t.props.children)).toEqual(['dot', 'Claude']);
  setPersonifyAll(false);
  setCharacters(true);
});

test("an escalation's partial role finds its icon in the viewer's role rows", async () => {
  const { RoleFace } = await import('../org/RoleFace');
  TestRenderer.act(() => {
    useInboxStore.setState((s: any) => ({ ...s, viewerRoles: { [ICON_ROLE._id]: ICON_ROLE } }));
  });
  const partial = { short_id: ROLE.short_id, handle: ROLE.handle, name: DB.title, avatar: 'owl' };
  const on = render(<RoleFace role={partial} size={16} />);
  expect(on.root.findByProps({ testID: 'session-face-role-owl' })).toBeTruthy();
  setCharacters(false);
  const off = render(<RoleFace role={partial} size={16} />);
  expect(off.root.findByProps({ testID: `session-face-tile-${DB.icon.concept}` })).toBeTruthy();
  setCharacters(true);
  TestRenderer.act(() => { useInboxStore.setState((s: any) => ({ ...s, viewerRoles: {} })); });
});

// A session row cached before roles had icons carries a role snapshot with no
// `icon`; the face reads the icon from the role rows, its one home.
test('a stale role snapshot still draws the role\'s icon from the role rows', () => {
  TestRenderer.act(() => {
    useInboxStore.setState((s: any) => ({ ...s, viewerRoles: { [ICON_ROLE._id]: ICON_ROLE } }));
  });
  setCharacters(false);
  const tree = render(<identity.MobileSessionFace row={{ _id: ID, standing_role_id: 'r1', role: ROLE }} size={22} />);
  expect(tree.root.findByProps({ testID: `session-face-tile-${DB.icon.concept}` }).props.accessibilityLabel).toBe(DB.title);
  setCharacters(true);
  TestRenderer.act(() => { useInboxStore.setState((s: any) => ({ ...s, viewerRoles: {} })); });
});

// The Sep 14 crash came from two copies of a native library in one bundle. A
// face is an Image of a WebP file, a role's tile an SvgXml: this folder may
// import React Native, react-native-svg (in the frozen baseline, resolved from
// the app root), the app's own modules and the shared packages, and nothing else.
test('identity components bring no native library of their own', () => {
  const allowed = /^(react|react-native|react-native-svg|@\/.+|@codecast\/(web|shared)\/.+|\.\/.+)$/;
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
