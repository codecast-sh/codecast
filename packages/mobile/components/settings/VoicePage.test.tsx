// Settings › Voice says why dictation is unavailable when a team blocks it:
// the line the struck mic gives (lib/dictation vendorBlockOf), under the
// switch, which stays the person's own and keeps working.
import { beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { dictationTeamBlock } from '@codecast/shared/contracts/dictation';

const host = (name: string) => name;
mock.module('react-native', () => ({
  View: host('View'),
  Linking: { openSettings: async () => {} },
  AppState: { addEventListener: () => ({ remove() {} }) },
}));
mock.module('@react-navigation/native', () => ({ NavigationContext: React.createContext(null) }));
mock.module('convex/react', () => ({ useConvex: () => ({}) }));
mock.module('expo-secure-store', () => ({ getItem: () => null, setItem: () => {}, deleteItemAsync: async () => {} }));
mock.module('@/lib/dictationHost', () => ({ DICTATION_NEEDS_MIC: 'mic', DICTATION_NEEDS_UPDATE: 'update', phoneDictationHost: () => ({}) }));
mock.module('@/components/Themed', () => ({ Text: host('Text') }));
mock.module('@/components/sessionFormat', () => ({ formatRelativeTime: () => 'now' }));
mock.module('@/lib/popups', () => ({ appAlert: () => {} }));
mock.module('@/lib/undoBar', () => ({ showNotice: () => {} }));
mock.module('@codecast/web/store/mutativeMiddleware', () => ({ isParkedDispatchError: () => false }));
mock.module('@codecast/web/hooks/useSyncCalls', () => ({ useMyVoiceprint: () => null }));
mock.module('@codecast/web/components/consequential/roleOnline', () => ({ ledgerLines: () => [] }));
mock.module('@codecast/web/components/settings/voiceIdLedger', () => ({ voiceIdLedger: () => ({}) }));
mock.module('@/components/settings/SettingsUI', () => ({
  SettingsScroll: host('SettingsScroll'),
  SettingsGroup: host('SettingsGroup'),
  ToggleRow: host('ToggleRow'),
  NavRow: host('NavRow'),
  settingsStyles: {},
}));

mock.module('@/components/settings/SettingsPages', () => ({
  useSettingsUser: () => React.useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => storeState.currentUser),
}));

let storeState: any = {};
const listeners = new Set<() => void>();
const setStore = (next: any) => { storeState = { ...storeState, ...next }; listeners.forEach((l) => l()); };
const writes: boolean[] = [];
mock.module('@codecast/web/store/inboxStore', () => {
  const useInboxStore = (selector: (s: any) => unknown) =>
    React.useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => selector(storeState));
  useInboxStore.getState = () => ({
    setDictationEnabled: async (v: boolean) => {
      writes.push(v);
      setStore({ currentUser: { ...storeState.currentUser, dictation_enabled: v } });
    },
  });
  return { useInboxStore };
});

let TestRenderer: typeof import('react-test-renderer');
let VoicePage: typeof import('./VoicePage').VoicePage;
beforeAll(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const error = console.error;
  console.error = (...args: unknown[]) => { if (!String(args[0]).includes('react-test-renderer is deprecated')) error(...args); };
  TestRenderer = await import('react-test-renderer');
  ({ VoicePage } = await import('./VoicePage'));
});
beforeEach(() => {
  writes.length = 0;
  storeState = { currentUser: { _id: 'u1', dictation_enabled: true }, teams: [] };
});

async function mount() {
  let r!: import('react-test-renderer').ReactTestRenderer;
  await TestRenderer.act(async () => { r = TestRenderer.create(<VoicePage />); });
  const row = () => r.root.findAll((n) => n.type === ('ToggleRow' as any) && n.props.label === 'Dictation')[0]!;
  // The footnote of the group that holds the Dictation switch.
  const line = () => row().parent!.props.footnote as string;
  return { r, row, line };
}

const CLINIC = { _id: 't1', name: 'Clinic', policy: { regulated_data: true } };

test('a team without OpenAI under its BAA: the switch says why, in the words the mic uses, and still works', async () => {
  setStore({ teams: [{ _id: 't0', name: 'Open', policy: {} }, CLINIC] });
  const m = await mount();
  const why = dictationTeamBlock([CLINIC])!;
  expect(why).toContain('Clinic');
  expect([m.row().props.value, m.line()]).toEqual([true, why]);
  // The person's own switch: turning it off is a plain write.
  await TestRenderer.act(async () => { m.row().props.onValueChange(false); });
  expect([writes, m.row().props.value, m.line()]).toEqual([[false], false, why]);
});

test('no blocking team: the ordinary line, and it follows the teams live', async () => {
  const m = await mount();
  expect(m.line()).toBe('A mic in the message boxes types what you say.');
  await TestRenderer.act(async () => setStore({ teams: [CLINIC] }));
  expect(m.line()).toBe(dictationTeamBlock([CLINIC])!);
  await TestRenderer.act(async () => setStore({ teams: [] }));
  expect(m.line()).toBe('A mic in the message boxes types what you say.');
});
