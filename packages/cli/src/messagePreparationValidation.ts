import type { PreparationMessage, PreparationOrigin, PreparedWireMessage } from './messagePreparation.js';

function requireValue(valid: unknown): asserts valid {
  if (!valid) throw new Error('invalid preparation schema');
}

function object(value: unknown): asserts value is Record<string, any> {
  requireValue(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}

function fields(value: unknown, allowed: readonly string[]): asserts value is Record<string, any> {
  object(value);
  for (const key in value) requireValue(Object.hasOwn(value, key) && allowed.includes(key));
}

function strings(value: Record<string, any>, keys: readonly string[]): void {
  for (const key of keys) requireValue(value[key] === undefined || typeof value[key] === 'string');
}

function image(value: unknown): void {
  fields(value, ['mediaType', 'data', 'localPath', 'storageId', 'toolUseId']);
  requireValue(typeof value.mediaType === 'string');
  strings(value, ['data', 'localPath', 'storageId', 'toolUseId']);
}

// A file the agent sent the human. Unlike an image it never carries a payload:
// it is a path on the way in and a storage id on the way out, and a row with
// neither carries the reason instead.
export function validatePreparationFile(value: unknown): void {
  fields(value, ['localPath', 'name', 'mediaType', 'size', 'storageId', 'toolUseId', 'caption', 'display', 'error']);
  requireValue(typeof value.name === 'string');
  strings(value, ['localPath', 'mediaType', 'storageId', 'toolUseId', 'caption', 'display', 'error']);
  requireValue(value.size === undefined || Number.isFinite(value.size) && value.size >= 0);
}

function* jsonBytes(value: unknown, depth = 0): Generator<number> {
  requireValue(depth <= 128);
  if (typeof value === 'string') {
    yield 2;
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + 8192, value.length);
      const previous = value.charCodeAt(end - 1), next = value.charCodeAt(end);
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
      yield Buffer.byteLength(JSON.stringify(value.slice(start, end))) - 2;
      start = end;
    }
  } else if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) {
    yield JSON.stringify(value).length;
  } else if (Array.isArray(value)) {
    yield 2;
    let first = true;
    for (const item of value) {
      if (!first) yield 1;
      first = false;
      yield* jsonBytes(item ?? null, depth + 1);
    }
  } else {
    object(value);
    yield 2;
    let first = true;
    for (const key in value) {
      requireValue(Object.hasOwn(value, key));
      if (value[key] === undefined) continue;
      if (!first) yield 1;
      first = false;
      yield* jsonBytes(key, depth + 1);
      yield 1;
      yield* jsonBytes(value[key], depth + 1);
    }
  }
}

async function walk(values: Generator<number>, checkpoint: () => void): Promise<number> {
  checkpoint();
  let steps = 0, bytes = 0;
  for (const size of values) {
    bytes += size;
    if (++steps % 128 === 0) {
      await new Promise<void>(resolve => setImmediate(resolve));
      checkpoint();
    }
  }
  checkpoint();
  return bytes;
}

function* input(value: unknown, origin: PreparationOrigin): Generator<number> {
  requireValue(Array.isArray(value));
  for (const msg of value) {
    fields(msg, ['uuid', 'messageUuid', 'role', 'content', 'timestamp', 'thinking', 'toolCalls', 'toolResults', 'images', 'files', 'subtype', 'model', 'stopReason']);
    requireValue(typeof msg.role === 'string' && (origin === 'transcript' || ['human', 'assistant', 'system'].includes(msg.role)) && typeof msg.content === 'string' && Number.isFinite(msg.timestamp));
    strings(msg, ['uuid', 'messageUuid', 'thinking', 'subtype', 'model', 'stopReason']);
    for (const key of ['toolCalls', 'toolResults', 'images', 'files']) requireValue(msg[key] === undefined || Array.isArray(msg[key]));
    for (const call of msg.toolCalls ?? []) {
      fields(call, ['id', 'name', 'input']);
      requireValue(typeof call.id === 'string' && typeof call.name === 'string');
      object(call.input);
      yield* jsonBytes(call.input);
    }
    for (const result of msg.toolResults ?? []) {
      fields(result, ['toolUseId', 'content', 'isError']);
      requireValue(typeof result.toolUseId === 'string' && typeof result.content === 'string' && (result.isError === undefined || typeof result.isError === 'boolean'));
      yield 0;
    }
    for (const img of msg.images ?? []) { image(img); yield 0; }
    for (const file of msg.files ?? []) { validatePreparationFile(file); yield 0; }
    yield 0;
  }
}

export async function validatePreparationInput(value: unknown, origin: PreparationOrigin, checkpoint: () => void = () => {}): Promise<PreparationMessage[]> {
  await walk(input(value, origin), checkpoint);
  return value as PreparationMessage[];
}

export function validatePreparationImage(value: unknown): void {
  image(value);
}

function* wire(value: unknown): Generator<number> {
  fields(value, ['message_uuid', 'role', 'content', 'timestamp', 'thinking', 'tool_calls', 'tool_results', 'images', 'files', 'subtype', 'model']);
  requireValue(['user', 'assistant', 'system'].includes(value.role) && typeof value.content === 'string' && Number.isFinite(value.timestamp));
  strings(value, ['message_uuid', 'thinking', 'subtype', 'model']);
  for (const key of ['tool_calls', 'tool_results', 'images', 'files']) requireValue(value[key] === undefined || Array.isArray(value[key]));
  for (const call of value.tool_calls ?? []) {
    fields(call, ['id', 'name', 'input']);
    requireValue(typeof call.id === 'string' && typeof call.name === 'string' && typeof call.input === 'string');
    yield 0;
  }
  for (const result of value.tool_results ?? []) {
    fields(result, ['tool_use_id', 'content', 'is_error']);
    requireValue(typeof result.tool_use_id === 'string' && typeof result.content === 'string' && (result.is_error === undefined || typeof result.is_error === 'boolean'));
    yield 0;
  }
  requireValue(value.images === undefined || value.images.length <= 10);
  for (const img of value.images ?? []) {
    fields(img, ['media_type', 'storage_id', 'data', 'tool_use_id']);
    requireValue(typeof img.media_type === 'string');
    strings(img, ['storage_id', 'data', 'tool_use_id']);
    requireValue(img.storage_id ? img.data === undefined : img.storage_id === undefined && typeof img.data === 'string' && img.data.length > 0);
    yield 0;
  }
  requireValue(value.files === undefined || value.files.length <= 10);
  for (const file of value.files ?? []) {
    fields(file, ['name', 'media_type', 'size', 'storage_id', 'tool_use_id', 'caption', 'display', 'error']);
    requireValue(typeof file.name === 'string' && typeof file.media_type === 'string');
    strings(file, ['storage_id', 'tool_use_id', 'caption', 'display', 'error']);
    requireValue(file.size === undefined || Number.isFinite(file.size));
    // Either the bytes made it to storage, or the row says why they did not.
    requireValue(typeof file.storage_id === 'string' || typeof file.error === 'string');
    yield 0;
  }
}

export async function validatePreparedOutput(value: unknown, messageCount: number, checkpoint: () => void = () => {}): Promise<{ messages: PreparedWireMessage[]; bytes: number[] }> {
  fields(value, ['messages', 'bytes']);
  requireValue(Array.isArray(value.messages) && Array.isArray(value.bytes) && value.messages.length === messageCount && value.bytes.length === messageCount);
  for (let i = 0; i < value.messages.length; i++) {
    const msg = value.messages[i], bytes = value.bytes[i];
    requireValue(Number.isSafeInteger(bytes) && bytes >= 0);
    await walk(wire(msg), checkpoint);
    requireValue(await walk(jsonBytes(msg), checkpoint) === bytes);
    if (i % 128 === 127) { await new Promise<void>(resolve => setImmediate(resolve)); checkpoint(); }
  }
  checkpoint();
  return value as { messages: PreparedWireMessage[]; bytes: number[] };
}
