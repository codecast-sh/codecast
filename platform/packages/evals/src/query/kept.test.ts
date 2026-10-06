import { describe, expect, it } from 'bun:test';
import { keptRead, stableRows } from '.';

/** A read that counts its calls and resolves or fails on the test's word. */
function gate<T>() {
  let calls = 0;
  const waiting: Array<{ ok: (v: T) => void; no: (e: Error) => void }> = [];
  const read = () => {
    calls++;
    return new Promise<T>((ok, no) => waiting.push({ ok, no }));
  };
  return { read, calls: () => calls, ok: (v: T) => waiting.shift()!.ok(v), no: () => waiting.shift()!.no(new Error('down')) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('keptRead', () => {
  it('shares a read in flight and an answer inside its age, then reads again', async () => {
    let t = 0;
    const g = gate<number>();
    const get = keptRead(g.read, { maxAgeMs: 10, now: () => t });
    const [a, b] = [get(), get()];
    g.ok(1);
    expect([await a, await b, g.calls()]).toEqual([1, 1, 1]);
    t = 9;
    expect([await get(), g.calls()]).toEqual([1, 1]);
    t = 10;
    const c = get();
    g.ok(2);
    expect([await c, g.calls()]).toEqual([2, 2]);
  });

  it('never keeps a failed read: the next caller reads again', async () => {
    let t = 0;
    const g = gate<number>();
    const get = keptRead(g.read, { maxAgeMs: 10, now: () => t });
    const a = get();
    g.no();
    await expect(a).rejects.toThrow('down');
    const b = get();
    g.ok(3);
    expect([await b, g.calls()]).toEqual([3, 2]);
    // Past its age, a caller waits for the new read, and a failure reaches it.
    t = 20;
    const c = get();
    g.no();
    await expect(c).rejects.toThrow('down');
  });

  it('past its age hands the last answer at once and refreshes behind it, keeping the last on a failure', async () => {
    let t = 0;
    const g = gate<number>();
    const get = keptRead(g.read, { maxAgeMs: 10, staleWhileRevalidate: true, now: () => t });
    const first = get();
    g.ok(1);
    expect(await first).toBe(1);
    t = 15;
    expect([await get(), await get(), g.calls()]).toEqual([1, 1, 2]);
    g.no();
    await flush();
    expect([await get(), g.calls()]).toEqual([1, 3]);
    g.ok(4);
    await flush();
    expect([await get(), g.calls()]).toEqual([4, 3]);
  });
});

describe('stableRows', () => {
  it('hands back the last array while the signature holds', () => {
    const same = stableRows<{ id: string; score: number }>();
    const a = same([{ id: 'a', score: 1 }]);
    expect(same([{ id: 'a', score: 1 }])).toBe(a);
    const b = same([{ id: 'a', score: 2 }]);
    expect(b).not.toBe(a);
    expect(b).toEqual([{ id: 'a', score: 2 }]);
  });

  it('takes a cheaper signature', () => {
    const byLength = stableRows<number>((rows) => String(rows.length));
    const a = byLength([1, 2]);
    expect(byLength([3, 4])).toBe(a);
  });
});
