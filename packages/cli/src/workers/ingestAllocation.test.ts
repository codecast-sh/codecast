import { expect, test } from 'bun:test';
import { AllocationRefused, IngestAllocation, addAllocationVectors, checkedAllocationAdd, checkedAllocationMultiply, multiplyAllocationVector, type AllocationVector } from './ingestAllocation.js';

const amount = (n: number): AllocationVector => ({ bufferBytes: n, utf16Units: n, graphNodes: n, graphEdges: n });
const identity = (owner = 'full/session/a', attempt = 1) => ({ owner, generation: 'dev/ino/birth', attempt });
const main = { kind: 'main' } as const;
const limits = { capacity: amount(10), maxRoots: 4, maxReferencesPerRoot: 8, maxTransfersPerReference: 4, maxIdentityUnits: 128 };
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('owned child exit retires a root whose only child reference already settled',async()=>{
  for(const settled of ['release','run']){
    const accounting=new IngestAllocation({...limits,maxRoots:1}),operation=accounting.open(identity());
    const child={kind:'child' as const,pid:123,generation:'child-owned'},reference=operation.borrow('child','child',amount(3),child);
    if(settled==='release')expect(reference.release()).toBe(true);else await reference.run(async()=> 'settled');
    expect(accounting.snapshot()).toEqual({roots:1,references:0,used:amount(0)});
    accounting.ownedChildExited({...child,generation:'different'});expect(operation.closed).toBe(false);
    accounting.ownedChildExited(child);expect(operation.closed).toBe(true);expect(accounting.snapshot()).toEqual({roots:0,references:0,used:amount(0)});
    const next=accounting.open(identity('next'));accounting.ownedChildExited(child);expect(next.closed).toBe(false);next.close();expect(accounting.snapshot().roots).toBe(0);
  }
});

test('allocation arithmetic refuses unsafe counts and overflow before mutating capacity', () => {
  for (const bad of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => checkedAllocationAdd(bad, 0)).toThrow(AllocationRefused);
    expect(() => checkedAllocationMultiply(0, bad)).toThrow(AllocationRefused);
    expect(() => new IngestAllocation({ ...limits, capacity: amount(bad) })).toThrow(AllocationRefused);
  }
  expect(checkedAllocationAdd(Number.MAX_SAFE_INTEGER - 1, 1)).toBe(Number.MAX_SAFE_INTEGER);
  expect(checkedAllocationMultiply(Number.MAX_SAFE_INTEGER, 0)).toBe(0);
  expect(() => checkedAllocationAdd(Number.MAX_SAFE_INTEGER, 1)).toThrow(AllocationRefused);
  expect(() => checkedAllocationMultiply(Number.MAX_SAFE_INTEGER, 2)).toThrow(AllocationRefused);
  expect(addAllocationVectors(amount(2), amount(3))).toEqual(amount(5));
  expect(multiplyAllocationVector(amount(2), 3)).toEqual(amount(6));
  expect(() => new IngestAllocation({ ...limits, maxRoots: Number.MAX_SAFE_INTEGER })).toThrow(AllocationRefused);
});

test('global accounting refuses a combined allocation before the caller allocates, with small-owner progress', () => {
  const accounting = new IngestAllocation(limits);
  const a = accounting.open(identity()), b = accounting.open(identity('full/session/b'));
  const read = a.borrow('raw', 'read', amount(6), main);
  let allocated = 0;
  const allocate = (n: number) => { const ref = b.borrow('sdk', 'sdk', amount(n), main); allocated++; return ref; };
  expect(() => allocate(5)).toThrow(AllocationRefused);
  expect(allocated).toBe(0);
  const small = allocate(4);
  expect(accounting.snapshot().used).toEqual(amount(10));
  b.close(); expect(small.release()).toBe(true);
  expect(accounting.snapshot()).toEqual({ roots: 1, references: 1, used: amount(6) });
  a.close(); expect(read.release()).toBe(true);
  expect(accounting.snapshot()).toEqual({ roots: 0, references: 0, used: amount(0) });
});

test('same serials in different accountants are never same-root authority', () => {
  const a = new IngestAllocation(limits), b = new IngestAllocation(limits);
  const first = a.open(identity()), second = b.open(identity());
  expect(first.serial).toBe(second.serial);
  const ref = first.borrow('raw', 'reader', amount(1), main);
  expect(first.owns(ref)).toBe(true); expect(second.owns(ref)).toBe(false);
  const next = ref.transfer('prep');
  expect(first.owns(ref)).toBe(false); expect(first.owns(next)).toBe(true);
  first.close(); second.close(); expect(first.owns(next)).toBe(false); next.release();
});

test('full owner/generation identity, bounded zero-cost references and captured limits remain distinct', () => {
  const mutable = { ...limits, capacity: { ...amount(10) }, maxReferencesPerRoot: 1 };
  const accounting = new IngestAllocation(mutable);
  mutable.capacity.bufferBytes = 1000; mutable.maxReferencesPerRoot = 1000;
  const a = accounting.open(identity('same-prefix-one')), b = accounting.open(identity('same-prefix-two'));
  expect(accounting.open(identity('same-prefix-one'))).toBe(a);
  expect(a).not.toBe(b);
  const ref = a.borrow('zero', 'read', amount(0), main);
  expect(a.borrow('zero', 'read', amount(0), main)).toBe(ref);
  expect(() => a.borrow('second', 'read', amount(0), main)).toThrow(AllocationRefused);
  expect(() => b.borrow('large', 'read', amount(11), main)).toThrow(AllocationRefused);
  ref.release();
  expect(() => a.borrow('zero', 'read', amount(0), main)).toThrow(AllocationRefused);
  a.close(); b.close();
  const successor = accounting.open(identity('same-prefix-one'));
  expect(successor.serial).toBeGreaterThan(a.serial);
  expect(() => a.borrow('late', 'read', amount(1), main)).toThrow(AllocationRefused);
  successor.close();
});

test('transfer is idempotent for a repeated handoff and stale handles cannot release successors', () => {
  const accounting = new IngestAllocation(limits), root = accounting.open(identity());
  const raw = root.borrow('raw', 'reader', amount(8), main), prep = raw.transfer('preparation');
  expect(raw.transfer('preparation')).toBe(prep);
  expect(raw.release()).toBe(false);
  expect(() => raw.check()).toThrow(AllocationRefused);
  expect(() => raw.transfer('codec')).toThrow(AllocationRefused);
  const sdk = prep.transfer('sdk');
  expect(prep.transfer('sdk')).toBe(sdk);
  expect(() => raw.transfer('preparation')).toThrow(AllocationRefused);
  expect(accounting.snapshot().used).toEqual(amount(8));
  root.close(); expect(sdk.release()).toBe(true); expect(sdk.release()).toBe(false);
  expect(accounting.snapshot().roots).toBe(0);
});

test('cancelled owners retain uncancellable work and root admission until actual settlement', async () => {
  const accounting = new IngestAllocation({ ...limits, maxRoots: 1 }), root = accounting.open(identity());
  const ref = root.borrow('network', 'sdk', amount(10), main), work = deferred<number>();
  const completion = ref.releaseAfter(work.promise);
  expect(ref.releaseAfter(work.promise)).toBe(completion);
  expect(ref.release()).toBe(false);
  expect(() => ref.transfer('late')).toThrow(AllocationRefused);
  root.close();
  expect(() => root.borrow('late', 'read', amount(0), main)).toThrow(AllocationRefused);
  expect(() => accounting.open(identity('next'))).toThrow(AllocationRefused);
  expect(accounting.snapshot().used).toEqual(amount(10));
  work.resolve(7); expect(await completion).toBe(7);
  expect(accounting.snapshot().roots).toBe(0);
  const next = accounting.open(identity('next'));
  expect(next.serial).toBeGreaterThan(root.serial); next.close();
});

test('rejection releases only after settlement and retains the original error', async () => {
  const accounting = new IngestAllocation(limits), root = accounting.open(identity());
  const ref = root.borrow('raw', 'read', amount(4), main), work = deferred<void>();
  const completion = ref.releaseAfter(work.promise), error = new Error('unknown response');
  root.close(); work.reject(error);
  await expect(completion).rejects.toBe(error);
  expect(accounting.snapshot().used).toEqual(amount(0));
});

test('exact owned child death releases its representations while main copies and reused PID generations remain charged', async () => {
  const accounting = new IngestAllocation(limits), root = accounting.open(identity());
  const oldChild = { kind: 'child', pid: 123, generation: 'launch-1' } as const;
  const newChild = { kind: 'child', pid: 123, generation: 'launch-2' } as const;
  const childRef = root.borrow('child', 'sdk', amount(4), oldChild), mainRef = root.borrow('copy', 'main', amount(2), main);
  const work = deferred<void>(), completion = childRef.releaseAfter(work.promise);
  const successor = accounting.open(identity('successor')), next = successor.borrow('child', 'sdk', amount(4), newChild);
  accounting.ownedChildExited(oldChild);
  expect(root.closed).toBe(true);
  expect(accounting.snapshot().used).toEqual(amount(6));
  expect(() => root.borrow('after-death', 'read', amount(1), oldChild)).toThrow(AllocationRefused);
  accounting.ownedChildExited(oldChild);
  expect(accounting.snapshot().used).toEqual(amount(6));
  mainRef.release(); work.resolve(); await completion;
  expect(accounting.snapshot().used).toEqual(amount(4));
  successor.close(); next.release();
  expect(accounting.snapshot().roots).toBe(0);
});

test('four retained cursors and borrowed preparation SDK codec share one finite capacity', () => {
  const accounting = new IngestAllocation({ ...limits, capacity: amount(20) });
  const roots = Array.from({ length: 4 }, (_, i) => accounting.open(identity(`source/${i}`)));
  const raw = roots.map((root, i) => root.borrow(`raw/${i}`, 'cursor', amount(2), main));
  const prep = roots[0].borrow('prep', 'preparation', amount(4), main);
  const sdk = roots[0].borrow('sdk', 'sdk', amount(4), main);
  expect(() => roots[0].borrow('codec', 'codec', amount(5), main)).toThrow(AllocationRefused);
  const codec = roots[1].borrow('codec', 'codec', amount(4), main);
  expect(accounting.snapshot().used).toEqual(amount(20));
  roots[1].close(); raw[1].release(); codec.release();
  expect(accounting.snapshot().used).toEqual(amount(14));
  roots.forEach(root => root.close()); raw.forEach(ref => ref.release()); prep.release(); sdk.release();
  expect(accounting.snapshot()).toEqual({ roots: 0, references: 0, used: amount(0) });
});

test('run reserves before callback invocation and refuses duplicate or reentrant starts', async () => {
  const accounting = new IngestAllocation(limits), root = accounting.open(identity());
  const ref = root.borrow('raw', 'read', amount(4), main), work = deferred<number>(), began = deferred<void>();
  let starts = 0;
  const completion = ref.run(() => {
    starts++;
    expect(() => ref.run(async () => { starts++; return 9; })).toThrow(AllocationRefused);
    expect(ref.release()).toBe(false);
    expect(() => ref.transfer('other')).toThrow(AllocationRefused);
    began.resolve();
    return work.promise;
  });
  expect(starts).toBe(0);
  expect(() => ref.run(async () => { starts++; return 8; })).toThrow(AllocationRefused);
  await began.promise;
  expect(starts).toBe(1);
  root.close(); expect(accounting.snapshot().used).toEqual(amount(4));
  work.resolve(7); expect(await completion).toBe(7);
  expect(accounting.snapshot()).toEqual({ roots: 0, references: 0, used: amount(0) });
  expect(() => ref.run(async () => { starts++; return 6; })).toThrow(AllocationRefused);
  expect(starts).toBe(1);
});

test('run preserves exact synchronous failures and later rejections until real settlement', async () => {
  for (const synchronous of [true, false]) {
    const accounting = new IngestAllocation(limits), root = accounting.open(identity());
    const ref = root.borrow('raw', 'read', amount(4), main), error = new Error('start failure'), work = deferred<number>(), began = deferred<void>();
    const completion = ref.run(() => {
      began.resolve();
      if (synchronous) throw error;
      return work.promise;
    });
    const observed = completion.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await began.promise;
    root.close();
    if (!synchronous) { expect(accounting.snapshot().used).toEqual(amount(4)); work.reject(error); }
    const outcome = await observed;
    expect(outcome.error).toBe(error);
    expect(outcome.value).toBeUndefined();
    expect(accounting.snapshot()).toEqual({ roots: 0, references: 0, used: amount(0) });
  }
});

test('run rejects stale or closed authority and fences cancellation before its callback begins', async () => {
  const accounting = new IngestAllocation(limits), root = accounting.open(identity());
  const original = root.borrow('raw', 'read', amount(4), main), ref = original.transfer('scan');
  let starts = 0;
  const start = async () => { starts++; return 1; };
  expect(() => original.run(start)).toThrow(AllocationRefused);
  const completion = ref.run(start);
  root.close();
  expect(() => ref.run(start)).toThrow(AllocationRefused);
  expect(accounting.snapshot().used).toEqual(amount(4));
  await expect(completion).rejects.toBeInstanceOf(AllocationRefused);
  expect(starts).toBe(0); expect(accounting.snapshot().roots).toBe(0);
});
