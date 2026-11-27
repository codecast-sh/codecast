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
import { AppState, Linking, type NativeSyntheticEvent, type TextInput, type TextInputSelectionChangeEventData } from 'react-native';
import { NavigationContext } from '@react-navigation/native';
import { useConvex } from 'convex/react';
import { teamVendorBlock } from '@codecast/shared/contracts';
import { DICTATION_IDLE, createDictation, dictationLanguages, dictationStopLine, type Dictation, type DictationField, type DictationHost, type DictationState } from '@codecast/shared/contracts/dictation';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { DICTATION_NEEDS_MIC, DICTATION_NEEDS_UPDATE, phoneDictationHost } from './dictationHost';
import { getDictationLanguage } from './dictationLanguage';
import { appAlert, type AlertButton } from './popups';
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

/** Why dictation cannot run for this person, or null: the server refuses it
 *  when any team they belong to lacks a BAA covering OpenAI, whichever team is
 *  active (convex/dictation authForDictation), so the mic does too. The first
 *  refusal wins. A string, so the selector is stable. */
function vendorBlockOf(s: any): string | null {
  for (const team of s.teams || []) {
    const block = teamVendorBlock(team, 'openai');
    if (block) return block;
  }
  return null;
}

/** Why a start failed, as a dialog: what the struck mic says when tapped
 *  (`retry` adds Try again), and what a refused microphone says at once.
 *  A refused microphone is fixed only in the phone's Settings, so it offers
 *  the way there. An app too old for dictation stays too old until it
 *  updates, so it offers no Try again. */
export function explainDictationFailure(error: string, retry?: () => void) {
  if (error === DICTATION_NEEDS_UPDATE) retry = undefined;
  const buttons: AlertButton[] = [{ text: retry || error !== DICTATION_NEEDS_MIC ? 'OK' : 'Not now', style: 'cancel' }];
  if (retry) buttons.push({ text: 'Try again', onPress: retry });
  if (error === DICTATION_NEEDS_MIC) buttons.push({ text: 'Open Settings', onPress: () => void Linking.openSettings() });
  appAlert("Dictation didn't start", error, buttons);
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
  finish(): Promise<boolean>;
  cancel(): void;
  /** Send through `fn` once the last words are in the box (now, when idle);
   *  nothing when cancelled meanwhile, once when pressed twice. */
  send(fn: () => void): void;
  /** A send was pressed mid-recording and waits on the last words: Send
   *  shows the wait, not ✓. */
  sendWaiting: boolean;
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
      open: (events, signal) => (devHost() ?? phoneDictationHost(convex.current, dictationLanguages(getDictationLanguage()))).open(events, signal),
    };
    const d = createDictation(field, host, setState);
    ctl.current = d;
    return () => {
      d.dispose();
      if (ctl.current === d) ctl.current = null;
    };
  }, []);

  // A send pressed mid-recording goes through the controller's finishThen
  // (one slot, nothing on Cancel). That runs as the last words reach the
  // composer's setter, before React has rendered them, so the send it hands
  // over waits here for the next render, whose state holds those words.
  const [queuedSend, setQueuedSend] = useState<{ fn: () => void } | null>(null);
  useEffect(() => {
    if (!queuedSend) return;
    setQueuedSend(null);
    queuedSend.fn();
  }, [queuedSend]);
  // From the press until that send runs; Cancel (or any end) clears it.
  const [sendPressed, setSendPressed] = useState(false);
  useEffect(() => {
    if (state.phase === 'idle') setSendPressed(false);
  }, [state.phase]);

  // A recording that ended by itself says why, once.
  useEffect(() => {
    const line = dictationStopLine(state.stopped);
    if (line) showNotice(line);
  }, [state.stopped]);

  // A start that failed says why at once; the struck mic says it again on a
  // tap. Each failure is a new state object (a start clears the error first).
  const explained = useRef<DictationState | null>(null);
  useEffect(() => {
    if (!state.error || explained.current === state) return;
    explained.current = state;
    if (state.error === DICTATION_NEEDS_MIC) explainDictationFailure(state.error);
    else showNotice(state.error);
  }, [state]);

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
  const finish = useCallback(() => ctl.current?.finish() ?? Promise.resolve(true), []);
  const cancel = useCallback(() => ctl.current?.cancel(), []);
  const send = useCallback((fn: () => void) => {
    const d = ctl.current;
    if (!d?.active) return fn();
    setSendPressed(true);
    d.finishThen(() => setQueuedSend({ fn }));
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

  const sendWaiting = (sendPressed && active) || queuedSend !== null;

  return { shown, blocked, state, active, start, finish, cancel, send, sendWaiting, onSelectionChange, placeholder };
}
