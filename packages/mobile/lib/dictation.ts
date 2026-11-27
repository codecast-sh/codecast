// Dictation for one of the phone's text boxes: the shared controller
// (shared/contracts/dictation, which owns every rule about the words) bound to
// a TextInput and its composer's own draft.
//
// The field adapter reads the composer's value and the selection the
// TextInput last reported (onSelectionChange), and writes through the
// composer's own setter, so drafts, the typing report and send see dictated
// words as typed ones. What it last wrote is held here too: two recognizer
// events in one tick must not read the box from before the first write, or
// the controller would take its own words for the person editing.

import { useCallback, useContext, useEffect, useRef, useState, type RefObject } from 'react';
import { AppState, type NativeSyntheticEvent, type TextInput, type TextInputSelectionChangeEventData } from 'react-native';
import { NavigationContext } from '@react-navigation/native';
import { useConvex } from 'convex/react';
import {
  DICTATION_IDLE,
  createDictation,
  dictationLanguages,
  dictationStopLine,
  teamVendorBlock,
  type Dictation,
  type DictationField,
  type DictationHost,
  type DictationState,
} from '@codecast/shared/contracts';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { activeTeamIdOf } from '@codecast/web/lib/activeTeam';
import { phoneDictationHost } from './dictationHost';
import { getDictationLanguage } from './dictationLanguage';
import { showNotice } from './undoBar';

export type DictationTarget = {
  /** The box's text, as the composer holds it. */
  value: string;
  /** The composer's own setter (what typing calls). */
  onChangeText: (text: string) => void;
  inputRef: RefObject<TextInput | null>;
  /** Changes when the composer remounts its box (a send): the old caret is gone. */
  resetKey?: unknown;
};

declare const __DEV__: boolean | undefined;

/** A dev build (or a test) may hand dictation a fake recognizer, for a
 *  simulator with no microphone: `globalThis.__dictationTestHost = { open }`.
 *  A release build never reads it. */
function devHost(): DictationHost | null {
  if (typeof __DEV__ !== 'undefined' && !__DEV__) return null;
  const fake = (globalThis as { __dictationTestHost?: DictationHost }).__dictationTestHost;
  return fake && typeof fake.open === 'function' ? fake : null;
}

/** Why dictation cannot run in this workspace (a team without a BAA covering
 *  OpenAI), or null. A string, so the selector is stable. */
function vendorBlockOf(s: any): string | null {
  const id = activeTeamIdOf(s);
  const team = id ? (s.teams || []).find((t: any) => String(t?._id) === id) : null;
  return teamVendorBlock(team, 'openai');
}

export type PhoneDictation = {
  /** The person turned dictation on (Settings › Voice). */
  shown: boolean;
  /** Why the mic is disabled here, or null. */
  blocked: string | null;
  state: DictationState;
  /** Recording, starting or finishing: the box belongs to the recording. */
  active: boolean;
  start(): void;
  finish(): Promise<void>;
  cancel(): void;
  /** Send through `fn` once the last words are in the box (now, when idle). */
  send(fn: () => void): void;
  onSelectionChange(e: NativeSyntheticEvent<TextInputSelectionChangeEventData>): void;
  /** The placeholder the box shows: "Listening…" while recording into an empty box. */
  placeholder(base: string): string;
};

export function useDictation(target: DictationTarget): PhoneDictation {
  // Read when a recording opens, so the controller lives as long as the box.
  const client = useConvex();
  const convex = useRef(client);
  convex.current = client;
  const shown = useInboxStore((s) => (s.currentUser as { dictation_enabled?: boolean } | null)?.dictation_enabled === true);
  const blocked = useInboxStore(vendorBlockOf);
  const [state, setState] = useState<DictationState>(DICTATION_IDLE);

  const latest = useRef(target);
  latest.current = target;
  // The box's text as of the last render, or as of this hook's own last
  // write when that is newer (see the header).
  const valueRef = useRef(target.value);
  valueRef.current = target.value;
  const selection = useRef<readonly [number, number] | null>(null);
  useEffect(() => {
    selection.current = null;
  }, [target.resetKey]);

  const ctl = useRef<Dictation | null>(null);
  useEffect(() => {
    const field: DictationField = {
      getValue: () => valueRef.current,
      getSelection: () => selection.current,
      setValue(value, caret, anchor = caret) {
        const start = Math.min(anchor, caret);
        const end = Math.max(anchor, caret);
        valueRef.current = value;
        selection.current = [start, end];
        latest.current.onChangeText(value);
        // The caret (or Cancel's restored selection) follows once the native
        // box has the new text.
        requestAnimationFrame(() => {
          const input = latest.current.inputRef.current;
          if (input?.isFocused?.()) input.setSelection?.(start, end);
        });
      },
    };
    const host: DictationHost = {
      open: (events) => (devHost() ?? phoneDictationHost(convex.current, dictationLanguages(getDictationLanguage()))).open(events),
    };
    const d = createDictation(field, host, setState);
    ctl.current = d;
    return () => {
      d.dispose();
      if (ctl.current === d) ctl.current = null;
    };
  }, []);

  // A send pressed mid-recording waits here for the recording to settle; it
  // runs after the render that put the last words in the composer's state,
  // so the composer's send reads them.
  const pendingSend = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (state.phase !== 'idle' || !pendingSend.current) return;
    const fn = pendingSend.current;
    pendingSend.current = null;
    fn();
  }, [state.phase]);

  // A recording that ended by itself says why, once.
  useEffect(() => {
    const line = dictationStopLine(state.stopped);
    if (line) showNotice(line);
  }, [state.stopped]);

  // The app going to the background (home, the phone locking) keeps what was
  // said and stops: the audio background mode would otherwise keep the
  // microphone live. Not on "inactive": the microphone permission prompt is
  // that, and would end the start it interrupts.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') void ctl.current?.finish();
    });
    return () => sub.remove();
  }, []);

  // A screen pushed over this one keeps it mounted: the box it records into
  // is out of sight, so keep what was said and stop.
  const navigation = useContext(NavigationContext);
  useEffect(
    () => (navigation ? navigation.addListener('blur', () => void ctl.current?.finish()) : undefined),
    [navigation],
  );

  // Turned off (or blocked) mid-recording: keep what was said and stop.
  useEffect(() => {
    if ((!shown || blocked) && ctl.current?.active) void ctl.current.finish();
  }, [shown, blocked]);

  const start = useCallback(() => ctl.current?.start(), []);
  const finish = useCallback(() => ctl.current?.finish() ?? Promise.resolve(), []);
  const cancel = useCallback(() => {
    pendingSend.current = null;
    ctl.current?.cancel();
  }, []);
  const send = useCallback((fn: () => void) => {
    const d = ctl.current;
    if (!d?.active) return fn();
    pendingSend.current = fn;
    void d.finish();
  }, []);
  const onSelectionChange = useCallback((e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
    const sel = e?.nativeEvent?.selection;
    if (sel) selection.current = [sel.start, sel.end];
  }, []);

  const active = state.phase !== 'idle';
  const placeholder = useCallback(
    (base: string) => (active && state.phase !== 'finishing' && !target.value ? 'Listening…' : base),
    [active, state.phase, target.value],
  );

  return { shown, blocked, state, active, start, finish, cancel, send, onSelectionChange, placeholder };
}
