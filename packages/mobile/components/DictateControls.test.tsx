// Dictation in a phone text box, driven by presses: the mic shows only when the
// person turned it on; a press turns it into Cancel and Finish while the words
// stream into the box from a fake recognizer; Finish keeps them, Cancel puts
// the box back, and a send pressed mid-recording sends the dictated words. The
// box here is wired exactly as the composers wire theirs (value, setter,
// selection, send through dictation.send).
import { afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import React from 'react';

const host = (name: string) => name;
mock.module('react-native', () => ({
  View: host('View'), Text: host('Text'), TextInput: host('TextInput'), TouchableOpacity: host('TouchableOpacity'),
  ActivityIndicator: host('ActivityIndicator'),
  StyleSheet: { create: <T,>(s: T) => s, flatten: (s: unknown) => s, hairlineWidth: 1, absoluteFillObject: {} },
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default },
}));
mock.module('@expo/vector-icons/Feather', () => ({ default: host('Feather') }));
const THEME = { text: '#111', textMuted: '#555', textMuted0: '#777', bg: '#fff', bgAlt: '#eee', borderLight: '#ddd', red: '#dc322f' };
mock.module('@/constants/Theme', () => ({ themedStyles: (build: (t: typeof THEME, look: string) => unknown) => build(THEME, 'classic'), useTheme: () => THEME }));
mock.module('@/lib/solColor', () => ({ mixColor: (a: string) => a }));
const alerts: { title: string; message?: string; buttons?: { text: string; onPress?: () => void }[] }[] = [];
const sheets: { title?: string; items: { label: string; selected?: boolean; onPress: () => void }[] }[] = [];
mock.module('@/lib/popups', () => ({
  appAlert: (title: string, message?: string, buttons?: any[]) => alerts.push({ title, message, buttons }),
  showActionSheet: (title: string | undefined, items: any[]) => sheets.push({ title, items }),
}));
const notices: string[] = [];
mock.module('@/lib/undoBar', () => ({ showNotice: (t: string) => notices.push(t) }));
const secure = new Map<string, string>();
mock.module('expo-secure-store', () => ({
  getItem: (k: string) => secure.get(k) ?? null,
  setItem: (k: string, v: string) => void secure.set(k, v),
  deleteItemAsync: async (k: string) => void secure.delete(k),
}));
mock.module('convex/react', () => ({ useConvex: () => ({}) }));
// The real host opens the microphone; every test hands in a fake through the
// dev seam instead, so this one must never be reached.
mock.module('@/lib/dictationHost', () => ({ phoneDictationHost: () => ({ open: () => Promise.reject(new Error('real host reached')) }) }));

// The store slice dictation reads: the viewer's switch and the active team.
let storeState: any = {};
const storeListeners = new Set<() => void>();
const setStore = (next: any) => { storeState = { ...storeState, ...next }; storeListeners.forEach((l) => l()); };
mock.module('@codecast/web/store/inboxStore', () => ({
  useInboxStore: (selector: (s: any) => unknown) =>
    React.useSyncExternalStore((l) => { storeListeners.add(l); return () => storeListeners.delete(l); }, () => selector(storeState)),
}));

let TestRenderer: typeof import('react-test-renderer');
let useDictation: typeof import('@/lib/dictation').useDictation;
let DictateControls: typeof import('./DictateControls').DictateControls;
let contracts: typeof import('@codecast/shared/contracts');
beforeAll(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).requestAnimationFrame ??= (fn: () => void) => setTimeout(fn, 0);
  const error = console.error;
  console.error = (...args: unknown[]) => { if (!String(args[0]).includes('react-test-renderer is deprecated')) error(...args); };
  TestRenderer = await import('react-test-renderer');
  ({ useDictation } = await import('@/lib/dictation'));
  ({ DictateControls } = await import('./DictateControls'));
  contracts = await import('@codecast/shared/contracts');
});

// A recognizer the test speaks into. `finish` waits until `finished()`.
type Fake = { events: import('@codecast/shared/contracts').DictationPipeEvents | null; closed: number; finished: () => void; fail: (m: string) => void };
let fake: Fake;
function installHost() {
  let release: () => void = () => {};
  let reject: (e: Error) => void = () => {};
  fake = { events: null, closed: 0, finished: () => release(), fail: (m) => reject(new Error(m)) };
  (globalThis as any).__dictationTestHost = {
    open: (events: any) => new Promise((resolve, rej) => {
      fake.events = events;
      reject = rej;
      resolve({
        finish: () => new Promise<void>((r) => { release = r; }),
        close: () => { fake.closed++; },
      });
    }),
  };
}

beforeEach(() => {
  alerts.length = 0; sheets.length = 0; notices.length = 0; secure.clear();
  storeState = { currentUser: { _id: 'u1', dictation_enabled: true }, teams: [], clientState: { ui: {} } };
  installHost();
});
const mounted: import('react-test-renderer').ReactTestRenderer[] = [];
afterEach(async () => {
  await TestRenderer.act(async () => { mounted.splice(0).forEach((r) => r.unmount()); });
  contracts._resetDictationForTests();
  delete (globalThis as any).__dictationTestHost;
});

const sent: string[] = [];
function Box({ initial }: { initial: string }) {
  const [value, setValue] = React.useState(initial);
  const inputRef = React.useRef<any>(null);
  const d = useDictation({ value, onChangeText: setValue, inputRef });
  const send = React.useRef(() => {});
  send.current = () => { if (value.trim()) sent.push(value.trim()); setValue(''); };
  return React.createElement('View', null,
    React.createElement('TextInput', { testID: 'box', value, onChangeText: setValue, onSelectionChange: d.onSelectionChange, placeholder: d.placeholder('Add a comment...') }),
    React.createElement(DictateControls, { dictation: d }),
    React.createElement('TouchableOpacity', { testID: 'send', onPress: () => d.send(() => send.current()) }),
  );
}

const flush = () => new Promise((r) => setTimeout(r, 0));
async function mount(initial = '') {
  sent.length = 0;
  let r!: import('react-test-renderer').ReactTestRenderer;
  await TestRenderer.act(async () => { r = TestRenderer.create(<Box initial={initial} />); });
  mounted.push(r);
  const byLabel = (label: string) => r.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.type === 'string');
  const press = (label: string) => TestRenderer.act(async () => { byLabel(label)[0]!.props.onPress(); await flush(); });
  const box = () => r.root.findByProps({ testID: 'box' });
  const act = (fn: () => void) => TestRenderer.act(async () => { fn(); await flush(); });
  return {
    r, byLabel, press, act,
    value: () => box().props.value as string,
    placeholder: () => box().props.placeholder as string,
    select: (start: number, end = start) => act(() => box().props.onSelectionChange({ nativeEvent: { selection: { start, end } } })),
    type: (text: string) => act(() => box().props.onChangeText(text)),
    send: () => TestRenderer.act(async () => { r.root.findByProps({ testID: 'send' }).props.onPress(); await flush(); }),
  };
}

test('hidden unless the person turned dictation on', async () => {
  setStore({ currentUser: { _id: 'u1', dictation_enabled: false } });
  const m = await mount();
  expect(m.byLabel('Dictate')).toEqual([]);
  expect(m.byLabel('Dictation settings')).toEqual([]);
  await m.act(() => setStore({ currentUser: { _id: 'u1', dictation_enabled: true } }));
  expect(m.byLabel('Dictate').length).toBe(1);
  expect(m.byLabel('Dictation settings').length).toBe(1);
});

test('the mic turns into Cancel and Finish, and the words stream in at the caret', async () => {
  const m = await mount('fix the please');
  await m.select(7);
  await m.press('Dictate');
  expect(m.byLabel('Dictate')).toEqual([]);
  expect([m.byLabel('Cancel dictation').length, m.byLabel('Finish dictation').length]).toEqual([1, 1]);
  await m.act(() => fake.events!.onPartial('auth'));
  expect(m.value()).toBe('fix the auth please');
  // The open sentence rewrites itself in place, then closes.
  await m.act(() => fake.events!.onPartial('auth bug'));
  await m.act(() => { fake.events!.onUtterance({ text: 'auth bug,' }); fake.events!.onPartial(''); });
  expect(m.value()).toBe('fix the auth bug, please');
  await m.act(() => fake.events!.onPartial('now'));
  expect(m.value()).toBe('fix the auth bug, now please');
});

test('an empty box reads Listening… while recording', async () => {
  const m = await mount('');
  expect(m.placeholder()).toBe('Add a comment...');
  await m.press('Dictate');
  expect(m.placeholder()).toBe('Listening…');
  await m.act(() => fake.events!.onPartial('hello'));
  expect(m.value()).toBe('hello');
});

test('Finish keeps the words, waiting for the last ones', async () => {
  const m = await mount('');
  await m.press('Dictate');
  await m.act(() => fake.events!.onPartial('hello there'));
  await m.press('Finish dictation');
  // Still waiting on the recognizer: the button says so and cannot be pressed twice.
  const finishing = m.byLabel('Finish dictation')[0]!;
  expect([finishing.props.disabled, finishing.findAllByType('ActivityIndicator' as any).length]).toEqual([true, 1]);
  await m.act(() => fake.finished());
  expect(m.value()).toBe('hello there');
  expect(m.byLabel('Dictate').length).toBe(1);
  expect(m.byLabel('Cancel dictation')).toEqual([]);
});

test('Cancel puts the box back exactly as it was', async () => {
  const m = await mount('draft');
  await m.press('Dictate');
  await m.act(() => fake.events!.onUtterance({ text: 'Something I did not mean.' }));
  expect(m.value()).toBe('draft Something I did not mean.');
  await m.press('Cancel dictation');
  expect(m.value()).toBe('draft');
  expect(fake.closed).toBe(1);
  expect(m.byLabel('Dictate').length).toBe(1);
});

test('send while recording finishes first, then sends the dictated words', async () => {
  const m = await mount('');
  await m.press('Dictate');
  await m.act(() => fake.events!.onPartial('ship it'));
  await m.send();
  expect(sent).toEqual([]);
  // The last words land while finishing; the send carries them.
  await m.act(() => { fake.events!.onUtterance({ text: 'ship it today' }); fake.events!.onPartial(''); });
  await m.act(() => fake.finished());
  expect(sent).toEqual(['ship it today']);
  expect(m.value()).toBe('');
});

test('typing into the box mid-recording stops it and keeps what was typed', async () => {
  const m = await mount('');
  await m.press('Dictate');
  await m.act(() => fake.events!.onPartial('hello'));
  await m.type('hello!!');
  await m.act(() => fake.events!.onPartial('hello world'));
  expect(m.value()).toBe('hello!!');
  expect(m.byLabel('Dictate').length).toBe(1);
  expect(notices).toEqual(['Dictation stopped: the text changed']);
});

test('a start that failed tints the mic, and a tap says why and can try again', async () => {
  (globalThis as any).__dictationTestHost = { open: () => Promise.reject(new Error('Dictation needs a newer app version')) };
  const m = await mount('');
  await m.press('Dictate');
  const mic = m.byLabel('Dictate')[0]!;
  expect(mic.props.accessibilityHint).toBe('Dictation needs a newer app version');
  expect(mic.findByType('Feather' as any).props.color).toBe(THEME.red);
  await m.press('Dictate');
  expect(alerts.map((a) => [a.title, a.message, a.buttons?.map((b) => b.text)])).toEqual([
    ['Dictation', 'Dictation needs a newer app version', ['OK', 'Try again']],
  ]);
  installHost();
  await m.act(() => alerts[0]!.buttons![1]!.onPress!());
  expect(m.byLabel('Finish dictation').length).toBe(1);
});

test('the server refusing mid-start says its reason on the mic', async () => {
  const m = await mount('');
  await m.press('Dictate');
  await m.act(() => fake.events!.onFailed('Dictation is not configured'));
  expect(m.byLabel('Dictate')[0]!.props.accessibilityHint).toBe('Dictation is not configured');
});

test("a team without OpenAI under its BAA gets a dimmed mic that says why", async () => {
  setStore({ teams: [{ _id: 't1', name: 'Clinic', policy: { regulated_data: true } }], clientState: { ui: { active_team_id: 't1' } } });
  const m = await mount('');
  const mic = m.byLabel('Dictate')[0]!;
  expect(mic.props.accessibilityState).toEqual({ disabled: true });
  expect(m.byLabel('Dictation settings')).toEqual([]);
  await m.press('Dictate');
  expect(fake.events).toBe(null);
  expect(notices.length).toBe(1);
  expect(notices[0]).toBe(contracts.teamVendorBlock({ name: 'Clinic', policy: { regulated_data: true } }, 'openai')!);
});

test('the chevron picks the language, kept on this device', async () => {
  const m = await mount('');
  await m.press('Dictation settings');
  const first = sheets.at(-1)!;
  expect(first.items.find((i) => i.selected)?.label).toBe('Auto');
  await m.act(() => first.items.find((i) => i.label === 'Japanese')!.onPress());
  expect([...secure.values()]).toEqual(['ja']);
  expect(m.byLabel('Dictation settings')[0]!.props.accessibilityValue).toEqual({ text: 'Japanese' });
  await m.press('Dictation settings');
  expect(sheets.at(-1)!.items.find((i) => i.selected)?.label).toBe('Japanese');
});
