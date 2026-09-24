// Whether this browser shows the "hooks are off" mark on sessions from a given
// machine. Per browser on purpose: someone who turned the hooks off wants the
// mark gone where they read sessions, and it says nothing about the machine.
import { useSyncExternalStore } from "react";

const KEY = (deviceId: string) => `codecast:hooks-reminder-hidden:${deviceId}`;
const EVENT = "codecast:hooks-reminder";

export function hooksReminderHidden(deviceId: string): boolean {
  try {
    return localStorage.getItem(KEY(deviceId)) === "1";
  } catch {
    return false;
  }
}

export function setHooksReminderHidden(deviceId: string, hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(KEY(deviceId), "1");
    else localStorage.removeItem(KEY(deviceId));
  } catch { /* storage unavailable: the mark stays */ }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useHooksReminderHidden(deviceId: string | null | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (deviceId ? hooksReminderHidden(deviceId) : false),
    () => false,
  );
}
