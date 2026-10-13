export type AllocationVector = Readonly<{
  bufferBytes: number;
  utf16Units: number;
  graphNodes: number;
  graphEdges: number;
}>;
export type AllocationIdentity = Readonly<{ owner: string; generation: string; attempt: number }>;
export type AllocationProcess = Readonly<{ kind: 'main' } | { kind: 'child'; pid: number; generation: string }>;
export type AllocationLimits = Readonly<{
  capacity: AllocationVector;
  maxRoots: number;
  maxReferencesPerRoot: number;
  maxTransfersPerReference: number;
  maxIdentityUnits: number;
}>;
export class AllocationRefused extends Error {
  constructor(readonly reason: 'arithmetic' | 'capacity' | 'identity' | 'closed' | 'stale' | 'busy') {
    super(`ingest allocation refused: ${reason}`);
  }
}
export function checkedAllocationCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new AllocationRefused('arithmetic');
  return value;
}
export function checkedAllocationAdd(a: number, b: number): number {
  checkedAllocationCount(a); checkedAllocationCount(b);
  if (a > Number.MAX_SAFE_INTEGER - b) throw new AllocationRefused('arithmetic');
  return a + b;
}
export function checkedAllocationMultiply(a: number, b: number): number {
  checkedAllocationCount(a); checkedAllocationCount(b);
  if (b !== 0 && a > Math.floor(Number.MAX_SAFE_INTEGER / b)) throw new AllocationRefused('arithmetic');
  return a * b;
}
const dimensions = ['bufferBytes', 'utf16Units', 'graphNodes', 'graphEdges'] as const;
function vector(value: AllocationVector): AllocationVector {
  return Object.freeze(Object.fromEntries(dimensions.map(key => [key, checkedAllocationCount(value[key])])) as unknown as AllocationVector);
}
export function addAllocationVectors(a: AllocationVector, b: AllocationVector): AllocationVector {
  return vector(Object.fromEntries(dimensions.map(key => [key, checkedAllocationAdd(a[key], b[key])])) as unknown as AllocationVector);
}
export function multiplyAllocationVector(value: AllocationVector, count: number): AllocationVector {
  return vector(Object.fromEntries(dimensions.map(key => [key, checkedAllocationMultiply(value[key], count)])) as unknown as AllocationVector);
}
const zero: AllocationVector = Object.freeze({ bufferBytes: 0, utf16Units: 0, graphNodes: 0, graphEdges: 0 });
const sameVector = (a: AllocationVector, b: AllocationVector) => dimensions.every(key => a[key] === b[key]);
const sameIdentity = (a: AllocationIdentity, b: AllocationIdentity) => a.owner === b.owner && a.generation === b.generation && a.attempt === b.attempt;
const sameProcess = (a: AllocationProcess, b: AllocationProcess) => a.kind === b.kind && (a.kind === 'main' || b.kind === 'child' && a.pid === b.pid && a.generation === b.generation);

export interface AllocationReference {
  readonly rootSerial: number;
  readonly id: string;
  readonly revision: number;
  readonly holder: string;
  readonly process: AllocationProcess;
  readonly charge: AllocationVector;
  check(): void;
  transfer(holder: string): AllocationReference;
  release(): boolean;
  releaseAfter<T>(work: Promise<T>): Promise<T>;
  run<T>(start: () => Promise<T>): Promise<T>;
}
export interface AllocationOperation {
  readonly serial: number;
  readonly identity: AllocationIdentity;
  readonly closed: boolean;
  owns(reference: AllocationReference): boolean;
  borrow(id: string, holder: string, charge: AllocationVector, process: AllocationProcess): AllocationReference;
  close(): void;
}
type ReferenceRecord = {
  charge: AllocationVector;
  process: AllocationProcess;
  handle: AllocationReference;
  released: boolean;
  work?: Promise<unknown>;
  settlement?: Promise<unknown>;
};
type RootRecord = {
  operation: AllocationOperation;
  references: Map<string, ReferenceRecord>;
  closed: boolean;
  retired: boolean;
};
export class IngestAllocation {
  private readonly limits: AllocationLimits;
  private readonly roots = new Map<number, RootRecord>();
  private used: AllocationVector = zero;
  private serial = 0;

  constructor(limits: AllocationLimits) {
    const captured = {
      capacity: vector(limits.capacity),
      maxRoots: checkedAllocationCount(limits.maxRoots),
      maxReferencesPerRoot: checkedAllocationCount(limits.maxReferencesPerRoot),
      maxTransfersPerReference: checkedAllocationCount(limits.maxTransfersPerReference),
      maxIdentityUnits: checkedAllocationCount(limits.maxIdentityUnits),
    };
    checkedAllocationMultiply(captured.maxRoots, captured.maxReferencesPerRoot);
    this.limits = Object.freeze(captured);
  }
  snapshot(): Readonly<{ roots: number; references: number; used: AllocationVector }> {
    let references = 0;
    for (const root of this.roots.values()) for (const reference of root.references.values()) if (!reference.released) references = checkedAllocationAdd(references, 1);
    return Object.freeze({ roots: this.roots.size, references, used: this.used });
  }
  private label(value: string): string {
    if (typeof value !== 'string' || !value.length || value.length > this.limits.maxIdentityUnits) throw new AllocationRefused('identity');
    return value;
  }
  open(identity: AllocationIdentity): AllocationOperation {
    const captured = Object.freeze({ owner: this.label(identity.owner), generation: this.label(identity.generation), attempt: checkedAllocationCount(identity.attempt) });
    for (const root of this.roots.values()) if (sameIdentity(root.operation.identity, captured)) {
      if (root.closed) throw new AllocationRefused('closed');
      return root.operation;
    }
    if (this.roots.size >= this.limits.maxRoots) throw new AllocationRefused('capacity');
    const serial = checkedAllocationAdd(this.serial, 1);
    const root: RootRecord = { operation: undefined!, references: new Map(), closed: false, retired: false };
    root.operation = Object.freeze({
      serial, identity: captured,
      get closed() { return root.closed; },
      owns: (reference: AllocationReference) => {
        const current = root.references.get(reference.id);
        return !root.closed && !root.retired && !!current && !current.released && current.handle === reference;
      },
      borrow: (id: string, holder: string, charge: AllocationVector, process: AllocationProcess) => this.borrow(root, id, holder, charge, process),
      close: () => { root.closed = true; this.retire(root); },
    });
    this.serial = serial;
    this.roots.set(serial, root);
    return root.operation;
  }
  ownedChildExited(child: Extract<AllocationProcess, { kind: 'child' }>): void {
    this.label(child.generation); checkedAllocationCount(child.pid);
    if (child.kind !== 'child' || child.pid === 0) throw new AllocationRefused('identity');
    for (const root of this.roots.values()) {
      for (const reference of root.references.values()) {
        if (sameProcess(reference.process, child)) { root.closed = true; this.settle(root, reference); }
      }
      this.retire(root);
    }
  }
  private borrow(root: RootRecord, id: string, holder: string, charge: AllocationVector, process: AllocationProcess): AllocationReference {
    if (root.closed || root.retired) throw new AllocationRefused('closed');
    this.label(id); this.label(holder);
    const capturedCharge = vector(charge);
    let capturedProcess: AllocationProcess;
    if (process.kind === 'main') capturedProcess = Object.freeze({ kind: 'main' });
    else if (process.kind === 'child' && checkedAllocationCount(process.pid) > 0) capturedProcess = Object.freeze({ kind: 'child', pid: process.pid, generation: this.label(process.generation) });
    else throw new AllocationRefused('identity');
    const existing = root.references.get(id);
    if (existing) {
      if (!existing.released && existing.handle.revision === 0 && existing.handle.holder === holder && sameVector(existing.charge, capturedCharge) && sameProcess(existing.process, capturedProcess)) return existing.handle;
      throw new AllocationRefused('stale');
    }
    if (root.references.size >= this.limits.maxReferencesPerRoot) throw new AllocationRefused('capacity');
    const total = addAllocationVectors(this.used, capturedCharge);
    if (dimensions.some(key => total[key] > this.limits.capacity[key])) throw new AllocationRefused('capacity');
    const reference: ReferenceRecord = { charge: capturedCharge, process: capturedProcess, handle: undefined!, released: false };
    reference.handle = this.handle(root, reference, id, holder, 0);
    root.references.set(id, reference);
    this.used = total;
    return reference.handle;
  }
  private handle(root: RootRecord, reference: ReferenceRecord, id: string, holder: string, revision: number): AllocationReference {
    const handle: AllocationReference = Object.freeze({
      rootSerial: root.operation.serial, id, revision, holder, process: reference.process, charge: reference.charge,
      check: () => {
        if (root.closed || reference.released) throw new AllocationRefused('closed');
        if (reference.handle !== handle) throw new AllocationRefused('stale');
      },
      transfer: (next: string) => {
        this.label(next);
        if (root.closed || reference.released) throw new AllocationRefused('closed');
        if (reference.handle !== handle) {
          if (reference.handle.revision === revision + 1 && reference.handle.holder === next) return reference.handle;
          throw new AllocationRefused('stale');
        }
        if (reference.work) throw new AllocationRefused('busy');
        if (revision >= this.limits.maxTransfersPerReference) throw new AllocationRefused('capacity');
        reference.handle = this.handle(root, reference, id, next, checkedAllocationAdd(revision, 1));
        return reference.handle;
      },
      release: () => {
        if (reference.handle !== handle || reference.work) return false;
        return this.settle(root, reference);
      },
      run: <T>(start: () => Promise<T>): Promise<T> => {
        handle.check();
        if (typeof start !== 'function') throw new AllocationRefused('identity');
        if (reference.work) throw new AllocationRefused('busy');
        const work = Promise.resolve().then(() => { handle.check(); return start(); });
        return handle.releaseAfter(work);
      },
      releaseAfter: <T>(work: Promise<T>): Promise<T> => {
        if (reference.handle !== handle || reference.released) throw new AllocationRefused('stale');
        if (!(work instanceof Promise)) throw new AllocationRefused('identity');
        if (reference.work) {
          if (reference.work !== work) throw new AllocationRefused('busy');
          return reference.settlement as Promise<T>;
        }
        reference.work = work;
        const settled = () => { this.settle(root, reference); reference.work = undefined; reference.settlement = undefined; };
        reference.settlement = work.then(value => { settled(); return value; }, error => { settled(); throw error; });
        return reference.settlement as Promise<T>;
      },
    });
    return handle;
  }
  private settle(root: RootRecord, reference: ReferenceRecord): boolean {
    if (reference.released) return false;
    reference.released = true;
    this.used = vector(Object.fromEntries(dimensions.map(key => [key, this.used[key] - reference.charge[key]])) as unknown as AllocationVector);
    this.retire(root);
    return true;
  }
  private retire(root: RootRecord): void {
    if (!root.closed || root.retired) return;
    for (const reference of root.references.values()) if (!reference.released) return;
    root.retired = true;
    this.roots.delete(root.operation.serial);
    root.references.clear();
  }
}
