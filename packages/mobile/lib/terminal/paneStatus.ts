// What the phone terminal can say about its pane, decided without React Native.

export type PaneStatus = 'resolving' | 'no-pane' | 'unknown-machine' | 'foreign' | 'connecting' | 'live' | 'paused' | 'stalled' | 'error';

/** No frame or heartbeat for this long reads as a pane that went quiet on the far side. Comfortably above the daemon's heartbeat. */
export const PANE_STALE_AFTER_MS = 12_000;

export function terminalStatus(s: {
  target: string | null;
  machineSettled: boolean;
  machine: { is_mine: boolean } | null;
  error: string | null;
  painted: boolean;
  seenAt: number | null;
  now: number;
  /** A relay refusal or pane error after frames were arriving, not yet followed by word from the far loop. */
  stalled?: boolean;
  /** The store has loaded: before that a missing pane name means "not known yet", not "none". */
  hydrated?: boolean;
}): PaneStatus {
  if (!s.target) return s.hydrated === false ? 'resolving' : 'no-pane';
  if (!s.machineSettled) return 'resolving';
  if (!s.machine) return 'unknown-machine';
  if (!s.machine.is_mine) return 'foreign';
  if (s.error && !s.painted) return 'error';
  if (!s.painted) return 'connecting';
  if (s.stalled) return 'stalled';
  return s.seenAt !== null && s.now - s.seenAt > PANE_STALE_AFTER_MS ? 'paused' : 'live';
}

/**
 * A JS string as the byte string remotePane.write takes (one char per byte,
 * 0-255): the relay sends `charCodeAt & 0xff`, so anything past Latin-1 must
 * be UTF-8 encoded first or an emoji arrives as garbage.
 */
export function utf8Binary(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out += ch;
    else if (c < 0x800) out += String.fromCharCode(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out += String.fromCharCode(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out += String.fromCharCode(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}
