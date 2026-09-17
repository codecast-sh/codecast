// Native TextInput after send: iOS keeps the previous buffer (IME, blur) and
// the next keystroke restores the just-sent text. Web's textarea does not do
// this, so the shared send-clear helpers live in staleDraft and this hook is
// the RN adapter — remount the native box, keep focus, ignore residue.

import { useCallback, useEffect, useRef, useState } from "react";
import type { TextInput } from "react-native";
import {
  composerTextAfterSend,
  isResurrectedComposerText,
} from "@codecast/web/lib/staleDraft";

const RESURRECT_WINDOW_MS = 800;

/** Prefer the native box's text when React state has not caught up yet (JS
 *  thread busy on a new session). `_lastNativeText` is what RN last heard
 *  from the field; fall back to the controlled value. */
export function nativeComposerText(
  input: { _lastNativeText?: unknown } | null | undefined,
  stateValue: string,
): string {
  const native = input && typeof input._lastNativeText === "string" ? input._lastNativeText : null;
  return native ?? stateValue;
}

export function useComposerField(initialText = "") {
  const [value, setValue] = useState(initialText);
  const [epoch, setEpoch] = useState(0);
  const inputRef = useRef<TextInput>(null);
  const sendingRef = useRef(false);
  const justSentRef = useRef<string | null>(null);
  const expireTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => {
    if (expireTimerRef.current) clearTimeout(expireTimerRef.current);
  }, []);

  const onChangeText = useCallback((next: string) => {
    if (sendingRef.current) return;
    const sent = justSentRef.current;
    if (sent) {
      const suffix = composerTextAfterSend(next, sent);
      if (suffix !== null) {
        if (next === sent) {
          setValue("");
          return;
        }
        justSentRef.current = null;
        setValue(suffix);
        return;
      }
      if (isResurrectedComposerText(next, sent)) return;
      justSentRef.current = null;
    }
    setValue(next);
  }, []);

  const clearAfterSend = useCallback((sent: string) => {
    sendingRef.current = true;
    const trimmed = sent.trim();
    justSentRef.current = trimmed || null;
    if (expireTimerRef.current) clearTimeout(expireTimerRef.current);
    if (trimmed) {
      expireTimerRef.current = setTimeout(() => {
        if (justSentRef.current === trimmed) justSentRef.current = null;
      }, RESURRECT_WINDOW_MS);
    }
    setValue("");
    setEpoch((n) => n + 1);
    sendingRef.current = false;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  return {
    value,
    setValue,
    onChangeText,
    epoch,
    inputRef,
    sendingRef,
    clearAfterSend,
  };
}
