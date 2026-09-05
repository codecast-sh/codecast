import { INGEST_MAX_BYTES, INGEST_PAGE_BYTES, INGEST_PAGE_TOKENS, INGEST_STRING_CHUNK, type IngestToken } from './ingestTypes.js';
export function* ingestTokens(value: unknown, depth = 0): Generator<IngestToken> {
  if (depth > 128) throw new Error('ingest nesting limit');
  if (typeof value === 'string') {
    yield ['s'];
    for (let i = 0; i < value.length; i += INGEST_STRING_CHUNK) yield ['t',value.slice(i,i+INGEST_STRING_CHUNK)];
    yield ['e'];
  } else if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) {
    yield ['v',value];
  } else if (Array.isArray(value)) {
    yield ['a'];
    for (const item of value) yield* ingestTokens(item ?? null,depth+1);
    yield ['z'];
  } else if (value && typeof value === 'object') {
    yield ['o'];
    for (const key in value) {
      if (!Object.hasOwn(value,key)) continue;
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      yield* ingestTokens(key,depth+1);
      yield* ingestTokens(item,depth+1);
    }
    yield ['z'];
  } else throw new Error('invalid ingest value');
}
export async function* ingestTokenPages(value: unknown): AsyncGenerator<IngestToken[]> {
  let tokens: IngestToken[] = [], bytes = 512;
  const budget = new IngestTokenBudget();
  for (const token of ingestTokens(value)) {
    const size = Buffer.byteLength(JSON.stringify(token)) + 1;
    budget.push(token, size);
    if (tokens.length && (tokens.length >= INGEST_PAGE_TOKENS || bytes + size > INGEST_PAGE_BYTES)) {
      yield tokens; tokens = []; bytes = 512;
    }
    tokens.push(token); bytes += size;
  }
  if (tokens.length) yield tokens;
}
export class IngestTokenBudget {
  private bytes = 0;
  private nodes = 0;
  private depth = 0;
  push(token: IngestToken, size = Buffer.byteLength(JSON.stringify(token)) + 1): void {
    this.bytes += size;
    if (this.bytes > INGEST_MAX_BYTES) throw new Error('ingest result resource limit');
    if (['s','v','o','a'].includes(token[0]) && ++this.nodes > 1_000_000) throw new Error('ingest object resource limit');
    if ((token[0] === 'o' || token[0] === 'a') && ++this.depth > 128) throw new Error('ingest nesting limit');
    if (token[0] === 'z') this.depth--;
  }
}
export async function validateIngestBounds(value: unknown, checkpoint: () => void = () => {}): Promise<void> {
  checkpoint();
  for await (const _ of ingestTokenPages(value)) {
    checkpoint();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  checkpoint();
}
type Container = { value: any; key?: string; array: boolean };
export class IngestAssembler {
  private stack: Container[] = [];
  private chunks: string[] | null = null;
  private bytes = 0;
  private nodes = 0;
  private root: unknown;
  private hasRoot = false;
  private add(value: unknown) {
    if (++this.nodes > 1_000_000) throw new Error('ingest object resource limit');
    const parent = this.stack.at(-1);
    if (!parent) {
      if (this.hasRoot) throw new Error('multiple ingest roots');
      this.root = value; this.hasRoot = true;
    } else if (parent.array) parent.value.push(value);
    else if (parent.key === undefined) {
      if (typeof value !== 'string') throw new Error('invalid ingest key');
      parent.key = value;
    } else {
      if (Object.hasOwn(parent.value,parent.key)) throw new Error('duplicate ingest key');
      Object.defineProperty(parent.value,parent.key,{value,writable:true,enumerable:true,configurable:true});
      parent.key = undefined;
    }
  }
  push(tokens: IngestToken[]) {
    for (const token of tokens) {
      this.bytes += Buffer.byteLength(JSON.stringify(token)) + 1;
      if (this.bytes > INGEST_MAX_BYTES) throw new Error('ingest result resource limit');
      const tag = token[0];
      if (this.chunks !== null) {
        if (tag === 't') this.chunks.push(token[1]);
        else if (tag === 'e') { const value = this.chunks.join(''); this.chunks = null; this.add(value); }
        else throw new Error('invalid ingest string');
      } else if (tag === 's') this.chunks = [];
      else if (tag === 'v') this.add(token[1]);
      else if (tag === 'o' || tag === 'a') {
        if (this.stack.length >= 128) throw new Error('ingest nesting limit');
        const value = tag === 'a' ? [] : {};
        this.add(value); this.stack.push({value,array:tag === 'a'});
      } else if (tag === 'z') {
        const parent = this.stack.pop();
        if (!parent || parent.key !== undefined) throw new Error('invalid ingest end');
      } else throw new Error('invalid ingest token');
    }
  }
  finish(): unknown {
    if (!this.hasRoot || this.chunks !== null || this.stack.length) throw new Error('incomplete ingest result');
    return this.root;
  }
}
