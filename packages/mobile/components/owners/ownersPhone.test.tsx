// The owners model on the phone, driven by presses: every owners change shows
// the undo bar with an Undo that puts it back; Add me in the agents list puts
// the session in your inbox at once;
// "With <owner>" shows only while the row reads working; and a row off the
// model reads nothing of the owners.
import { beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import React from 'react';

// Host components only. The keyboard's listeners, for the undo bar's anchor.
const keyboard = new Map<string, () => void>();
const host = (name: string) => name;
mock.module('react-native', () => ({
  View: host('View'), Text: host('Text'), TextInput: host('TextInput'), Image: host('Image'), ScrollView: host('ScrollView'),
  TouchableOpacity: host('TouchableOpacity'), Pressable: host('Pressable'),
  Animated: { View: host('AnimatedView'), Value: class { setValue() {} interpolate() { return 0; } }, timing: () => ({ start() {} }), spring: () => ({ start() {} }) },
  PanResponder: { create: () => ({ panHandlers: {} }) },
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default },
  Dimensions: { get: () => ({ width: 402, height: 874 }) },
  Keyboard: { addListener: (event: string, fn: () => void) => { keyboard.set(event, fn); return { remove: () => keyboard.delete(event) }; } },
  StyleSheet: { create: <T,>(s: T) => s, flatten: (s: unknown) => s, hairlineWidth: 1, absoluteFillObject: {} },
}));
mock.module('expo-haptics', () => ({ impactAsync: () => {}, ImpactFeedbackStyle: { Light: 'light' } }));
// A focused screen: the effect runs on mount and its cleanup on unmount (blur).
mock.module('expo-router', () => ({ router: { push: () => {} }, useFocusEffect: (fn: () => (() => void) | void) => React.useEffect(fn, [fn]) }));
mock.module('@expo/vector-icons/FontAwesome', () => ({ default: host('FontAwesome') }));
mock.module('@expo/vector-icons/Feather', () => ({ default: host('Feather') }));
mock.module('react-native-svg', () => ({ SvgXml: host('SvgXml') }));
mock.module('@/components/Themed', () => ({ Text: host('Text'), TextInput: host('TextInput') }));
mock.module('@/components/org/RoleFace', () => ({ RoleFace: host('RoleFace') }));
mock.module('@/components/AgentLogo', () => ({ AgentLogoSvg: host('AgentLogoSvg') }));
mock.module('@/components/chat/ImageViewer', () => ({ ImageViewer: host('ImageViewer') }));
mock.module('@/lib/gestureHandler', () => ({ gestureHandler: () => null }));
mock.module('@/components/identity', () => ({
  MobileSessionFace: host('MobileSessionFace'), MobileIdentityFace: host('MobileIdentityFace'),
  MobileSessionIdentityLine: host('MobileSessionIdentityLine'), useSessionIdentityRow: () => null,
}));

let TestRenderer: typeof import('react-test-renderer');
let store: typeof import('@codecast/web/store/inboxStore');
let lines: typeof import('../session/OwnerComposerLines');
let agentsList: typeof import('../session/SessionAgentsList');
let item: typeof import('../SessionItem');
let undo: typeof import('@/lib/undoBar');
let read: typeof import('@codecast/web/hooks/useSyncSessionOwners');
let census: typeof import('@codecast/web/store/storeListenerCensus');
let engine: typeof import('@platform/engine');
let faces: typeof import('./OwnerFace');
let anchor: typeof import('@/hooks/useUndoBarAnchor');

beforeAll(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const error = console.error;
  console.error = (...args: unknown[]) => { if (!String(args[0]).includes('react-test-renderer is deprecated')) error(...args); };
  TestRenderer = await import('react-test-renderer');
  store = await import('@codecast/web/store/inboxStore');
  lines = await import('../session/OwnerComposerLines');
  agentsList = await import('../session/SessionAgentsList');
  item = await import('../SessionItem');
  undo = await import('@/lib/undoBar');
  read = await import('@codecast/web/hooks/useSyncSessionOwners');
  census = await import('@codecast/web/store/storeListenerCensus');
  engine = await import('@platform/engine');
  faces = await import('./OwnerFace');
  anchor = await import('@/hooks/useUndoBarAnchor');
}, 120_000);

const S = 's'.repeat(32);
const CHILD = 'c'.repeat(32);
const ME = 'u_me';
const ASHOT = 'u_ashot';
const ROLE = { role_id: 'r_hooks', short_id: 'rl-1', handle: 'webhooks', name: 'Webhooks lead' };
const owner = {};
const person = (id: string, t: number) => ({ user_id: id, name: id === ME ? 'Alex Rivera' : 'Ashot Petrosian', email: null, added_by: ME, added_at: t });
const ownersRead = (id: string, people: unknown[], over: Record<string, unknown> = {}) => ({
  session_owners: true, conversation_id: id, people, role: null, parent_session: null, implicit_starter: null, starter_id: ASHOT, role_started: false, can_edit: true, owners_changed_at: 1, ...over,
});
const row = (id: string, over: Record<string, unknown> = {}) => ({ _id: id, session_id: id, title: 'Retry failed webhooks', user_id: ASHOT, updated_at: Date.now(), message_count: 3, owners_model: true, owned_by_me: false, ...over });

const mounted: import('react-test-renderer').ReactTestRenderer[] = [];
function render(node: React.ReactElement) {
  let tree!: import('react-test-renderer').ReactTestRenderer;
  TestRenderer.act(() => { tree = TestRenderer.create(node); });
  mounted.push(tree);
  return tree;
}
const press = (tree: import('react-test-renderer').ReactTestRenderer, testID: string) => TestRenderer.act(() => { tree.root.findByProps({ testID }).props.onPress(); });
const st = () => store.useInboxStore.getState() as any;
const inMyInbox = (id: string) => id in store.filterInboxScopeFromState(st());
const bar = () => undo.useUndoBar.getState().item;

beforeEach(() => {
  for (const tree of mounted.splice(0)) TestRenderer.act(() => tree.unmount());
  engine._resetUndoStacks();
  undo.useUndoBar.setState({ item: null, heldKillId: null });
  store.useInboxStore.setState({ currentUser: { _id: ME, name: 'Alex Rivera' }, pending: {}, sessionOwners: {}, sessionAgents: {}, sessions: { [S]: row(S) }, conversations: {} } as any);
  st()._setDispatch(async () => null, { owner });
});

test('Take it over removes the role at once, shows Undo, and Undo brings the role back', () => {
  read.applySessionOwnersRead(S, ownersRead(S, [person(ME, 1)], { role: ROLE }));
  const tree = render(<lines.ComposerOwnerStrip conversationId={S} active />);
  press(tree, 'composer-take-over');
  expect(st().sessionOwners[S].role).toBeNull();
  expect(bar()?.title).toBe('Webhooks lead removed');
  TestRenderer.act(() => { bar()!.onUndo!(); });
  expect(st().sessionOwners[S].role?.role_id).toBe(ROLE.role_id);
});

test('Add me in the agents list puts the agent in your inbox at once, with Undo', () => {
  store.useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [CHILD]: row(CHILD, { title: 'Upgrade Stripe SDK' }) } }));
  read.applySessionOwnersRead(S, ownersRead(S, [person(ME, 1)]));
  read.applySessionOwnersRead(CHILD, ownersRead(CHILD, [], { parent_session: { conversation_id: S, short_id: 's1', title: 'Retry failed webhooks' } }));
  st().syncTable('sessionAgents', [{ _id: S, agents: [{ _id: CHILD, short_id: 'c1', title: 'Upgrade Stripe SDK', agent_status: 'working', updated_at: 1, message_count: 1, owned_by_parent: true, owners: [] }] }]);
  const tree = render(<agentsList.SessionAgentsList conversationId={S} />);
  TestRenderer.act(() => { tree.root.findByProps({ accessibilityRole: 'button', accessibilityLabel: '1 agent, 1 working' }).props.onPress(); });
  expect(inMyInbox(CHILD)).toBe(false);
  press(tree, `agent-add-me-${CHILD}`);
  expect(inMyInbox(CHILD)).toBe(true);
  expect(tree.root.findAllByProps({ testID: `agent-unwatch-${CHILD}` }).length).toBeGreaterThan(0);
  expect(bar()?.onUndo).toBeTruthy();
});

const rowTree = (session: Record<string, unknown>) => render(
  <item.InboxRowEnvProvider><item.SessionItem session={session as never} onPress={() => {}} /></item.InboxRowEnvProvider>,
);

test('"With @role" shows only while the row reads working, by web\'s rule: not once done, not while your send is pending', () => {
  const working = row(S, { owned_by_me: true, org_role_id: ROLE.role_id, agent_status: 'working', is_idle: false, status: 'active', last_heartbeat: Date.now() });
  store.useInboxStore.setState({ sessions: { [S]: working } } as any);
  read.applySessionOwnersRead(S, ownersRead(S, [person(ME, 1)], { role: ROLE }));
  expect(rowTree(working).root.findAllByProps({ testID: 'row-with-owner' }).length).toBeGreaterThan(0);
  const done = { ...working, agent_status: 'done', is_idle: true, status: 'completed', updated_at: Date.now() - 3 * 3600_000 };
  store.useInboxStore.setState({ sessions: { [S]: done } } as any);
  expect(rowTree(done).root.findAllByProps({ testID: 'row-with-owner' }).length).toBe(0);
  // A send of yours queued locally (the outbox), not the server's flag.
  store.useInboxStore.setState({ sessions: { [S]: working }, sessionsWithQueuedMessages: new Set([S]) } as any);
  expect(rowTree(working).root.findAllByProps({ testID: 'row-with-owner' }).length).toBe(0);
  store.useInboxStore.setState({ sessionsWithQueuedMessages: new Set() } as any);
});

test('a row off the model mounts nothing of the owners and adds no subscription for them', () => {
  const plain = { ...row(S), owners_model: undefined };
  store.useInboxStore.setState({ sessions: { [S]: plain } } as any);
  const before = census.readStoreListenerCount() ?? 0;
  const off = rowTree(plain);
  const offCost = (census.readStoreListenerCount() ?? 0) - before;
  TestRenderer.act(() => off.unmount());
  mounted.splice(mounted.indexOf(off), 1);

  const on = row(S, { owned_by_me: true });
  store.useInboxStore.setState({ sessions: { [S]: on } } as any);
  const before2 = census.readStoreListenerCount() ?? 0;
  const onTree = rowTree(on);
  const onCost = (census.readStoreListenerCount() ?? 0) - before2;
  // Under the model: its faces and its With line, one subscription each.
  expect(onCost - offCost).toBe(2);
  TestRenderer.act(() => onTree.unmount());
});

test('an open list of 25 agents scrolls inside a 180pt cap', () => {
  read.applySessionOwnersRead(S, ownersRead(S, [person(ME, 1)]));
  const agents = Array.from({ length: 25 }, (_, i) => ({ _id: `a${String(i).padStart(31, '0')}`, short_id: `a${i}`, title: `Agent ${i}`, agent_status: 'working', updated_at: i, message_count: 1, owned_by_parent: true, owners: [] }));
  st().syncTable('sessionAgents', [{ _id: S, agents }]);
  const tree = render(<agentsList.SessionAgentsList conversationId={S} />);
  TestRenderer.act(() => { tree.root.findByProps({ accessibilityRole: 'button', accessibilityLabel: '25 agents, 25 working' }).props.onPress(); });
  const list = tree.root.findByProps({ testID: 'session-agents-list' });
  expect(list.props.style).toMatchObject({ maxHeight: 180 });
  expect(list.findAll((n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('session-agent-a')).length).toBe(25);
});

test('a role-owned row lifted into Questions by a pending blocking decide draws no "With" line', () => {
  const working = row(S, { owned_by_me: true, org_role_id: ROLE.role_id, agent_status: 'working', is_idle: false, status: 'active', last_heartbeat: Date.now() });
  store.useInboxStore.setState({
    sessions: { [S]: working }, sessionsWithQueuedMessages: new Set(), pendingMessages: {},
    sessionDecisions: { d1: { _id: 'd1', conversation_id: S, status: 'pending', blocking: true, question: 'Ship it?' } },
  } as any);
  read.applySessionOwnersRead(S, ownersRead(S, [person(ME, 1)], { role: ROLE }));
  // The list's placement: the chokepoint the inbox renders from.
  const placed = store.placeInboxRows(st(), { scope: 'mine' }).placements.get(S)!;
  expect(placed.bucket).toBe('questions');
  const tree = render(
    <item.InboxRowEnvProvider>
      <item.SessionItem session={working as never} onPress={() => {}} placedBucket={placed.bucket} placedState={placed.work_state} pendingSend={false} />
    </item.InboxRowEnvProvider>,
  );
  expect(tree.root.findAllByProps({ testID: 'row-with-owner' }).length).toBe(0);
  store.useInboxStore.setState({ sessionDecisions: {} } as any);
});

test('a row with no detail line ends at its owner, with no separator after it', () => {
  const working = row(S, { owned_by_me: true, org_role_id: ROLE.role_id, agent_status: 'working', is_idle: false, status: 'active', last_heartbeat: Date.now() });
  store.useInboxStore.setState({ sessions: { [S]: working } } as any);
  read.applySessionOwnersRead(S, ownersRead(S, [person(ME, 1)], { role: ROLE }));
  const text = JSON.stringify(rowTree(working).root.findByProps({ testID: 'row-with-owner' }).props.children);
  expect(text).not.toContain(' · ');
});

test('a row in a list that places nothing draws no "With" while a pending decide waits on you', () => {
  const working = row(S, { owned_by_me: true, org_role_id: ROLE.role_id, agent_status: 'working', is_idle: false, status: 'active', last_heartbeat: Date.now() });
  store.useInboxStore.setState({
    sessions: { [S]: working }, sessionsWithQueuedMessages: new Set(), pendingMessages: {},
    sessionDecisions: { d1: { _id: 'd1', conversation_id: S, status: 'pending', blocking: true, question: 'Ship it?' } },
  } as any);
  read.applySessionOwnersRead(S, ownersRead(S, [person(ME, 1)], { role: ROLE }));
  expect(rowTree(working).root.findAllByProps({ testID: 'row-with-owner' }).length).toBe(0);
  store.useInboxStore.setState({ sessionDecisions: {} } as any);
  expect(rowTree(working).root.findAllByProps({ testID: 'row-with-owner' }).length).toBeGreaterThan(0);
});

test("a row's owner faces read as one element: the owners line once, not each face's name again", () => {
  const working = row(S, { owned_by_me: true, org_role_id: ROLE.role_id });
  store.useInboxStore.setState({ sessions: { [S]: working } } as any);
  read.applySessionOwnersRead(S, ownersRead(S, [person(ME, 1)], { role: ROLE }));
  const stack = rowTree(working).root.findByProps({ testID: 'row-owners' });
  expect(stack.props.accessible).toBe(true);
  expect(stack.props.accessibilityLabel).toBe('Owners: You, Webhooks lead');
  expect(stack.props.importantForAccessibility).toBe('no-hide-descendants');
});

test('the header chip says only "Owners" while the owners read loads, then each owner once', () => {
  store.useInboxStore.setState({ sessions: { [S]: row(S, { owned_by_me: true }) }, sessionOwners: {} } as any);
  expect(faces.ownersSpoken(st(), S)).toBe('Owners');
  read.applySessionOwnersRead(S, ownersRead(S, [person(ME, 1)], { role: ROLE }));
  expect(faces.ownersSpoken(st(), S)).toBe('Owners: You, Webhooks lead');
});

test('the undo bar sits above the docked stack, follows the keyboard, and clears when the screen loses focus', () => {
  let top = 700;
  function Screen() {
    const a = anchor.useUndoBarAnchor();
    return React.createElement('View', { ref: a.ref, onLayout: a.onLayout });
  }
  let tree!: import('react-test-renderer').ReactTestRenderer;
  TestRenderer.act(() => {
    tree = TestRenderer.create(React.createElement(Screen), { createNodeMock: () => ({ measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => cb(0, top, 402, 120) }) });
  });
  expect(undo.useUndoBar.getState().dockTop).toBe(700);
  // The keyboard comes up and the stack rides it.
  top = 400;
  TestRenderer.act(() => keyboard.get('keyboardDidShow')!());
  expect(undo.useUndoBar.getState().dockTop).toBe(400);
  // A screen pushed over this one: this one blurs, and its anchor goes.
  TestRenderer.act(() => tree.unmount());
  expect(undo.useUndoBar.getState().dockTop).toBeNull();
});

test("the bar's lift counts from its host's bottom, not the window's: Android's navigation bar below the root is no part of it", () => {
  // iOS: the host fills the window (874), the stack's top at 700.
  expect(undo.undoBarLift(874, 700)).toBe(174);
  // Android edge-to-edge: a 48pt navigation bar under a root whose bottom is
  // 852 in an 900pt window; the window's height would put the bar 48pt high.
  expect(undo.undoBarLift(852, 700)).toBe(152);
  expect(undo.undoBarLift(852, 900)).toBe(0);
});
