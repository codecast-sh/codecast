import { validIngestPage, type IngestToken } from './ingestTypes.js';
import { boundedText, count, identity, ownFields, record, validByteDescriptor, validBytePage, type ByteDescriptor, type BytePage } from './payloadBytes.js';
import { validPayloadTokens, type PayloadToken } from './payloadValues.js';

type Address = { cursor: string; generation: string; sequence: number };
export type MessagesSdkPayload = { action: 'open'; generation: string; conversationId: string; messageCount: number; budgetMs: number } | Address & (
  { action: 'push'; tokens: IngestToken[] } |
  { action: 'seal' | 'requestNext' | 'waitOutcome' | 'outcomeNext' | 'reset' | 'close' } |
  { action: 'begin'; apiToken: string } |
  { action: 'responseStart'; status: number; body: boolean } |
  { action: 'responsePush'; page: BytePage } |
  { action: 'responseEnd'; descriptor: ByteDescriptor } |
  { action: 'networkError'; reference: string }
);
export type SdkCapture = ByteDescriptor & { headers: { 'Content-Type': string; 'Convex-Client': string } };
export type MessagesSdkPage = Address & (
  { stage: 'ready' | 'outcome' } |
  { stage: 'capture'; capture: SdkCapture } |
  { stage: 'bytes'; page: BytePage; done: boolean } |
  { stage: 'values'; tokens: PayloadToken[]; done: boolean }
);
export function validMessagesSdkPayload(v: unknown): v is MessagesSdkPayload {
  if (!record(v) || !identity(v.generation)) return false;
  if (v.action === 'open') return ownFields(v, ['action', 'generation', 'conversationId', 'messageCount', 'budgetMs']) && boundedText(v.conversationId, 8192) && v.conversationId.length > 0 && count(v.messageCount) && v.messageCount <= 1_000_000 && Number.isFinite(v.budgetMs) && v.budgetMs > 0 && v.budgetMs <= 60_000;
  if (!identity(v.cursor) || !count(v.sequence)) return false;
  const base = ['action', 'cursor', 'generation', 'sequence'];
  if (['seal', 'requestNext', 'waitOutcome', 'outcomeNext', 'reset', 'close'].includes(v.action)) return ownFields(v, base);
  if (v.action === 'push') return ownFields(v, [...base, 'tokens']) && validPayloadTokens(v.tokens) && validIngestPage({ cursor: v.cursor, generation: v.generation, sequence: v.sequence, tokens: v.tokens, done: true });
  if (v.action === 'begin') return ownFields(v, [...base, 'apiToken']) && boundedText(v.apiToken, 16384);
  if (v.action === 'responseStart') return ownFields(v, [...base, 'status', 'body']) && Number.isInteger(v.status) && v.status >= 200 && v.status <= 599 && typeof v.body === 'boolean' && (!v.body || ![204, 205, 304].includes(v.status));
  if (v.action === 'responsePush') return ownFields(v, [...base, 'page']) && validBytePage(v.page);
  if (v.action === 'responseEnd') return ownFields(v, [...base, 'descriptor']) && validByteDescriptor(v.descriptor);
  return v.action === 'networkError' && ownFields(v, [...base, 'reference']) && identity(v.reference);
}
export function validMessagesSdkPage(v: unknown): v is MessagesSdkPage {
  if (!record(v) || !identity(v.cursor) || !identity(v.generation) || !count(v.sequence)) return false;
  const base = ['cursor', 'generation', 'sequence', 'stage'];
  if (v.stage === 'ready' || v.stage === 'outcome') return ownFields(v, base);
  if (v.stage === 'capture') {
    const c = v.capture;
    return ownFields(v, [...base, 'capture']) && record(c) && ownFields(c, ['length', 'sha256', 'headers']) && validByteDescriptor({ length: c.length, sha256: c.sha256 }) && record(c.headers) && ownFields(c.headers, ['Content-Type', 'Convex-Client']) && c.headers['Content-Type'] === 'application/json' && boundedText(c.headers['Convex-Client'], 128) && /^npm-[A-Za-z0-9.+-]+$/.test(c.headers['Convex-Client']);
  }
  if (v.stage === 'bytes') return ownFields(v, [...base, 'page', 'done']) && validBytePage(v.page) && typeof v.done === 'boolean';
  return v.stage === 'values' && ownFields(v, [...base, 'tokens', 'done']) && validPayloadTokens(v.tokens) && typeof v.done === 'boolean';
}
