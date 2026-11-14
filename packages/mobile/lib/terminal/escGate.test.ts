import { describe, expect, test } from 'bun:test';
import { ESC, ESC_MAX_WAIT_MS, EscGate } from './escGate';

function rig() {
  const out: string[] = [];
  const acks: Array<() => void> = [];
  let seen = 100;
  let pending: { fn: () => void; ms: number } | null = null;
  const gate = new EscGate((b, onQueued) => { out.push(b); if (onQueued) acks.push(onQueued); }, () => seen, {
    set: (fn, ms) => { pending = { fn, ms }; return 1 as any; },
    clear: () => { pending = null; },
  });
  return { gate, out, setSeen: (n: number) => { seen = n; }, ack: () => acks.shift()?.(), fire: () => pending?.fn(), pendingMs: () => pending?.ms };
}

describe('EscGate', () => {
  test('keys pass straight through when no Esc is waiting', () => {
    const r = rig();
    r.gate.send('a');
    r.gate.send('\x1b[A');
    expect(r.out).toEqual(['a', '\x1b[A']);
  });
  test('a push heard before the relay accepted the Esc releases nothing', () => {
    const r = rig();
    r.gate.send(ESC);
    r.gate.send('\r');
    r.gate.heard(500);
    expect(r.out).toEqual([ESC]);
  });
  test('after the relay accepts the Esc, the next push releases the keys behind it', () => {
    const r = rig();
    r.gate.send(ESC);
    r.gate.send('\r');
    r.setSeen(200);
    r.ack();
    r.gate.heard(200);
    expect(r.out).toEqual([ESC]);
    r.gate.heard(250);
    expect(r.out).toEqual([ESC, '\r']);
  });
  test('an Esc inside the held keys holds again, in order', () => {
    const r = rig();
    r.gate.send(ESC);
    r.gate.send('x');
    r.gate.send(ESC);
    r.gate.send('y');
    r.ack();
    r.gate.heard(110);
    expect(r.out).toEqual([ESC, 'x', ESC]);
    r.setSeen(110);
    r.ack();
    r.gate.heard(130);
    expect(r.out).toEqual([ESC, 'x', ESC, 'y']);
  });
  test('a relay that refuses or a loop that goes quiet releases after the cap', () => {
    const r = rig();
    r.gate.send(ESC);
    r.gate.send('q');
    expect(r.pendingMs()).toBe(ESC_MAX_WAIT_MS);
    r.fire();
    expect(r.out).toEqual([ESC, 'q']);
  });
  test('dispose drops what was held', () => {
    const r = rig();
    r.gate.send(ESC);
    r.gate.send('q');
    r.gate.dispose();
    r.ack();
    r.gate.heard(500);
    expect(r.out).toEqual([ESC]);
  });
  test('a relay failure releases the held keys at once', () => {
    const r = rig();
    r.gate.send(ESC);
    r.gate.send('q');
    r.gate.unblock();
    expect(r.out).toEqual([ESC, 'q']);
  });
});
