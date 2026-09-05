import { boundedText, count, identity, ownFields, record, validByteDescriptor, validBytePage, type ByteDescriptor, type BytePage } from './payloadBytes.js';
import { validPayloadTokens, type PayloadToken } from './payloadValues.js';
import type { ImageCacheOperation } from '../imageCacheCodec.js';

export type PayloadCodecJob = { kind: 'image'; encoding: 'base64' | 'binary'; output: 'facts' | 'bytes' | 'base64' } | { kind: 'cache'; operation: ImageCacheOperation };
type Address = { cursor: string; generation: string; sequence: number };
export type PayloadCodecPayload = { action: 'open'; generation: string; budgetMs: number; job: PayloadCodecJob } | Address & ({ action: 'push'; page: BytePage } | { action: 'seal'; descriptor: ByteDescriptor } | { action: 'next' | 'close' });
export type PayloadCodecPage = Address & ({ stage: 'ready' } | { stage: 'descriptor'; descriptor: ByteDescriptor } | { stage: 'bytes'; page: BytePage; done: boolean } | { stage: 'values'; tokens: PayloadToken[]; done: boolean });
function validJob(v: unknown): v is PayloadCodecJob {
  if (!record(v)) return false;
  if (v.kind === 'image') return ownFields(v, ['kind', 'encoding', 'output']) && ['base64', 'binary'].includes(v.encoding) && ['facts', 'bytes', 'base64'].includes(v.output);
  if (v.kind !== 'cache' || !ownFields(v, ['kind', 'operation']) || !record(v.operation)) return false;
  const o = v.operation;
  if (o.action === 'hash' || o.action === 'path') return ownFields(o, ['action', 'key']) && boundedText(o.key, 16384);
  return o.action === 'store' && ownFields(o, ['action', 'hash', 'absPath', 'storageId', 'url', 'at']) && ['hash', 'storageId', 'url'].every(k => boundedText(o[k], 16384)) && (o.absPath === undefined || boundedText(o.absPath, 16384)) && Number.isFinite(o.at) && Buffer.byteLength(JSON.stringify(o)) <= 256 * 1024 - 2048;
}
export function validPayloadCodecPayload(v: unknown): v is PayloadCodecPayload {
  if (!record(v) || !identity(v.generation)) return false;
  if (v.action === 'open') return ownFields(v, ['action', 'generation', 'budgetMs', 'job']) && Number.isFinite(v.budgetMs) && v.budgetMs > 0 && v.budgetMs <= 60_000 && validJob(v.job);
  if (!identity(v.cursor) || !count(v.sequence)) return false;
  const base = ['action', 'cursor', 'generation', 'sequence'];
  if (v.action === 'push') return ownFields(v, [...base, 'page']) && validBytePage(v.page);
  if (v.action === 'seal') return ownFields(v, [...base, 'descriptor']) && validByteDescriptor(v.descriptor);
  return ['next', 'close'].includes(v.action) && ownFields(v, base);
}
export function validPayloadCodecPage(v: unknown): v is PayloadCodecPage {
  if (!record(v) || !identity(v.cursor) || !identity(v.generation) || !count(v.sequence)) return false;
  const base = ['cursor', 'generation', 'sequence', 'stage'];
  if (v.stage === 'ready') return ownFields(v, base);
  if (v.stage === 'descriptor') return ownFields(v, [...base, 'descriptor']) && validByteDescriptor(v.descriptor);
  if (v.stage === 'bytes') return ownFields(v, [...base, 'page', 'done']) && validBytePage(v.page) && typeof v.done === 'boolean';
  return v.stage === 'values' && ownFields(v, [...base, 'tokens', 'done']) && validPayloadTokens(v.tokens) && typeof v.done === 'boolean';
}
