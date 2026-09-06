import { expect, test } from 'bun:test';
import { AllocationRefused, IngestAllocation } from './ingestAllocation.js';
import * as publicScanner from './jsonAllocationFacts.js';
import { scanJsonAllocationFacts } from './jsonAllocationFacts.js';

const limits = { maxInputBytes: 4096, maxPageBytes: 64, maxPages: 4096, bytesPerSlice: 7 };
function lease() {
  const accounting = new IngestAllocation({ capacity: { bufferBytes: 64, utf16Units: 0, graphNodes: 0, graphEdges: 0 }, maxRoots: 1, maxReferencesPerRoot: 1, maxTransfersPerReference: 1, maxIdentityUnits: 64 });
  const operation = accounting.open({ owner: 'source/full', generation: 'generation', attempt: 1 });
  const scratch = operation.borrow('scanner', 'scan', { bufferBytes: 64, utf16Units: 0, graphNodes: 0, graphEdges: 0 }, { kind: 'main' });
  return { accounting, operation, scratch };
}
async function scan(bytes: Uint8Array, pageSize: number, checkpoint = () => {}) {
  const { accounting, operation, scratch } = lease();
  function* pages() { for (let i = 0; i < bytes.byteLength; i += pageSize) yield bytes.subarray(i, i + pageSize); }
  try { return await scanJsonAllocationFacts(pages(), limits, scratch, checkpoint); }
  finally { operation.close(); expect(accounting.snapshot()).toEqual({ roots: 0, references: 0, used: { bufferBytes: 0, utf16Units: 0, graphNodes: 0, graphEdges: 0 } }); }
}
function shape(value: unknown): { nodes: number; edges: number; strings: number } {
  const result = { nodes: 1, edges: 0, strings: typeof value === 'string' ? value.length : 0 };
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    const nested = shape(child); result.nodes += nested.nodes; result.edges += 1 + nested.edges;
    result.strings += nested.strings + (Array.isArray(value) ? 0 : key.length);
  }
  return result;
}

test('allocation facts are page-independent for escaped strings, UTF8 emoji, surrogate escapes and duplicate keys', async () => {
  const emoji = String.fromCodePoint(0x1f600);
  const text = String.raw`{"dup":"old","dup":"new","e\u006d":"${emoji}","s":"\uD83D\uDE00","slash":"\\\"","v":[0,true,false,null,{},[]]}`;
  expect(text).toContain(emoji);
  expect(text).toContain('\\uD83D\\uDE00');
  expect(text).not.toContain('\\u{');
  const bytes = Buffer.from(text), native = JSON.parse(text), expected = await scan(bytes, 64);
  expect(native.em).toBe(emoji); expect(native.s).toBe(emoji);
  for (const pageSize of [1, 2, 3, 5, 7, 31]) expect(await scan(bytes, pageSize)).toEqual(expected);
  const actual = shape(native);
  expect(expected.inputBytesExact).toBe(bytes.length);
  expect(expected.graphNodesUpperBound).toBeGreaterThanOrEqual(actual.nodes);
  expect(expected.graphEdgesUpperBound).toBeGreaterThanOrEqual(actual.edges);
  expect(expected.decodedStringUnitsUpperBound).toBeGreaterThanOrEqual(actual.strings);
  expect(expected.quotedTokenStartsExact).toBe(11);
  expect(expected.memberSeparatorsExact).toBe(6);
  expect(expected.quoteClosed).toBe(true); expect(expected.delimitersBalanced).toBe(true);
  expect(JSON.parse(text)).toEqual(native);
  expect(Object.values(expected).every(value => typeof value === 'number' || typeof value === 'boolean')).toBe(true);
});

test('admitted malformed or empty syntax stays with native JSON rather than scanner-generated parse errors', async () => {
  const parse = (text: string) => {
    try { return { value: JSON.parse(text) }; }
    catch (error) { return { name: (error as Error).name, message: (error as Error).message }; }
  };
  for (const bytes of [Buffer.from(''), Buffer.from('\uFEFF{}'), Buffer.from('{"x":"unfinished'), Buffer.from('[true,,0]'), Buffer.from('{]'), Buffer.from([34, 0xff, 34]), Buffer.from('null')]) {
    const text = bytes.toString('utf8'), before = parse(text);
    const facts = await scan(bytes, 3);
    expect(facts.inputBytesExact).toBe(bytes.length); expect(parse(text)).toEqual(before);
  }
  const unfinished = await scan(Buffer.from('{"x":"unfinished'), 2);
  expect(unfinished.quoteClosed).toBe(false); expect(unfinished.delimitersBalanced).toBe(false);
});

test('deep and overwritten source allocations count before native graph reduction', async () => {
  const depth = 200, text = '['.repeat(depth) + '{"x":[1,2],"x":[3,4]}' + ']'.repeat(depth);
  const facts = await scan(Buffer.from(text), 64), actual = shape(JSON.parse(text));
  expect(facts.maxDepthUpperBound).toBe(depth + 2);
  expect(facts.containerStartsExact).toBe(depth + 3);
  expect(facts.graphNodesUpperBound).toBeGreaterThan(actual.nodes);
  expect(facts.graphEdgesUpperBound).toBeGreaterThanOrEqual(actual.edges);
});

test('input page copy is reserved before allocation and stays stable if caller mutates its bytes during yield', async () => {
  const { accounting, operation, scratch } = lease();
  const input = Buffer.from('["hello",1]'), original = Buffer.from(input);
  let yields = 0;
  const facts = await scanJsonAllocationFacts([input], limits, scratch, () => {}, async () => { yields++; input.fill(34); });
  operation.close();
  expect(facts).toEqual(await scan(original, 64)); expect(yields).toBe(2);
  expect(accounting.snapshot().roots).toBe(0);
  const next = lease();
  await expect(scanJsonAllocationFacts([], { ...limits, maxPageBytes: 65 }, next.scratch, () => {})).rejects.toBeInstanceOf(AllocationRefused);
  next.operation.close(); next.scratch.release();
});

test('capacity refusal happens before native parsing and partial facts never escape', async () => {
  const { accounting, operation, scratch } = lease();
  let parsed = false, output = false;
  async function* pages() { yield Buffer.from('[1'); yield Buffer.from(',2]'); }
  await expect(scanJsonAllocationFacts(pages(), { ...limits, maxInputBytes: 3 }, scratch, () => {}).then(() => { output = true; parsed = true; })).rejects.toBeInstanceOf(AllocationRefused);
  expect(parsed).toBe(false); expect(output).toBe(false);
  expect(() => scanJsonAllocationFacts([], limits, scratch, () => {})).toThrow(AllocationRefused);
  operation.close(); expect(accounting.snapshot().roots).toBe(0);
});

test('cancellation fences scanning and retains scratch through an outstanding yield until settlement', async () => {
  const { accounting, operation, scratch } = lease();
  let resume!: () => void;
  const wait = new Promise<void>(resolve => { resume = resolve; });
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const result = scanJsonAllocationFacts([Buffer.from('[1,2,3,4]')], limits, scratch, () => {}, () => { started(); return wait; });
  await began; operation.close();
  expect(scratch.release()).toBe(false);
  expect(accounting.snapshot().used.bufferBytes).toBe(64);
  resume(); await expect(result).rejects.toBeInstanceOf(AllocationRefused);
  expect(accounting.snapshot().roots).toBe(0);
});

test('only the admitted factory is exported and a held scan refuses a second public start', async () => {
  expect(Object.keys(publicScanner)).toEqual(['scanJsonAllocationFacts']);
  const { accounting, operation, scratch } = lease();
  let resume!: () => void, began!: () => void;
  const wait = new Promise<void>(resolve => { resume = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  const first = scanJsonAllocationFacts([Buffer.from('{}')], limits, scratch, () => {}, () => { began(); return wait; });
  await started;
  expect(() => scanJsonAllocationFacts([Buffer.from('[]')], limits, scratch, () => {})).toThrow(AllocationRefused);
  expect(scratch.release()).toBe(false); expect(accounting.snapshot().used.bufferBytes).toBe(64);
  resume(); expect((await first).containerStartsExact).toBe(1);
  operation.close(); expect(accounting.snapshot().roots).toBe(0);
});

test('empty pages yield and exhaust finite page work while a valid empty final input remains inspectable', async () => {
  const { accounting, operation, scratch } = lease();
  let yields = 0, output = false;
  await expect(scanJsonAllocationFacts([new Uint8Array(), new Uint8Array(), new Uint8Array()], { ...limits, maxPages: 2 }, scratch, () => {}, async () => { yields++; }).then(() => { output = true; })).rejects.toBeInstanceOf(AllocationRefused);
  expect(yields).toBe(2); expect(output).toBe(false);
  expect(() => scanJsonAllocationFacts([], limits, scratch, () => {})).toThrow(AllocationRefused);
  operation.close(); expect(accounting.snapshot().roots).toBe(0);
  expect((await scan(new Uint8Array(), 1)).inputBytesExact).toBe(0);
});

test('scan limits are captured before callbacks and cannot be expanded during an await', async () => {
  const { operation, scratch } = lease(), mutable = { ...limits, maxInputBytes: 2 };
  await expect(scanJsonAllocationFacts([Buffer.from('[1]')], mutable, scratch, () => { mutable.maxInputBytes = 4096; mutable.maxPageBytes = 4096; })).rejects.toBeInstanceOf(AllocationRefused);
  operation.close();
});

test('duplicate scans refuse before constructing another scanner or starting its iterator', async () => {
  const { accounting, operation, scratch } = lease();
  let resume!: () => void, started!: () => void, starts = 0, checkpoints = 0;
  const wait = new Promise<void>(resolve => { resume = resolve; });
  const began = new Promise<void>(resolve => { started = resolve; });
  async function* pages() { starts++; started(); await wait; yield Buffer.from('{}'); }
  const result = scanJsonAllocationFacts(pages(), limits, scratch, () => { checkpoints++; });
  expect(() => scanJsonAllocationFacts(pages(), limits, scratch, () => { checkpoints++; })).toThrow(AllocationRefused);
  expect(starts).toBe(0); expect(checkpoints).toBe(0);
  await began;
  expect(starts).toBe(1); expect(checkpoints).toBe(1);
  expect(accounting.snapshot().used.bufferBytes).toBe(64);
  resume(); expect((await result).containerStartsExact).toBe(1);
  operation.close(); expect(accounting.snapshot().roots).toBe(0);
});

test('admitted construction rechecks closed authority and refuses transferring busy credit', async () => {
  for (const change of ['close', 'transfer'] as const) {
    const { accounting, operation, scratch } = lease();
    await expect(scanJsonAllocationFacts([], limits, scratch, () => {
      if (change === 'close') operation.close();
      else scratch.transfer('other');
    })).rejects.toBeInstanceOf(AllocationRefused);
    operation.close(); expect(accounting.snapshot().roots).toBe(0);
  }
  const { accounting, operation, scratch } = lease();
  await scanJsonAllocationFacts([], limits, scratch, () => {
    expect(scratch.release()).toBe(false); expect(accounting.snapshot().used.bufferBytes).toBe(64);
  });
  operation.close(); expect(accounting.snapshot().roots).toBe(0);
});

test('final facts cannot escape a closing checkpoint and active credit cannot transfer or release', async () => {
  for (const change of ['close', 'transfer', 'release'] as const) {
    const { accounting, operation, scratch } = lease();
    let armed = false, output = false;
    async function* pages() { yield Buffer.from('{}'); armed = true; }
    const result = scanJsonAllocationFacts(pages(), limits, scratch, () => {
      if (!armed) return;
      if (change === 'close') operation.close();
      else if (change === 'release') { expect(scratch.release()).toBe(false); expect(accounting.snapshot().used.bufferBytes).toBe(64); }
      else scratch.transfer('other');
    }).then(facts => { output = true; return facts; });
    if (change === 'release') expect((await result).containerStartsExact).toBe(1);
    else await expect(result).rejects.toBeInstanceOf(AllocationRefused);
    expect(output).toBe(change === 'release');
    operation.close(); expect(accounting.snapshot().roots).toBe(0);
  }
});
