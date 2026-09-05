import { INGEST_PAGE_BYTES, INGEST_PAGE_TOKENS, INGEST_STRING_CHUNK, type IngestToken } from './ingestTypes.js';
import type { PreparationOrigin } from '../messagePreparation.js';
export const PREPARATION_COMPUTE_MS = 60_000;
export const PREPARATION_LIFETIME_MS = 30 * 60_000;
export const PREPARATION_MAX_CURSORS = 1;
type Identity = { cursor: string; generation: string; sequence: number };
export type PreparationPayload =
  | { action: 'open'; generation: string; origin: PreparationOrigin }
  | Identity & { action: 'push'; tokens: IngestToken[] }
  | Identity & { action: 'seal' | 'finish' | 'next' | 'close' }
  | Identity & { action: 'paths' | 'images'; index: number }
  | Identity & { action: 'replace'; index: number; urls: Array<[number, string]> };
export type PreparationPage = Identity & { tokens: IngestToken[]; done: boolean; rss: number; computeRemainingMs: number };
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, any>, expected: string[]) => Object.keys(v).every(k => expected.includes(k));
const id = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(v);
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const tokens = (v: unknown) => Array.isArray(v) && v.length <= INGEST_PAGE_TOKENS && v.every(t => Array.isArray(t) && (
  t.length === 1 && ['o','a','s','e','z'].includes(t[0]) || t.length === 2 && (
    t[0] === 't' && typeof t[1] === 'string' && t[1].length <= INGEST_STRING_CHUNK ||
    t[0] === 'v' && (t[1] === null || typeof t[1] === 'boolean' || typeof t[1] === 'number' && Number.isFinite(t[1]))
  )
));
export function validPreparationPayload(v: unknown): v is PreparationPayload {
  if (!object(v) || !id(v.generation)) return false;
  if (v.action === 'open') return keys(v, ['action','generation','origin']) && ['transcript','service'].includes(v.origin);
  if (!id(v.cursor) || !count(v.sequence)) return false;
  const base = ['action','cursor','generation','sequence'];
  if (v.action === 'push') return keys(v, [...base,'tokens']) && tokens(v.tokens) && Buffer.byteLength(JSON.stringify(v)) <= INGEST_PAGE_BYTES;
  if (['seal','finish','next','close'].includes(v.action)) return keys(v, base);
  if (['paths','images'].includes(v.action)) return keys(v, [...base,'index']) && count(v.index);
  return v.action === 'replace' && keys(v, [...base,'index','urls']) && count(v.index) && Array.isArray(v.urls) && v.urls.length <= 8 && v.urls.every((u: unknown) => Array.isArray(u) && u.length === 2 && count(u[0]) && u[0] < 8 && typeof u[1] === 'string' && u[1].length <= 16_384) && Buffer.byteLength(JSON.stringify(v)) <= INGEST_PAGE_BYTES;
}
export function validPreparationPage(v: unknown): v is PreparationPage {
  return object(v) && keys(v,['cursor','generation','sequence','tokens','done','rss','computeRemainingMs']) && id(v.cursor) && id(v.generation) && count(v.sequence) && tokens(v.tokens) && typeof v.done === 'boolean' && count(v.rss) && Number.isFinite(v.computeRemainingMs) && v.computeRemainingMs >= 0 && v.computeRemainingMs <= PREPARATION_COMPUTE_MS && Buffer.byteLength(JSON.stringify(v)) <= INGEST_PAGE_BYTES;
}
