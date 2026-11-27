// The language dictation listens for, kept on this phone (the web keeps its
// own per browser): a person who dictates Spanish on the phone and English at
// the desk picks each once. null is Auto, the device's own languages.
//
// SecureStore is the device-local store the app already ships (biometric
// lock, last principal); its synchronous read lets the menu's check paint on
// the first frame.

import { useSyncExternalStore } from 'react';
import * as SecureStore from 'expo-secure-store';
import { DICTATION_LANGUAGES } from '@codecast/shared/contracts';

const KEY = 'codecast.dictation_language';

let choice: string | null | undefined;
const listeners = new Set<() => void>();

export function getDictationLanguage(): string | null {
  if (choice === undefined) {
    let stored: string | null = null;
    try {
      stored = SecureStore.getItem(KEY);
    } catch {}
    choice = stored && DICTATION_LANGUAGES.some((l) => l.code === stored) ? stored : null;
  }
  return choice;
}

export function setDictationLanguage(code: string | null) {
  choice = code;
  listeners.forEach((l) => l());
  try {
    if (code) SecureStore.setItem(KEY, code);
    else void SecureStore.deleteItemAsync(KEY).catch(() => {});
  } catch {}
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useDictationLanguage(): string | null {
  return useSyncExternalStore(subscribe, getDictationLanguage, getDictationLanguage);
}
