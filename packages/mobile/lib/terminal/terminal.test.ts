import { describe, expect, test } from 'bun:test';
import { DEL, ENTER, SENTINEL, SentinelInput, bracketedPaste, correctionDelta, ctrlChord, pasteBytes } from './terminalInput';
import { findWrappedRows, looksLikeTui, snapshotText } from './snapshotRejoin';
import { STUCK_AFTER_MS, sessionTerminalOffer, terminalOffer } from './terminalOffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PANE_STALE_AFTER_MS, terminalStatus, utf8Binary } from './paneStatus';

describe('correctionDelta', () => {
  test('appends and deletes by the common prefix', () => {
    expect(correctionDelta('hel', 'hello')).toBe('lo');
    expect(correctionDelta('hello', 'help')).toBe(DEL.repeat(2) + 'p');
  });
  test('an explicit replacement goes out bracketed', () => {
    expect(correctionDelta('teh', 'the', true)).toBe(DEL.repeat(2) + bracketedPaste('he'));
  });
  test('never splits a code point', () => {
    expect(correctionDelta('a😀', 'a')).toBe(DEL);
  });
});

describe('SentinelInput', () => {
  test('typing one key at a time sends each key', () => {
    const k = new SentinelInput();
    let f = k.reset();
    const out: string[] = [];
    for (const ch of 'hi') {
      const s = k.change(f + ch);
      out.push(s.bytes);
      f = s.field;
    }
    expect(out).toEqual(['h', 'i']);
    expect(f).toBe(SENTINEL + 'hi');
  });

  test('backspace on an empty field still reaches the pane', () => {
    const k = new SentinelInput();
    k.reset();
    expect(k.change('')).toEqual({ bytes: DEL, field: SENTINEL });
  });

  test('backspace over typed text erases it and the sentinel survives', () => {
    const k = new SentinelInput();
    k.change(SENTINEL + 'ab');
    expect(k.change(SENTINEL + 'a')).toEqual({ bytes: DEL, field: SENTINEL + 'a' });
  });

  test('an autocorrect pick replaces the word as typed keys, never bracketed', () => {
    const k = new SentinelInput();
    k.change(SENTINEL + 'teh');
    expect(k.change(SENTINEL + 'the ').bytes).toBe(DEL.repeat(2) + 'he ');
  });

  test('iOS non-breaking space is a space', () => {
    const k = new SentinelInput();
    expect(k.change(SENTINEL + 'a\u00a0').bytes).toBe('a ');
  });

  test('smart punctuation reaches the pane as plain ASCII', () => {
    const k = new SentinelInput();
    expect(k.change(SENTINEL + '\u201cx\u201d').bytes).toBe('"x"');
    const d = new SentinelInput();
    d.change(SENTINEL + 'claude -');
    // iOS turns a second hyphen into an em dash, replacing the first.
    expect(d.change(SENTINEL + 'claude \u2014').bytes).toBe('-');
  });

  test('a newline in the field ends the line and starts a fresh one', () => {
    const k = new SentinelInput();
    k.change(SENTINEL + 'ok');
    const s = k.change(SENTINEL + 'ok\nnext');
    expect(s.bytes).toBe(ENTER + 'next');
    expect(s.field).toBe(SENTINEL + 'next');
  });

  test('submit sends pending text then one Enter', () => {
    const k = new SentinelInput();
    k.change(SENTINEL + 'y');
    expect(k.submit(SENTINEL + 'y')).toEqual({ bytes: ENTER, field: SENTINEL });
    expect(k.submit(SENTINEL)).toEqual({ bytes: ENTER, field: SENTINEL });
  });

  test('select-all delete erases what was typed, not one more', () => {
    const k = new SentinelInput();
    k.change(SENTINEL + 'abc');
    expect(k.change('').bytes).toBe(DEL.repeat(3));
  });

  test('a field the keyboard replaced whole (sentinel gone) is diffed, not dropped', () => {
    const k = new SentinelInput();
    k.change(SENTINEL + 'abc');
    expect(k.change('xyz').bytes).toBe(DEL.repeat(3) + 'xyz');
  });
});

describe('pasteBytes', () => {
  test('brackets and strips control bytes that could end the bracket', () => {
    expect(pasteBytes('a\x1b[201~b\r\nc')).toBe(bracketedPaste('a[201~b\nc'));
    expect(pasteBytes('')).toBe('');
  });
  test('raw paste has no markers and ends lines with Return', () => {
    expect(pasteBytes('tok\nen', true)).toBe('tok\ren');
  });
});

describe('ctrlChord', () => {
  test('maps letters and the usual punctuation', () => {
    expect(ctrlChord('d')).toBe('\x04');
    expect(ctrlChord('R')).toBe('\x12');
    expect(ctrlChord('[')).toBe('\x1b');
    expect(ctrlChord(' ')).toBe('\x00');
    expect(ctrlChord('1')).toBeNull();
    expect(ctrlChord('ab')).toBeNull();
  });
});

describe('snapshotText', () => {
  const cols = 20;
  test('rejoins a TUI word wrap', () => {
    const frame = ['The quick brown fox', 'jumps over the lazy', 'dog.', '', '> prompt'].join('\n');
    expect(snapshotText(frame, cols, 'tui')).toBe('The quick brown fox jumps over the lazy dog.\n\n> prompt');
  });
  test('joins a broken URL with no space', () => {
    const frame = ['https://example.com/', 'path/to/thing'].join('\n');
    expect(snapshotText(frame, cols, 'tui')).toBe('https://example.com/path/to/thing');
  });
  test('keeps list items and box drawing apart', () => {
    const rows = ['1. first item here x', '2. second', '\u2502 boxed row here   \u2502', 'after the box'];
    expect(findWrappedRows(rows, cols)).toEqual([null, null, null]);
  });
  test('a full-width rule comes out short', () => {
    expect(snapshotText('above\n' + '\u2500'.repeat(200) + '\nbelow', 200, 'tui')).toBe('above\n' + '\u2500'.repeat(12) + '\nbelow');
  });
  test('strips colors and keeps a shell as rows', () => {
    const frame = '\x1b[32m$ ls\x1b[0m   \nREADME.md package.js\non\n\n';
    expect(snapshotText(frame, cols, 'shell')).toBe('$ ls\nREADME.md package.js\non');
  });
});

describe('terminalOffer', () => {
  const now = 1_000_000;
  const base = { reachable: true, isLive: true, agentBusy: false, now, pendingSince: now - 1000 };
  test('a send held for a dialog offers the terminal', () => {
    expect(terminalOffer({ ...base, holdReason: 'waiting for a human answer in the terminal' })).toBe('held');
  });
  test('a signed-out agent offers it', () => {
    expect(terminalOffer({ ...base, holdReason: 'the agent is signed out on this machine: run its login there, then restart the session' })).toBe('held');
  });
  test('a hold the pane cannot clear does not', () => {
    expect(terminalOffer({ ...base, holdReason: 'needs the GITHUB_TOKEN key', pendingSince: now - STUCK_AFTER_MS * 10 })).toBeNull();
  });
  test('an undelivered send on a live session counts after the grace', () => {
    const stuck = { ...base, holdReason: null, pendingSince: now - STUCK_AFTER_MS - 1 };
    expect(terminalOffer(stuck)).toBe('stuck');
    expect(terminalOffer({ ...stuck, pendingSince: now - 1000 })).toBeNull();
    expect(terminalOffer({ ...stuck, isLive: false })).toBeNull();
    expect(terminalOffer({ ...stuck, agentBusy: true })).toBeNull();
    expect(terminalOffer({ ...stuck, pendingSince: null })).toBeNull();
  });
  test('nothing without a reachable pane', () => {
    expect(terminalOffer({ ...base, reachable: false, holdReason: 'waiting for a human answer in the terminal' })).toBeNull();
  });
});

describe('terminalStatus', () => {
  const s = { target: 'cc-1', machineSettled: true, machine: { is_mine: true }, error: null, painted: true, seenAt: 1000, now: 2000 };
  test('walks the states', () => {
    expect(terminalStatus({ ...s, target: null })).toBe('no-pane');
    expect(terminalStatus({ ...s, target: null, hydrated: false })).toBe('resolving');
    expect(terminalStatus({ ...s, machineSettled: false })).toBe('resolving');
    expect(terminalStatus({ ...s, machine: null })).toBe('unknown-machine');
    expect(terminalStatus({ ...s, machine: { is_mine: false } })).toBe('foreign');
    expect(terminalStatus({ ...s, painted: false })).toBe('connecting');
    expect(terminalStatus({ ...s, painted: false, error: 'x' })).toBe('error');
    expect(terminalStatus({ ...s, error: 'blip' })).toBe('live');
    expect(terminalStatus({ ...s, now: 1000 + PANE_STALE_AFTER_MS + 1 })).toBe('paused');
  });
});

describe('utf8Binary', () => {
  test('encodes past ASCII into one char per byte', () => {
    expect(utf8Binary('a')).toBe('a');
    expect([...utf8Binary('é')].map((c) => c.charCodeAt(0))).toEqual([0xc3, 0xa9]);
    expect([...utf8Binary('😀')].map((c) => c.charCodeAt(0))).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });
});

describe('sessionTerminalOffer', () => {
  const now = 1_000_000;
  const base = { reachable: true, isLive: true, agentBusy: false, now };
  test('a held row anywhere in the queue offers, whatever the primary shows', () => {
    const pending = { status: 'delivered', inflight: [{ status: 'pending', hold_reason: 'waiting for a human answer in the terminal', created_at: now - 1000 }] };
    expect(sessionTerminalOffer({ ...base, pending }).offer).toBe('held');
  });
  test('a fresh send schedules the moment it would count as stuck', () => {
    const r = sessionTerminalOffer({ ...base, pending: { status: 'pending', created_at: now - 1000 } });
    expect(r).toEqual({ offer: null, nextAt: now - 1000 + STUCK_AFTER_MS + 1 });
  });
  test('the soonest crossing wins among several sends', () => {
    const pending = { status: 'pending', created_at: now - 1000, inflight: [{ status: 'pending', created_at: now - 30_000 }] };
    expect(sessionTerminalOffer({ ...base, pending }).nextAt).toBe(now - 30_000 + STUCK_AFTER_MS + 1);
  });
  test('a send parked for the end of the turn is not stuck', () => {
    expect(sessionTerminalOffer({ ...base, pending: { status: 'pending', queued: true, created_at: now - STUCK_AFTER_MS * 2 } })).toEqual({ offer: null, nextAt: null });
  });
  test('delivered and cancelled rows count for nothing', () => {
    expect(sessionTerminalOffer({ ...base, pending: { status: 'delivered', created_at: 0 } })).toEqual({ offer: null, nextAt: null });
  });
});

describe('the daemon still says what PANE_HOLD matches', () => {
  // terminalOffer reads the daemon's hold wording; a rewording there would
  // silently end the held offer.
  const daemon = readFileSync(join(import.meta.dir, '../../../cli/src/daemon.ts'), 'utf8');
  test('both hold phrases are in daemon.ts', () => {
    expect(daemon).toContain('waiting for a human answer in the terminal');
    expect(daemon).toContain('is signed out on this machine');
  });
});

describe('looksLikeTui', () => {
  test('box drawing or an agent prompt is a TUI; a bare shell is not', () => {
    expect(looksLikeTui('\u256d\u2500\u2500\u256e\n\u2502 > \u2502')).toBe(true);
    expect(looksLikeTui('some output\n\u276f type here')).toBe(true);
    expect(looksLikeTui('$ ls\nREADME.md  package.json')).toBe(false);
  });
});
