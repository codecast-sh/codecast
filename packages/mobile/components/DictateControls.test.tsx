// Dictation in a phone text box, driven by presses: the mic shows only when the
// person turned it on; a press turns it into Cancel and Finish while the words
// stream into the box from a fake recognizer; Finish keeps them, Cancel puts
// the box back, and a send pressed mid-recording sends the dictated words. The
// box here is wired exactly as the composers wire theirs (value, setter,
// selection, send through dictation.send).
import { afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { teamVendorBlock } from '@codecast/shared/contracts/vendorCoverage';

const host = (name: string) => name;
// TouchableOpacity decides "disabled" as React Native 0.81 does (its
// _createPressabilityConfig: disabled ?? aria-disabled ??
// accessibilityState.disabled; the source is pinned by a test below), and a
// disabled one has no press. So a press here reaches onPress only when the
// real touchable would.
function touchableDisabled(props: any): boolean {
  return !!(props.disabled ?? props['aria-disabled'] ?? props.accessibilityState?.disabled);
}
function TouchableOpacity(props: any) {
  return React.createElement('TouchableOpacity', { ...props, onPress: touchableDisabled(props) ? undefined : props.onPress });
}
const openedSettings: number[] = [];
mock.module('react-native', () => ({
  View: host('View'), Text: host('Text'), TextInput: host('TextInput'), TouchableOpacity,
  Linking: { openSettings: async () => void openedSettings.push(1) },
  ActivityIndicator: host('ActivityIndicator'),
  StyleSheet: { create: <T,>(s: T) => s, flatten: (s: unknown) => s, hairlineWidth: 1, absoluteFillObject: {} },
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default },
  AppState: { addEventListener: (event: string, fn: (s: string) => void) => { if (event === 'change') appStateListeners.add(fn); return { remove: () => appStateListeners.delete(fn) }; } },
}));
const appStateListeners = new Set<(s: string) => void>();
// The screen the box sits on: its blur fires when a screen is pushed over it.
const NavigationContext = React.createContext<any>(null);
mock.module('@react-navigation/native', () => ({ NavigationContext }));
const blurListeners = new Set<() => void>();
const navigation = { addListener: (event: string, fn: () => void) => { if (event !== 'blur') return () => {}; blurListeners.add(fn); return () => blurListeners.delete(fn); } };
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
const NEEDS_MIC = 'Codecast needs the microphone to dictate. Turn it on in Settings.';
mock.module('@/lib/dictationHost', () => ({
  DICTATION_NEEDS_MIC: NEEDS_MIC,
  phoneDictationHost: () => ({ open: () => Promise.reject(new Error('real host reached')) }),
}));

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
let contracts: typeof import('@codecast/shared/contracts/dictation');
beforeAll(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).requestAnimationFrame ??= (fn: () => void) => setTimeout(fn, 0);
  const error = console.error;
  console.error = (...args: unknown[]) => { if (!String(args[0]).includes('react-test-renderer is deprecated')) error(...args); };
  TestRenderer = await import('react-test-renderer');
  ({ useDictation } = await import('@/lib/dictation'));
  ({ DictateControls } = await import('./DictateControls'));
  contracts = await import('@codecast/shared/contracts/dictation');
});

// A recognizer the test speaks into. `finish` waits until `finished()`.
type Fake = { events: import('@codecast/shared/contracts/dictation').DictationPipeEvents | null; closed: number; finished: () => void; fail: (m: string) => void };
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
  alerts.length = 0; sheets.length = 0; notices.length = 0; openedSettings.length = 0; secure.clear();
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
// What the native box was told to select (createNodeMock stands in for it).
const nativeSelections: [number, number][] = [];
function Box({ initial }: { initial: string }) {
  const [value, setValue] = React.useState(initial);
  const inputRef = React.useRef<any>(null);
  const d = useDictation({ value, onChangeText: setValue, inputRef });
  const send = React.useRef(() => {});
  send.current = () => { if (value.trim()) sent.push(value.trim()); setValue(''); };
  return React.createElement('View', null,
    React.createElement('TextInput', { testID: 'box', ref: inputRef, value, onChangeText: setValue, onSelectionChange: d.onSelectionChange, placeholder: d.placeholder('Add a comment...') }),
    React.createElement(DictateControls, { dictation: d }),
    React.createElement('TouchableOpacity', { testID: 'send', onPress: () => d.send(() => send.current()) }),
  );
}

const flush = () => new Promise((r) => setTimeout(r, 0));
async function mount(initial = '') {
  sent.length = 0;
  let r!: import('react-test-renderer').ReactTestRenderer;
  nativeSelections.length = 0;
  const createNodeMock = (el: { props: { testID?: string } }) =>
    el.props.testID === 'box' ? { isFocused: () => true, setSelection: (a: number, b: number) => nativeSelections.push([a, b]) } : null;
  await TestRenderer.act(async () => {
    r = TestRenderer.create(
      <NavigationContext.Provider value={navigation}>
        <Box initial={initial} />
      </NavigationContext.Provider>,
      { createNodeMock },
    );
  });
  mounted.push(r);
  const byLabel = (label: string) => r.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.type === 'string');
  // Through the touchable: a press on a disabled one throws, as nothing would happen on the phone.
  const press = (label: string) => TestRenderer.act(async () => {
    const onPress = byLabel(label)[0]!.props.onPress;
    if (!onPress) throw new Error(`"${label}" is disabled: a tap does nothing`);
    onPress();
    await flush();
  });
  const box = () => r.root.findByProps({ testID: 'box' });
  // What the composer's Send reads to show a send waiting on the last words.
  const dictationOf = () => r.root.findByType(DictateControls).props.dictation as import('@/lib/dictation').PhoneDictation;
  const act = (fn: () => void) => TestRenderer.act(async () => { fn(); await flush(); });
  return {
    r, byLabel, press, act, dictationOf,
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

test('send pressed twice while finishing sends once; send then Cancel sends nothing, ever', async () => {
  const m = await mount('');
  await m.press('Dictate');
  await m.act(() => fake.events!.onPartial('ship it'));
  await m.send();
  await m.send();
  await m.act(() => fake.finished());
  expect(sent).toEqual(['ship it']);

  await m.press('Dictate');
  await m.act(() => fake.events!.onPartial('scratch that'));
  await m.send();
  await m.press('Cancel dictation');
  expect(m.value()).toBe('');
  // A later recording kept with Finish does not carry the cancelled send.
  await m.press('Dictate');
  await m.act(() => fake.events!.onPartial('just a draft'));
  await m.press('Finish dictation');
  await m.act(() => fake.finished());
  expect(m.value()).toBe('just a draft');
  expect(sent).toEqual(['ship it']);
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

test('a start that failed says why at once, tints the mic, and a tap says it again and can try again', async () => {
  (globalThis as any).__dictationTestHost = { open: () => Promise.reject(new Error('Dictation needs a newer app version')) };
  const m = await mount('');
  await m.press('Dictate');
  // At once, in the bar the auto-stop line uses, with no second tap.
  expect(notices).toEqual(['Dictation needs a newer app version']);
  expect(alerts).toEqual([]);
  const mic = m.byLabel('Dictate')[0]!;
  expect(mic.props.accessibilityHint).toBe('Dictation needs a newer app version');
  // Failed reads without colour too: the struck-through mic.
  expect(mic.findByType('Feather' as any).props.color).toBe(THEME.red);
  expect(mic.findByType('Feather' as any).props.name).toBe('mic-off');
  await m.press('Dictate');
  expect(alerts.map((a) => [a.title, a.message, a.buttons?.map((b) => b.text)])).toEqual([
    ["Dictation didn't start", 'Dictation needs a newer app version', ['OK', 'Try again']],
  ]);
  installHost();
  await m.act(() => alerts[0]!.buttons![1]!.onPress!());
  expect(m.byLabel('Finish dictation').length).toBe(1);
  // The retry's success says nothing more.
  expect(notices.length).toBe(1);
});

test('a refused microphone says so at once with the way to Settings, and again from the struck mic', async () => {
  (globalThis as any).__dictationTestHost = { open: () => Promise.reject(new Error(NEEDS_MIC)) };
  const m = await mount('');
  await m.press('Dictate');
  expect(notices).toEqual([]);
  expect(alerts.map((a) => [a.title, a.message, a.buttons?.map((b) => b.text)])).toEqual([
    ["Dictation didn't start", NEEDS_MIC, ['Not now', 'Open Settings']],
  ]);
  await m.act(() => alerts[0]!.buttons![1]!.onPress!());
  expect(openedSettings).toEqual([1]);
  expect(m.byLabel('Dictate')[0]!.findByType('Feather' as any).props.name).toBe('mic-off');
  await m.press('Dictate');
  expect(alerts[1]!.buttons!.map((b) => b.text)).toEqual(['OK', 'Try again', 'Open Settings']);
  await m.act(() => alerts[1]!.buttons![2]!.onPress!());
  expect(openedSettings).toEqual([1, 1]);
});

test('the server refusing mid-start says its reason on the mic', async () => {
  const m = await mount('');
  await m.press('Dictate');
  await m.act(() => fake.events!.onFailed('Dictation is not configured'));
  expect(m.byLabel('Dictate')[0]!.props.accessibilityHint).toBe('Dictation is not configured');
  expect(notices).toEqual(['Dictation is not configured']);
});

test("a team without OpenAI under its BAA gets a dimmed mic that says why", async () => {
  setStore({ teams: [{ _id: 't1', name: 'Clinic', policy: { regulated_data: true } }], clientState: { ui: { active_team_id: 't1' } } });
  const m = await mount('');
  const why = teamVendorBlock({ name: 'Clinic', policy: { regulated_data: true } }, 'openai')!;
  const mic = m.byLabel('Dictate')[0]!;
  // Pressable, or the tap that says why would do nothing (RN treats
  // accessibilityState.disabled as disabled); VoiceOver reads the reason.
  expect(touchableDisabled(mic.props)).toBe(false);
  expect(mic.props.accessibilityHint).toBe(why);
  await m.press('Dictate');
  expect(fake.events).toBe(null);
  expect(notices).toEqual([why]);
  // The chevron stays, dimmed with the mic, and says the same.
  await m.press('Dictation settings');
  expect(sheets).toEqual([]);
  expect(notices).toEqual([why, why]);
});

test("the touchable stand-in decides disabled as React Native's own TouchableOpacity does", () => {
  const { readFileSync } = require('node:fs');
  const file = Bun.resolveSync('react-native/Libraries/Components/Touchable/TouchableOpacity.js', import.meta.dir);
  const src = (readFileSync(file, 'utf8') as string).replace(/\s+/g, ' ');
  expect(src).toContain("disabled: this.props.disabled ?? this.props['aria-disabled'] ?? this.props.accessibilityState?.disabled,");
  expect(touchableDisabled({ accessibilityState: { disabled: true } })).toBe(true);
  expect(touchableDisabled({ disabled: false, accessibilityState: { disabled: true } })).toBe(false);
});

test('the chevron picks the language, kept on this device', async () => {
  const m = await mount('');
  await m.press('Dictation settings');
  const first = sheets.at(-1)!;
  expect(first.title).toBe('Dictation settings');
  expect(first.items.find((i) => i.selected)?.label).toBe('Auto');
  await m.act(() => first.items.find((i) => i.label === 'Japanese')!.onPress());
  expect([...secure.values()]).toEqual(['ja']);
  expect(m.byLabel('Dictation settings')[0]!.props.accessibilityValue).toEqual({ text: 'Japanese' });
  await m.press('Dictation settings');
  expect(sheets.at(-1)!.items.find((i) => i.selected)?.label).toBe('Japanese');
});

test('Cancel puts a selection back as a selection, and the next words replace it', async () => {
  const m = await mount('fix the auth bug');
  await m.select(8, 12);
  await m.press('Dictate');
  await m.act(() => fake.events!.onUtterance({ text: 'login' }));
  expect(m.value()).toBe('fix the login bug');
  await m.press('Cancel dictation');
  expect(m.value()).toBe('fix the auth bug');
  expect(nativeSelections.at(-1)).toEqual([8, 12]);
  // The restored selection is the one the next recording replaces.
  await m.press('Dictate');
  await m.act(() => fake.events!.onUtterance({ text: 'session' }));
  expect(m.value()).toBe('fix the session bug');
});

test('the app going to the background finishes the recording, keeping its words', async () => {
  const m = await mount('');
  await m.press('Dictate');
  await m.act(() => fake.events!.onPartial('half a thought'));
  // The microphone permission prompt makes the app inactive: that is no stop.
  await m.act(() => appStateListeners.forEach((l) => l('inactive')));
  expect(m.byLabel('Finish dictation')[0]!.props.disabled).toBe(false);
  await m.act(() => appStateListeners.forEach((l) => l('background')));
  expect(m.byLabel('Finish dictation')[0]!.props.disabled).toBe(true);
  await m.act(() => fake.finished());
  expect(m.value()).toBe('half a thought');
  expect(m.byLabel('Dictate').length).toBe(1);
  expect(fake.closed).toBe(1);
});

test('a screen pushed over the box finishes its recording, keeping its words', async () => {
  const m = await mount('');
  await m.press('Dictate');
  await m.act(() => fake.events!.onPartial('before I left'));
  await m.act(() => blurListeners.forEach((l) => l()));
  await m.act(() => fake.finished());
  expect(m.value()).toBe('before I left');
  expect(m.byLabel('Dictate').length).toBe(1);
});

test('a huddle or room recording taking the mic finishes the dictation first', async () => {
  const m = await mount('');
  await m.press('Dictate');
  await m.act(() => fake.events!.onPartial('about to call'));
  expect(contracts.dictationRunning()).toBe(true);
  let done = false;
  await m.act(() => void contracts.finishRunningDictation().then(() => { done = true; }));
  expect(done).toBe(false);
  await m.act(() => fake.finished());
  expect([done, contracts.dictationRunning(), m.value()]).toEqual([true, false, 'about to call']);
});

// Lay a row out left to right from the props it renders: each button's box
// (style width, margins) grown by its hitSlop. Every target is 44pt square at
// least, and no two overlap, send's included (32pt, DICTATE_SEND_SLOP).
function targets(m: Awaited<ReturnType<typeof mount>>, labels: string[]) {
  const flat = (st: any): any => (Array.isArray(st) ? Object.assign({}, ...st.filter(Boolean).map(flat)) : st ?? {});
  const row = flat(m.byLabel(labels[0]!)[0]!.parent!.props.style);
  let x = 0;
  const rects = labels.map((label) => {
    const n = m.byLabel(label)[0]!;
    const st = flat(n.props.style);
    const slop = n.props.hitSlop;
    x += st.marginLeft ?? 0;
    const rect = { label, left: x - slop.left, right: x + st.width + slop.right, height: st.height + slop.top + slop.bottom };
    x += st.width + (st.marginRight ?? 0);
    return rect;
  });
  x += row.marginRight ?? 0;
  const { DICTATE_SEND_SLOP: send } = require('./DictateControls');
  rects.push({ label: 'Send', left: x - send.left, right: x + 32 + send.right, height: 32 + send.top + send.bottom });
  return rects;
}
function expectClear(rects: ReturnType<typeof targets>) {
  for (const r of rects) {
    expect([r.label, r.right - r.left >= 44, r.height >= 44]).toEqual([r.label, true, true]);
  }
  for (let i = 1; i < rects.length; i++) {
    expect([rects[i - 1]!.label, rects[i]!.label, rects[i - 1]!.right <= rects[i]!.left]).toEqual([rects[i - 1]!.label, rects[i]!.label, true]);
  }
}

test('every target is 44pt and none overlaps its neighbour, send included', async () => {
  const m = await mount('');
  const idle = targets(m, ['Dictate', 'Dictation settings']);
  expectClear(idle);
  await m.press('Dictate');
  const recording = targets(m, ['Cancel dictation', 'Finish dictation']);
  expectClear(recording);
  // Send sits in the same place in both states.
  expect(recording.at(-1)).toEqual(idle.at(-1));
});

test('blocked keeps the same row: nothing beside it moves', async () => {
  const open = await mount('');
  const idle = targets(open, ['Dictate', 'Dictation settings']);
  await open.act(() => setStore({ teams: [{ _id: 't1', name: 'Clinic', policy: { regulated_data: true } }], clientState: { ui: { active_team_id: 't1' } } }));
  const m = await mount('');
  const blocked = targets(m, ['Dictate', 'Dictation settings']);
  expectClear(blocked);
  expect(blocked).toEqual(idle);
});

test('✓ is quiet like ✕; a send waiting on the last words shows on Send, not on ✓', async () => {
  const m = await mount('');
  await m.press('Dictate');
  const flat = (st: any): any => (Array.isArray(st) ? Object.assign({}, ...st.filter(Boolean).map(flat)) : st ?? {});
  const bg = (label: string) => flat(m.byLabel(label)[0]!.props.style).backgroundColor;
  expect(bg('Finish dictation')).toBe(bg('Cancel dictation'));
  await m.act(() => fake.events!.onPartial('ship it'));
  expect(m.dictationOf().sendWaiting).toBe(false);
  await m.send();
  expect(m.dictationOf().sendWaiting).toBe(true);
  const finish = m.byLabel('Finish dictation')[0]!;
  expect(finish.findAllByType('ActivityIndicator' as any)).toEqual([]);
  expect(finish.findByType('Feather' as any).props.name).toBe('check');
  await m.act(() => fake.finished());
  expect(sent).toEqual(['ship it']);
  expect(m.dictationOf().sendWaiting).toBe(false);

  // ✓ pressed alone: the spinner is on ✓, and no send waits.
  await m.press('Dictate');
  await m.act(() => fake.events!.onPartial('draft'));
  await m.press('Finish dictation');
  expect(m.dictationOf().sendWaiting).toBe(false);
  expect(m.byLabel('Finish dictation')[0]!.findAllByType('ActivityIndicator' as any).length).toBe(1);
  await m.act(() => fake.finished());

  // Send then Cancel: nothing waits any more.
  await m.press('Dictate');
  await m.act(() => fake.events!.onPartial('scratch'));
  await m.send();
  expect(m.dictationOf().sendWaiting).toBe(true);
  await m.press('Cancel dictation');
  expect(m.dictationOf().sendWaiting).toBe(false);
});

test('text typed before the first word is kept, and Cancel leaves it', async () => {
  const m = await mount('draft');
  await m.press('Dictate');
  await m.type('draft and more');
  await m.act(() => fake.events!.onPartial('spoken'));
  expect(m.value()).toBe('draft and more');
  expect(m.byLabel('Dictate').length).toBe(1);
});

test('any team without OpenAI under its BAA dims the mic, whichever team is active', async () => {
  // The server refuses dictation for the person, not the workspace: here the
  // active workspace is personal and one of two teams is regulated.
  setStore({
    teams: [{ _id: 't0', name: 'Open', policy: {} }, { _id: 't1', name: 'Clinic', policy: { regulated_data: true } }],
    clientState: { ui: {} },
  });
  const m = await mount('');
  const mic = m.byLabel('Dictate')[0]!;
  expect(mic.props.accessibilityHint).toBe(teamVendorBlock({ name: 'Clinic', policy: { regulated_data: true } }, 'openai')!);
  await m.act(() => setStore({ teams: [{ _id: 't0', name: 'Open', policy: {} }] }));
  expect(m.byLabel('Dictate')[0]!.props.accessibilityHint).toBe(undefined);
});
