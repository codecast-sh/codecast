// The live terminal of one session's tmux pane, on the phone: for the states
// the transcript cannot show (a trust prompt, a login screen, a /model picker,
// a screen nothing parses, a bare shell). Frames come through the Convex relay
// that web's remote panes use (web lib/terminal/remotePane.ts), and keystrokes
// go back the same way. xterm paints inside a WebView with its own input
// disabled; a hidden native TextInput owns the keyboard (lib/terminal/
// terminalInput.ts), and one row of quick keys covers what a phone keyboard
// has no key for.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useConvex } from 'convex/react';
import * as Haptics from 'expo-haptics';
import Feather from '@expo/vector-icons/Feather';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { api } from '@codecast/convex/convex/_generated/api';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { connectRemotePane, frameToBytes, type RemotePaneConnection, type RemotePaneFrame } from '@codecast/web/lib/terminal/remotePane';
import { Text as RNText, TextInput } from '@/components/Themed';
import { themedStyles, useTheme } from '@/constants/Theme';
import { Mono } from '@/constants/fonts';
import { optionalNative } from '@/lib/optionalNative';
import { copyToClipboard, readClipboard } from '@/lib/clipboard';
import { SelectTextSheet } from '@/components/SelectTextSheet';
import { CTRL_KEY_BYTES, QUICK_KEY_BYTES, SentinelInput, SENTINEL, ctrlChord, pasteBytes, plainKeyboardText, type QuickKey } from '@/lib/terminal/terminalInput';
import { looksLikeTui, snapshotText } from '@/lib/terminal/snapshotRejoin';
import { EscGate } from '@/lib/terminal/escGate';
import { TERMINAL_BG, buildTerminalHtml } from '@/lib/terminal/terminalHtml';
import { PANE_STALE_AFTER_MS, utf8Binary, terminalStatus, type PaneStatus } from '@/lib/terminal/paneStatus';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const WebViewComp: any = optionalNative('RNCWebViewModule', () => require('react-native-webview').WebView);

/** The binary has the WebView the terminal draws in (older builds do not). */
export const terminalAvailable = !!WebViewComp;

/** A relay that never answers is a machine that is asleep, offline or too old to stream. */
const FIRST_FRAME_TIMEOUT_MS = 15_000;

interface Machine { device_id: string; is_mine: boolean; via_bot?: boolean; label?: string | null }

/** What sendPaneInput accepts queued at once (PANE_MAX_PENDING_INPUT_BYTES), less room for keys around a paste. */
const MAX_PASTE_BYTES = 3_500;
/** A key press keeps the far loop at typing speed this long; past it the relay drops back to its idle cadence. */
const INTERACTIVE_AFTER_KEY_MS = 15_000;
/** An offer is gone from the relay after this long (PANE_CLIPBOARD_TTL_MS); the pill goes with it. */
const OFFER_SHOWN_MS = 60_000;

/** "macOS - MacBook-Pro-2" reads as "MacBook-Pro-2". */
const machineLabel = (label?: string | null) => (label ? label.replace(/^[^-]{2,12} - /, '') : null);

export function PaneTerminal({ conversationId, target, title, hydrated = true }: {
  conversationId: string;
  hydrated?: boolean;
  target: string | null;
  title: string;
}) {
  const Theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const convex = useConvex();
  const machineQuery = useQueryNoThrow(api.devices.getConversationMachine, target ? ({ conversation_id: conversationId } as any) : 'skip');
  const machine = machineQuery.data as Machine | null | undefined;
  const machineSettled = machine !== undefined || !!machineQuery.error;

  const webRef = useRef<any>(null);
  const inputRef = useRef<any>(null);
  const connRef = useRef<RemotePaneConnection | null>(null);
  const keyboard = useRef(new SentinelInput());
  const lastFrame = useRef<RemotePaneFrame | null>(null);
  const webReady = useRef(false);
  // The first clipboard stamp this connection saw: only an offer made after it
  // is new. Server time against server time, so a phone clock cannot skew it.
  const clipBaseline = useRef<number | null>(null);
  const lastKeyAt = useRef(0);
  // The newest word from the far loop, frame or heartbeat.
  const newestSeen = useRef(0);
  // Every key goes out through this gate, which holds keys after a lone Esc
  // until the far loop has drained it (lib/terminal/escGate.ts).
  const gate = useRef<EscGate | null>(null);

  const [field, setFieldState] = useState({ text: SENTINEL, n: 0 });
  // The field as the keyboard last left it. Submit reads this, not state: a
  // Return can arrive before the render that holds the last keystroke.
  const fieldNow = useRef(SENTINEL);
  const setField = useCallback((text: string) => {
    fieldNow.current = text;
    setFieldState((f) => ({ text, n: f.n + 1 }));
  }, []);
  const [frameState, setFrameState] = useState<{ seenAt: number | null; painted: boolean }>({ seenAt: null, painted: false });
  const [error, setError] = useState<string | null>(null);
  // A relay failure after frames were arriving: the screen stays, typing stops
  // until the far loop is heard from again.
  const [liveError, setLiveError] = useState<{ message: string; at: number } | null>(null);
  const liveErrorAt = useRef<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [offer, setOffer] = useState<{ text: string; at: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [keyboardUp, setKeyboardUp] = useState(false);
  // One-shot Ctrl: the next typed key goes out as its control chord.
  const [ctrlArmed, setCtrlArmed] = useState(false);
  // Off by default: iOS rewrites single letters ("q" becomes "a") and words
  // at a prompt that answers on one key or takes a password. Aa turns it on
  // for prose to an agent.
  const [autoCorrect, setAutoCorrect] = useState(false);

  const html = useMemo(() => buildTerminalHtml(), []);

  const paint = useCallback((f: RemotePaneFrame) => {
    if (!webReady.current || f.frame === null) return;
    const data = frameToBytes(f.frame, f.cursor_x !== null && f.cursor_y !== null ? { x: f.cursor_x, y: f.cursor_y } : null);
    const msg = JSON.stringify({ t: 'frame', data, cols: f.cols, rows: f.rows, cursor: f.cursor_x !== null && f.cursor_y !== null ? { x: f.cursor_x, y: f.cursor_y } : null });
    webRef.current?.injectJavaScript(`window.__cc && window.__cc(${JSON.stringify(msg)}); true;`);
  }, []);

  const foreign = !!machine && !machine.is_mine;
  const deviceId = machine?.device_id ?? null;

  useEffect(() => {
    if (!target || !deviceId || foreign) return;
    setError(null);
    setLiveError(null);
    liveErrorAt.current = null;
    newestSeen.current = 0;
    setFrameState({ seenAt: null, painted: false });
    lastFrame.current = null;
    let lastSeq = -1;
    let gotFrame = false;
    // The relay row outlives a watch: its first answer can be the screen an
    // earlier viewer left, from a machine that has since gone to sleep. An
    // answer the far loop pushed within the last few seconds is live (the
    // window absorbs clock skew); an older one waits for the next push.
    let initialSeen: number | null = null;
    const firstFrame = setTimeout(() => {
      if (!gotFrame) setError("That machine isn't answering");
    }, FIRST_FRAME_TIMEOUT_MS);
    const conn = connectRemotePane({ convex: convex as any, deviceId, target, conversationId }, {
      onFrame: (f) => {
        const seenAt = f.streamer_seen_at ?? 0;
        if (initialSeen === null) {
          initialSeen = seenAt;
          if (Date.now() - seenAt > PANE_STALE_AFTER_MS) return;
        } else if (!gotFrame && seenAt <= initialSeen) return;
        gotFrame = true;
        clearTimeout(firstFrame);
        newestSeen.current = Math.max(newestSeen.current, seenAt);
        gate.current?.heard(seenAt);
        setFrameState((s) => ({ seenAt, painted: s.painted || f.frame !== null }));
        setError(null);
        if (liveErrorAt.current !== null && seenAt > liveErrorAt.current) {
          liveErrorAt.current = null;
          setLiveError(null);
        }
        if (f.seq === lastSeq || f.frame === null) return;
        lastSeq = f.seq;
        lastFrame.current = f;
        paint(f);
      },
      onError: (message) => {
        if (!gotFrame) {
          clearTimeout(firstFrame);
          setError(message);
          return;
        }
        // The pane itself is gone (the daemon says so once and stops): there
        // is nothing to wait for, so it is the error state, not Interrupted.
        if (/pane is gone/.test(message)) {
          setError('The pane is gone: the session ended or moved');
          setFrameState((s) => ({ ...s, painted: false }));
          return;
        }
        // Keys held behind an Esc wait for nothing now.
        gate.current?.unblock();
        // Every refusal means a keystroke did not land or the pane went away:
        // say so, and hold typing until the far loop is heard from again.
        liveErrorAt.current = Math.max(newestSeen.current, liveErrorAt.current ?? 0);
        setLiveError({ message, at: liveErrorAt.current });
      },
    });
    connRef.current = conn;
    gate.current = new EscGate((bytes, onQueued) => conn.write(utf8Binary(bytes), onQueued), () => newestSeen.current);
    return () => {
      clearTimeout(firstFrame);
      gate.current?.dispose();
      gate.current = null;
      conn.close();
      connRef.current = null;
    };
  }, [convex, conversationId, target, deviceId, foreign, attempt, paint]);

  // The clipboard offer has its own query, so its text crosses the wire once
  // per offer. Server stamps against server stamps: only an offer newer than
  // the first answer this screen saw is new.
  const clipQuery = useQueryNoThrow(
    api.terminalStream.getPaneClipboard,
    target && deviceId && !foreign ? ({ device_id: deviceId, target, conversation_id: conversationId } as any) : 'skip',
  );
  const clipValue = clipQuery.data as { clipboard: string; clipboard_at: number } | null | undefined;
  // A reconnect (Retry) starts from whatever offer stands at that moment.
  const clipNow = useRef(clipValue);
  clipNow.current = clipValue;
  useEffect(() => {
    clipBaseline.current = clipNow.current === undefined ? null : clipNow.current?.clipboard_at ?? 0;
  }, [attempt, deviceId, target]);
  useEffect(() => {
    if (clipValue === undefined) return;
    const at = clipValue?.clipboard_at ?? 0;
    if (clipBaseline.current === null) {
      clipBaseline.current = at;
      return;
    }
    if (clipValue && at > clipBaseline.current) {
      clipBaseline.current = at;
      setOffer({ text: clipValue.clipboard, at });
      setCopied(false);
    }
  }, [clipValue]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 3000);
    return () => clearInterval(t);
  }, []);

  // The fast far-side loop is for someone at the keyboard: while it is up, or
  // for a while after a quick key, and never with the app in the background.
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => setAppActive(st === 'active'));
    return () => sub.remove();
  }, []);
  const interactive = appActive && (keyboardUp || now - lastKeyAt.current < INTERACTIVE_AFTER_KEY_MS);
  useEffect(() => {
    connRef.current?.setInteractive(interactive);
  }, [interactive, frameState.painted]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const status: PaneStatus = terminalStatus({
    target, machineSettled, machine: machine ?? null, error, painted: frameState.painted, seenAt: frameState.seenAt, now, stalled: !!liveError, hydrated,
  });
  const canType = status === 'live' || status === 'paused';

  const send = useCallback((bytes: string) => {
    if (!bytes || !connRef.current) return;
    if (Date.now() - lastKeyAt.current >= INTERACTIVE_AFTER_KEY_MS) connRef.current.setInteractive(true);
    lastKeyAt.current = Date.now();
    gate.current?.send(bytes);
    // Typing is the person back at the prompt: the view follows the cursor again.
    webRef.current?.injectJavaScript('window.__ccFollow && window.__ccFollow(); true;');
  }, []);

  // Nothing is typed into a pane that is not taking input, and the model
  // forgets it too, so a later backspace never erases what never arrived.
  const onChangeText = useCallback((value: string) => {
    if (!canType) {
      setField(keyboard.current.reset());
      return;
    }
    if (ctrlArmed) {
      const before = plainKeyboardText(fieldNow.current.replace(SENTINEL, ''));
      const typed = plainKeyboardText(value.replace(SENTINEL, ''));
      const chord = typed.startsWith(before) ? ctrlChord(typed.slice(before.length)) : null;
      setCtrlArmed(false);
      if (chord) {
        setField(keyboard.current.reset());
        send(chord);
        return;
      }
    }
    fieldNow.current = value;
    const step = keyboard.current.change(value);
    send(step.bytes);
    setField(step.field);
  }, [canType, ctrlArmed, send, setField]);

  const onSubmit = useCallback(() => {
    if (!canType) {
      setField(keyboard.current.reset());
      return;
    }
    const step = keyboard.current.submit(fieldNow.current);
    send(step.bytes);
    setField(step.field);
  }, [canType, send, setField]);

  const pressKey = useCallback((key: QuickKey) => {
    void Haptics.selectionAsync();
    const withCtrl = ctrlArmed ? CTRL_KEY_BYTES[key] : undefined;
    setCtrlArmed(false);
    setField(keyboard.current.reset());
    send(withCtrl ?? QUICK_KEY_BYTES[key]);
  }, [ctrlArmed, send, setField]);

  const paste = useCallback(async (raw = false) => {
    void Haptics.selectionAsync();
    const text = await readClipboard();
    const bytes = text ? pasteBytes(text, raw) : '';
    if (!bytes) {
      setNotice('Clipboard is empty');
      return;
    }
    if (utf8Binary(bytes).length > MAX_PASTE_BYTES) {
      setNotice(`Paste too long: ${Math.ceil(utf8Binary(bytes).length / 1000)} KB, the limit is ${MAX_PASTE_BYTES / 1000} KB`);
      return;
    }
    setCtrlArmed(false);
    setField(keyboard.current.reset());
    send(bytes);
  }, [send, setField]);

  const openSnapshot = useCallback(() => {
    void Haptics.selectionAsync();
    const f = lastFrame.current;
    if (!f?.frame) return;
    inputRef.current?.blur();
    setSnapshot(snapshotText(f.frame, f.cols ?? 80, looksLikeTui(f.frame) ? 'tui' : 'shell'));
  }, []);

  const toggleKeyboard = useCallback(() => {
    void Haptics.selectionAsync();
    if (keyboardUp) inputRef.current?.blur();
    else inputRef.current?.focus();
  }, [keyboardUp]);

  const takeOffer = useCallback(() => {
    if (!offer) return;
    void copyToClipboard(offer.text);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true);
  }, [offer]);
  useEffect(() => {
    if (!offer) return;
    const t = setTimeout(() => setOffer(null), copied ? 1200 : OFFER_SHOWN_MS);
    return () => clearTimeout(t);
  }, [offer, copied]);
  const offerRedacted = !!offer && /\[redacted:[\w-]+\]/.test(offer.text);

  const onWebMessage = useCallback((e: any) => {
    let m: any;
    try { m = JSON.parse(e?.nativeEvent?.data ?? '{}'); } catch { return; }
    if (m.t === 'ready') {
      webReady.current = true;
      if (lastFrame.current) paint(lastFrame.current);
    } else if (m.t === 'tap') {
      if (canType) inputRef.current?.focus();
    } else if (m.t === 'error') {
      // Before the first paint there is nothing to keep: say it. After, a
      // fresh document repaints from the last frame on its 'ready'.
      if (!lastFrame.current) setError(m.message || 'terminal renderer failed');
      else {
        webReady.current = false;
        webRef.current?.reload();
      }
    }
  }, [canType, paint]);

  const machineName = machineLabel(machine?.label);
  const blocked = blockedCopy(status, { machineName, error, renderer: !!WebViewComp });
  // The blocked state unmounts the WebView: its successor paints only after
  // its own 'ready'.
  if (blocked) webReady.current = false;

  const keyOff = (local?: 'frame' | 'always') => (local === 'always' ? false : local === 'frame' ? !frameState.painted : !canType);
  // iOS reads a focused field's keyboard settings once: refocus to apply.
  const toggleAutoCorrect = () => {
    void Haptics.selectionAsync();
    setField(keyboard.current.reset());
    setAutoCorrect((a) => !a);
    if (keyboardUp) {
      inputRef.current?.blur();
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };
  // `local` keys act on this screen, not the pane: they work whenever there
  // is something to act on, the Interrupted state included.
  const keys: Array<{ key: string; label?: string; icon?: keyof typeof Feather.glyphMap; onPress: () => void; onLongPress?: () => void; wide?: boolean; on?: boolean; danger?: boolean; local?: 'frame' | 'always'; a11y: string }> = [
    // Most-used first, all within reach at rest on a phone: answering a
    // prompt is Enter, Esc, arrows and Tab; reading and copying out is Select.
    { key: 'enter', label: 'Enter', onPress: () => pressKey('enter'), wide: true, a11y: 'Enter' },
    { key: 'esc', label: 'Esc', onPress: () => pressKey('esc'), a11y: 'Escape' },
    { key: 'up', icon: 'arrow-up', onPress: () => pressKey('up'), a11y: 'Up arrow' },
    { key: 'down', icon: 'arrow-down', onPress: () => pressKey('down'), a11y: 'Down arrow' },
    { key: 'tab', label: 'Tab', onPress: () => pressKey('tab'), a11y: 'Tab' },
    { key: 'stab', label: '\u21e7Tab', onPress: () => pressKey('shiftTab'), a11y: 'Shift Tab' },
    { key: 'ctrl', label: 'Ctrl', on: ctrlArmed, onPress: () => { void Haptics.selectionAsync(); setCtrlArmed((c) => !c); if (!keyboardUp) inputRef.current?.focus(); }, a11y: ctrlArmed ? 'Control, armed for the next key' : 'Control, for the next key' },
    { key: 'select', icon: 'type', label: 'Select', onPress: openSnapshot, local: 'frame', a11y: 'Select text' },
    { key: 'paste', icon: 'clipboard', label: 'Paste', onPress: () => { void paste(); }, onLongPress: () => { void paste(true); }, a11y: 'Paste. Hold to paste without bracketing, for a password prompt' },
    { key: 'left', icon: 'arrow-left', onPress: () => pressKey('left'), a11y: 'Left arrow' },
    { key: 'right', icon: 'arrow-right', onPress: () => pressKey('right'), a11y: 'Right arrow' },
    { key: 'pgup', label: 'PgUp', onPress: () => pressKey('pageUp'), a11y: 'Page up' },
    { key: 'pgdn', label: 'PgDn', onPress: () => pressKey('pageDown'), a11y: 'Page down' },
    { key: 'aa', label: 'Aa', on: autoCorrect, onPress: toggleAutoCorrect, local: 'always', a11y: autoCorrect ? 'Autocorrect on' : 'Autocorrect off' },
    // Last, and marked: two of these exit an agent, so not where a scroll lands.
    { key: 'ctrlc', label: '^C', danger: true, onPress: () => pressKey('ctrlC'), a11y: 'Control C, interrupt' },
  ];

  return (
    <KeyboardAvoidingView style={[styles.root, { paddingTop: insets.top }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <RNView style={styles.header}>
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace(`/session/${conversationId}` as never))}
          hitSlop={12}
          style={styles.headerBtn}
          accessibilityRole="button"
          accessibilityLabel="Back to the conversation"
        >
          <FontAwesome name="chevron-left" size={17} color={Theme.text} />
        </Pressable>
        <RNView style={styles.headerTitleWrap}>
          <RNText style={styles.headerTitle} numberOfLines={1}>{title}</RNText>
          <RNView style={styles.statusRow}>
            <RNView style={[styles.statusDot, { backgroundColor: statusColor(status, Theme) }]} />
            <RNText style={styles.statusText} numberOfLines={1}>{statusLabel(status)}{machineName ? ` · ${machineName}` : ''}</RNText>
          </RNView>
        </RNView>
        <Pressable onPress={toggleKeyboard} hitSlop={10} style={styles.headerBtn} disabled={!canType && !keyboardUp} accessibilityRole="button" accessibilityLabel={keyboardUp ? 'Hide keyboard' : 'Show keyboard'}>
          <Feather name={keyboardUp ? 'chevron-down' : 'edit-3'} size={18} color={canType || keyboardUp ? Theme.text : Theme.textMuted0} />
        </Pressable>
      </RNView>

      <RNView style={styles.screen}>
        {WebViewComp && !blocked && (
          <WebViewComp
            ref={webRef}
            originWhitelist={['about:blank']}
            source={{ html }}
            onMessage={onWebMessage}
            onContentProcessDidTerminate={() => { webReady.current = false; webRef.current?.reload(); }}
            onRenderProcessGone={() => { webReady.current = false; webRef.current?.reload(); }}
            onShouldStartLoadWithRequest={(r: any) => r.url === 'about:blank'}
            javaScriptEnabled
            domStorageEnabled={false}
            scrollEnabled
            bounces={false}
            setSupportMultipleWindows={false}
            hideKeyboardAccessoryView
            keyboardDisplayRequiresUserAction
            style={styles.web}
            containerStyle={styles.web}
          />
        )}
        {!frameState.painted && !blocked && (
          <RNView style={styles.overlay} pointerEvents="none">
            <RNText style={styles.overlayText}>Connecting</RNText>
          </RNView>
        )}
        {blocked && (
          <RNView style={styles.overlay}>
            <Feather name={blocked.icon} size={22} color={Theme.textMuted} />
            <RNText style={styles.overlayText}>{blocked.text}</RNText>
            {blocked.retry && (
              <Pressable style={styles.retryBtn} onPress={() => { void Haptics.selectionAsync(); setAttempt((a) => a + 1); }} accessibilityRole="button">
                <RNText style={styles.retryText}>Retry</RNText>
              </Pressable>
            )}
          </RNView>
        )}
        {(liveError || notice) && (
          <RNView style={styles.noticeBar} pointerEvents="box-none">
            <Feather name={liveError ? 'wifi-off' : 'info'} size={13} color="#fdf6e3" />
            <RNText style={styles.noticeText} numberOfLines={2}>{liveError ? liveError.message : notice}</RNText>
            {liveError && (
              <Pressable onPress={() => { void Haptics.selectionAsync(); setAttempt((a) => a + 1); }} hitSlop={8} accessibilityRole="button" accessibilityLabel="Reconnect">
                <RNText style={styles.noticeAction}>Retry</RNText>
              </Pressable>
            )}
          </RNView>
        )}
        {offer && (
          <Pressable style={[styles.offer, { top: liveError || notice ? 58 : 10 }]} onPress={takeOffer} accessibilityRole="button" accessibilityLabel={copied ? 'Copied' : `Copy ${offer.text.length} characters from the terminal`}>
            <Feather name={copied ? 'check' : 'copy'} size={14} color={TERMINAL_BG} />
            <RNText style={styles.offerText} numberOfLines={1}>{copied ? 'Copied' : `Copy ${offer.text.length} chars${offerRedacted ? ' \u00b7 secrets hidden' : ''}`}</RNText>
            {!copied && (
              <Pressable onPress={() => setOffer(null)} hitSlop={10} accessibilityLabel="Dismiss">
                <Feather name="x" size={14} color={TERMINAL_BG} />
              </Pressable>
            )}
          </Pressable>
        )}
      </RNView>

      <RNView style={[styles.keyRow, !keyboardUp && { paddingBottom: Math.max(insets.bottom, 6) }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.keyRowContent}>
          {keys.map((k) => (
            <Pressable
              key={k.key}
              onPress={k.onPress}
              onLongPress={k.onLongPress}
              disabled={keyOff(k.local)}
              style={({ pressed }) => [styles.key, k.wide && styles.keyWide, k.on && styles.keyOn, pressed && styles.keyPressed, keyOff(k.local) && styles.keyDisabled]}
              accessibilityRole="button"
              accessibilityLabel={k.a11y}
              accessibilityState={k.on !== undefined ? { selected: k.on } : undefined}
            >
              {k.icon && <Feather name={k.icon} size={15} color={Theme.text} />}
              {k.label && <RNText style={[styles.keyText, k.danger && styles.keyTextDanger]}>{k.label}</RNText>}
            </Pressable>
          ))}
        </ScrollView>
      </RNView>

      <TextInput
        ref={inputRef}
        value={field.text}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
        onFocus={() => setKeyboardUp(true)}
        onBlur={() => setKeyboardUp(false)}
        blurOnSubmit={false}
        autoCorrect={autoCorrect}
        autoCapitalize="none"
        spellCheck={false}
        keyboardAppearance="dark"
        returnKeyType="send"
        caretHidden
        contextMenuHidden
        style={styles.hiddenInput}
        accessibilityLabel="Terminal keyboard"
      />

      <SelectTextSheet text={snapshot} onClose={() => setSnapshot(null)} textStyle={styles.snapshotText} />
    </KeyboardAvoidingView>
  );
}

function blockedCopy(status: PaneStatus, ctx: { machineName: string | null; error: string | null; renderer: boolean }):
  { icon: keyof typeof Feather.glyphMap; text: string; retry?: boolean } | null {
  if (!ctx.renderer) return { icon: 'download', text: 'Update the app to open terminals' };
  switch (status) {
    case 'no-pane': return { icon: 'terminal', text: 'No terminal for this session' };
    case 'unknown-machine': return { icon: 'help-circle', text: 'Machine not found' };
    case 'foreign': return { icon: 'lock', text: `Runs on ${ctx.machineName ?? "someone else's machine"}` };
    case 'error': return { icon: 'wifi-off', text: ctx.error ?? 'Not connected', retry: true };
    default: return null;
  }
}

function statusLabel(s: PaneStatus): string {
  switch (s) {
    case 'live': return 'Live';
    case 'paused': return 'Paused';
    case 'stalled': return 'Interrupted';
    case 'error': return 'Offline';
    case 'foreign': return 'Not yours';
    case 'no-pane': return 'No pane';
    case 'unknown-machine': return 'Unknown machine';
    default: return 'Connecting';
  }
}

function statusColor(s: PaneStatus, Theme: any): string {
  if (s === 'live') return Theme.greenBright ?? Theme.green;
  if (s === 'paused' || s === 'connecting' || s === 'resolving') return Theme.yellow ?? Theme.textMuted;
  return Theme.red ?? Theme.textMuted;
}

const styles = themedStyles((Theme) => StyleSheet.create({
  root: { flex: 1, backgroundColor: TERMINAL_BG },
  header: { flexDirection: 'row', alignItems: 'center', height: 48, paddingHorizontal: 8, gap: 6, backgroundColor: Theme.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.border },
  headerBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitleWrap: { flex: 1, minWidth: 0 },
  headerTitle: { fontSize: 14, fontFamily: Mono.semiBold, color: Theme.text },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 11, color: Theme.textMuted },
  screen: { flex: 1, backgroundColor: TERMINAL_BG },
  web: { flex: 1, backgroundColor: TERMINAL_BG },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 32 },
  overlayText: { color: '#93a1a1', fontSize: 13, textAlign: 'center' },
  retryBtn: { marginTop: 4, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#586e75' },
  retryText: { color: '#eee8d5', fontSize: 13, fontFamily: Mono.medium },
  noticeBar: { position: 'absolute', left: 10, right: 10, top: 10, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: 'rgba(220,50,47,0.92)' },
  noticeText: { flex: 1, color: '#fdf6e3', fontSize: 12, fontFamily: Mono.medium },
  noticeAction: { color: '#fdf6e3', fontSize: 12, fontFamily: Mono.bold, textDecorationLine: 'underline' },
  offer: { position: 'absolute', right: 10, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, height: 34, borderRadius: 17, backgroundColor: '#b58900', maxWidth: '80%' },
  offerText: { color: TERMINAL_BG, fontSize: 13, fontFamily: Mono.semiBold },
  keyRow: { backgroundColor: Theme.bgAlt ?? Theme.bg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.border, paddingTop: 6, paddingBottom: 6 },
  keyRowContent: { paddingHorizontal: 6, gap: 6 },
  key: { minWidth: 44, height: 40, paddingHorizontal: 10, borderRadius: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, backgroundColor: Theme.card ?? Theme.bg, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.border },
  keyWide: { minWidth: 64 },
  keyPressed: { opacity: 0.55 },
  keyOn: { backgroundColor: Theme.accent, borderColor: Theme.accent },
  keyTextDanger: { color: Theme.red },
  keyDisabled: { opacity: 0.35 },
  keyText: { fontSize: 13, fontFamily: Mono.medium, color: Theme.text },
  hiddenInput: { position: 'absolute', left: -1000, top: 0, width: 1, height: 1, opacity: 0 },
  snapshotText: { fontFamily: Mono.regular, fontSize: 13, lineHeight: 19, color: Theme.text },
}));
