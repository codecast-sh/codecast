import { PAYLOAD_MAX_BYTES, PAYLOAD_PAGE_BYTES, boundedText, count, validBytePage } from './payloadBytes.js';

export type PayloadToken = ['o' | 'a' | 's' | 'e' | 'z' | 'u'] | ['t', string] | ['v', number | boolean | null] | ['big', string] | ['num', 'nan' | 'inf' | '-inf' | '-0'] | ['bytes', number] | ['b', string];
export function validPayloadTokens(value: unknown): value is PayloadToken[] {
  let bytes = 2;
  return Array.isArray(value) && value.length <= 128 && value.every(t => Array.isArray(t) && (
    t.length === 1 && ['o', 'a', 's', 'e', 'z', 'u'].includes(t[0]) || t.length === 2 && (
      t[0] === 't' && boundedText(t[1], 8192) || t[0] === 'v' && (t[1] === null || typeof t[1] === 'boolean' || typeof t[1] === 'number' && Number.isFinite(t[1])) ||
      t[0] === 'big' && boundedText(t[1], 20) && /^-?(?:0|[1-9][0-9]*)$/.test(t[1]) ||
      t[0] === 'num' && ['nan', 'inf', '-inf', '-0'].includes(t[1]) ||
      t[0] === 'bytes' && count(t[1]) && t[1] <= PAYLOAD_MAX_BYTES ||
      t[0] === 'b' && validBytePage({ offset: 0, data: t[1] })
    )
  ) && (bytes += Buffer.byteLength(JSON.stringify(t)) + 1) <= 256 * 1024 - 1024);
}

function* tokens(value: unknown, depth = 0): Generator<PayloadToken> {
  if (depth > 128) throw new Error('payload nesting limit');
  if (typeof value === 'string') {
    yield ['s'];
    for (let i = 0; i < value.length; i += 8192) yield ['t', value.slice(i, i + 8192)];
    yield ['e'];
  } else if (value === undefined) yield ['u'];
  else if (typeof value === 'bigint') yield ['big', value.toString()];
  else if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) yield ['num', Number.isNaN(value) ? 'nan' : value === Infinity ? 'inf' : value === -Infinity ? '-inf' : '-0'];
  else if (value === null || typeof value === 'boolean' || typeof value === 'number') yield ['v', value];
  else if (value instanceof ArrayBuffer) {
    yield ['bytes', value.byteLength];
    const bytes = Buffer.from(value);
    for (let offset = 0; offset < bytes.length; offset += PAYLOAD_PAGE_BYTES) yield ['b', bytes.subarray(offset, offset + PAYLOAD_PAGE_BYTES).toString('base64')];
    yield ['e'];
  } else if (Array.isArray(value)) {
    yield ['a'];
    for (const item of value) yield* tokens(item, depth + 1);
    yield ['z'];
  } else if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    yield ['o'];
    for (const key in value) if (Object.hasOwn(value, key)) { yield* tokens(key, depth + 1); yield* tokens((value as Record<string, unknown>)[key], depth + 1); }
    yield ['z'];
  } else throw new Error('unsupported payload value');
}

export async function* payloadValuePages(value: unknown): AsyncGenerator<PayloadToken[]> {
  let page: PayloadToken[] = [], bytes = 0, total = 0, nodes = 0;
  for (const token of tokens(value)) {
    const size = Buffer.byteLength(JSON.stringify(token)) + 1;
    total += size;
    if (total > PAYLOAD_MAX_BYTES || ++nodes > 2_000_000) throw new Error('payload value limit');
    if (page.length && (page.length >= 128 || bytes + size > 256 * 1024 - 1024)) { yield page; page = []; bytes = 0; }
    page.push(token); bytes += size;
  }
  if (page.length) yield page;
}

export class PayloadValueAssembler {
  private stack: Array<{ value: any; key?: string; array: boolean }> = [];
  private text: string | undefined;
  private binary?: { value: Uint8Array; offset: number };
  private root: unknown;
  private started = false;
  private bytes = 0;
  private nodes = 0;
  private binaryBytes = 0;
  private add(value: unknown) {
    const parent = this.stack.at(-1);
    if (!parent) {
      if (this.started) throw new Error('multiple payload roots');
      this.root = value; this.started = true;
    } else if (parent.array) parent.value.push(value);
    else if (parent.key === undefined) {
      if (typeof value !== 'string') throw new Error('invalid payload key');
      parent.key = value;
    } else {
      if (Object.hasOwn(parent.value, parent.key)) throw new Error('duplicate payload key');
      Object.defineProperty(parent.value, parent.key, { value, writable: true, enumerable: true, configurable: true }); parent.key = undefined;
    }
  }
  push(page: PayloadToken[]): void {
    if (!validPayloadTokens(page)) throw new Error('invalid payload tokens');
    for (const token of page) {
      this.bytes += Buffer.byteLength(JSON.stringify(token)) + 1;
      if (this.bytes > PAYLOAD_MAX_BYTES || ++this.nodes > 2_000_000) throw new Error('payload value limit');
      const tag = token[0];
      if (this.text !== undefined) {
        if (tag === 't') this.text += token[1];
        else if (tag === 'e') { this.add(this.text); this.text = undefined; }
        else throw new Error('invalid payload string');
      } else if (this.binary) {
        if (tag === 'b') {
          const bytes = Buffer.from(token[1], 'base64');
          if (!bytes.length || bytes.length > PAYLOAD_PAGE_BYTES || bytes.toString('base64') !== token[1] || this.binary.offset + bytes.length > this.binary.value.length) throw new Error('invalid payload bytes');
          this.binary.value.set(bytes, this.binary.offset); this.binary.offset += bytes.length;
        } else if (tag === 'e' && this.binary.offset === this.binary.value.length) { this.add(this.binary.value.buffer); this.binary = undefined; }
        else throw new Error('incomplete payload bytes');
      } else if (tag === 's') this.text = '';
      else if (tag === 'v') this.add(token[1]);
      else if (tag === 'u') this.add(undefined);
      else if (tag === 'big') this.add(BigInt(token[1]));
      else if (tag === 'num') this.add({ nan: NaN, inf: Infinity, '-inf': -Infinity, '-0': -0 }[token[1]]);
      else if (tag === 'bytes') {
        this.binaryBytes += token[1];
        if (this.binaryBytes > PAYLOAD_MAX_BYTES) throw new Error('payload binary allocation limit');
        this.binary = { value: new Uint8Array(token[1]), offset: 0 };
      }
      else if (tag === 'o' || tag === 'a') {
        if (this.stack.length >= 128) throw new Error('payload nesting limit');
        const value = tag === 'a' ? [] : {};
        this.add(value); this.stack.push({ value, array: tag === 'a' });
      } else if (tag === 'z') {
        const parent = this.stack.pop();
        if (!parent || parent.key !== undefined) throw new Error('invalid payload container');
      } else throw new Error('invalid payload token');
    }
  }
  finish(): unknown {
    if (!this.started || this.stack.length || this.text !== undefined || this.binary) throw new Error('incomplete payload value');
    return this.root;
  }
}
