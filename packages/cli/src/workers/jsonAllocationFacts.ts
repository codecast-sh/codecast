import { AllocationRefused, checkedAllocationAdd, checkedAllocationCount, type AllocationReference } from './ingestAllocation.js';

export type JsonAllocationFacts = Readonly<{
  inputBytesExact: number;
  quotedTokenStartsExact: number;
  quotedSourceBytesExact: number;
  containerStartsExact: number;
  scalarTokenStartsExact: number;
  memberSeparatorsExact: number;
  elementSeparatorsExact: number;
  decodedStringUnitsUpperBound: number;
  graphNodesUpperBound: number;
  graphEdgesUpperBound: number;
  maxDepthUpperBound: number;
  quoteClosed: boolean;
  delimitersBalanced: boolean;
}>;
export type JsonAllocationScanLimits = Readonly<{
  maxInputBytes: number;
  maxPageBytes: number;
  maxPages: number;
  bytesPerSlice: number;
}>;
class JsonAllocationScanner {
  private readonly limits: JsonAllocationScanLimits;
  private page: Uint8Array | undefined;
  private state: 'ready' | 'busy' | 'sealed' | 'failed' = 'ready';
  private inputBytes = 0;
  private pages = 0;
  private quotedTokens = 0;
  private quotedBytes = 0;
  private containers = 0;
  private scalars = 0;
  private members = 0;
  private elements = 0;
  private depth = 0;
  private maxDepth = 0;
  private unmatchedClose = false;
  private quoted = false;
  private escaped = false;
  private scalar = false;

  constructor(limits: JsonAllocationScanLimits, private readonly scratch: AllocationReference, private readonly checkpoint: () => void, private readonly yieldSlice: () => Promise<void> = () => new Promise(resolve => setImmediate(resolve))) {
    const captured = {
      maxInputBytes: checkedAllocationCount(limits.maxInputBytes),
      maxPageBytes: checkedAllocationCount(limits.maxPageBytes),
      maxPages: checkedAllocationCount(limits.maxPages),
      bytesPerSlice: checkedAllocationCount(limits.bytesPerSlice),
    };
    if (!captured.maxPageBytes || captured.maxPageBytes > 65_536 || !captured.bytesPerSlice || captured.bytesPerSlice > captured.maxPageBytes) throw new AllocationRefused('capacity');
    scratch.check(); checkpoint(); scratch.check();
    if (scratch.charge.bufferBytes < captured.maxPageBytes) throw new AllocationRefused('capacity');
    this.limits = Object.freeze(captured);
    this.page = new Uint8Array(captured.maxPageBytes);
  }
  async push(bytes: Uint8Array): Promise<void> {
    if (this.state !== 'ready') throw new AllocationRefused(this.state === 'busy' ? 'busy' : 'closed');
    this.state = 'busy';
    try {
      this.scratch.check(); this.checkpoint(); this.scratch.check();
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > this.limits.maxPageBytes) throw new AllocationRefused('capacity');
      const length = bytes.byteLength;
      const nextPages = checkedAllocationAdd(this.pages, 1);
      const nextSize = checkedAllocationAdd(this.inputBytes, length);
      if (nextPages > this.limits.maxPages || nextSize > this.limits.maxInputBytes) throw new AllocationRefused('capacity');
      const page = this.page!;
      page.set(bytes);
      for (let start = 0; start < length; start += this.limits.bytesPerSlice) {
        this.scratch.check(); this.checkpoint(); this.scratch.check();
        const end = Math.min(length, checkedAllocationAdd(start, this.limits.bytesPerSlice));
        for (let i = start; i < end; i++) this.byte(page[i]);
        await this.yieldSlice();
      }
      if (length === 0) await this.yieldSlice();
      this.scratch.check(); this.checkpoint(); this.scratch.check();
      this.inputBytes = nextSize;
      this.pages = nextPages;
      this.state = 'ready';
    } finally {
      if (this.state === 'busy') this.state = 'failed';
    }
  }
  finish(): JsonAllocationFacts {
    if (this.state !== 'ready') throw new AllocationRefused(this.state === 'busy' ? 'busy' : 'closed');
    this.scratch.check(); this.checkpoint(); this.scratch.check();
    const nodes = checkedAllocationAdd(checkedAllocationAdd(this.quotedTokens, this.containers), this.scalars);
    const edges = checkedAllocationAdd(checkedAllocationAdd(this.members, this.elements), this.containers);
    const facts = Object.freeze({
      inputBytesExact: this.inputBytes,
      quotedTokenStartsExact: this.quotedTokens,
      quotedSourceBytesExact: this.quotedBytes,
      containerStartsExact: this.containers,
      scalarTokenStartsExact: this.scalars,
      memberSeparatorsExact: this.members,
      elementSeparatorsExact: this.elements,
      decodedStringUnitsUpperBound: this.quotedBytes,
      graphNodesUpperBound: nodes,
      graphEdgesUpperBound: edges,
      maxDepthUpperBound: this.maxDepth,
      quoteClosed: !this.quoted,
      delimitersBalanced: !this.unmatchedClose && this.depth === 0,
    });
    this.state = 'sealed';
    return facts;
  }
  dispose(): void {
    if (this.state === 'busy') throw new AllocationRefused('busy');
    this.state = 'sealed';
    this.page = undefined;
  }
  private byte(value: number): void {
    if (this.quoted) {
      if (!this.escaped && value === 34) { this.quoted = false; return; }
      this.quotedBytes = checkedAllocationAdd(this.quotedBytes, 1);
      if (this.escaped) this.escaped = false;
      else if (value === 92) this.escaped = true;
      return;
    }
    if (value === 34) {
      this.scalar = false; this.quoted = true;
      this.quotedTokens = checkedAllocationAdd(this.quotedTokens, 1);
    } else if (value === 123 || value === 91) {
      this.scalar = false;
      this.containers = checkedAllocationAdd(this.containers, 1);
      this.depth = checkedAllocationAdd(this.depth, 1);
      this.maxDepth = Math.max(this.maxDepth, this.depth);
    } else if (value === 125 || value === 93) {
      this.scalar = false;
      if (this.depth === 0) this.unmatchedClose = true;
      else this.depth--;
    } else if (value === 58 || value === 44) {
      this.scalar = false;
      if (value === 58) this.members = checkedAllocationAdd(this.members, 1);
      else this.elements = checkedAllocationAdd(this.elements, 1);
    } else if (value === 32 || value === 9 || value === 10 || value === 13) this.scalar = false;
    else if (!this.scalar) { this.scalar = true; this.scalars = checkedAllocationAdd(this.scalars, 1); }
  }
}

export function scanJsonAllocationFacts(pages: Iterable<Uint8Array> | AsyncIterable<Uint8Array>, limits: JsonAllocationScanLimits, scratch: AllocationReference, checkpoint: () => void, yieldSlice?: () => Promise<void>): Promise<JsonAllocationFacts> {
  scratch.check();
  return scratch.run(async () => {
    let scanner: JsonAllocationScanner | undefined;
    try {
      scanner = new JsonAllocationScanner(limits, scratch, checkpoint, yieldSlice);
      for await (const page of pages) await scanner.push(page);
      return scanner.finish();
    } finally {
      scanner?.dispose();
    }
  });
}
