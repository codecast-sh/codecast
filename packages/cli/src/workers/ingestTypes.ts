import type { PermissionPrompt } from "../permissionDetector.js";
import type { ParsedMessage, CodexSessionMetadata } from '../parser.js';
import { validCursor } from './scanTypes.js';
export const INGEST_WINDOW_ROWS = 256;
export const INGEST_PAGE_BYTES = 256 * 1024;
export const INGEST_PAGE_TOKENS = 128;
export const INGEST_STRING_CHUNK = 8192;
export const INGEST_MAX_BYTES = 128 * 1024 * 1024;
export const INGEST_CLIENTS = ['claude','cursor','cursorDb','codex','gemini','opencode','pi','grok'] as const;
export type IngestIdentity = { dev: number; ino: number; birthtimeMs: number; mtimeMs: number; ctimeMs: number; size: number };
export type IngestJob = { client: typeof INGEST_CLIENTS[number]; file: string; sessionId: string; generation: string; identity: IngestIdentity; walIdentity?: IngestIdentity | null; offset: number; model?: string; modelKnown?: boolean; recoverBackup?: boolean };
export type IngestPayload = { action: 'open'; job: IngestJob } | { action: 'next' | 'close'; cursor: string; generation: string; sequence: number };
export type IngestToken = ['o' | 'a' | 's' | 'e' | 'z'] | ['t', string] | ['v', number | boolean | null];
export type IngestPage = { cursor: string; generation: string; sequence: number; tokens: IngestToken[]; done: boolean };
export type IngestResult = {
  messages: ParsedMessage[];
  bytesConsumed: number;
  fileSize: number;
  totalCount: number;
  maxRowId: number;
  model?: string;
  signatures?: string[];
  receiptSignatures?: string[];
  messageTitles?: Array<string | null>;
  handoffParents?: Array<string | null>;
  metadata: {
    slug?: string; parentUuid?: string; cwd?: string; cliFlags?: string | null;
    summaryTitle?: string; headMessages?: ParsedMessage[];
    teamInfo?: { teamName: string; agentName: string };
    planTools?: { name: string; input: Record<string, any>; occurrence: string }[];
    subagent?: { description?: string; agentType?: string };
    appServerHead?: string; codex?: CodexSessionMetadata; forkRoot?: string;
    completedReview?: boolean; backupAttempted?: boolean;
    title?: string; parentSessionId?: string; agentName?: string;
    sessionExists?: boolean; internal?: boolean; turn?: 'active' | 'idle' | 'unknown';
    permissionPrompt?: PermissionPrompt | null;
    warnings: string[];
  };
};
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, any>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const text = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0');
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
function validIdentity(v: unknown): v is IngestIdentity {
  return object(v) && keys(v,['dev','ino','birthtimeMs','mtimeMs','ctimeMs','size']) && ['dev','ino','birthtimeMs','mtimeMs','ctimeMs','size'].every(k => Number.isFinite(v[k]) && v[k] >= 0) && count(v.size);
}
export function validIngestJob(v: unknown): v is IngestJob {
  return object(v) && keys(v,['client','file','sessionId','generation','identity','walIdentity','offset','model','modelKnown','recoverBackup']) && INGEST_CLIENTS.includes(v.client) && text(v.file,4096) && text(v.sessionId,256) && validCursor(v.generation) && count(v.offset) && (v.model === undefined || text(v.model,4096)) && (v.modelKnown === undefined || typeof v.modelKnown === 'boolean') && (v.recoverBackup === undefined || typeof v.recoverBackup === 'boolean') && (v.walIdentity === undefined || v.walIdentity === null || validIdentity(v.walIdentity)) && object(v.identity) && keys(v.identity,['dev','ino','birthtimeMs','mtimeMs','ctimeMs','size']) && ['dev','ino','birthtimeMs','mtimeMs','ctimeMs','size'].every(k => Number.isFinite(v.identity[k]) && v.identity[k] >= 0) && count(v.identity.size);
}
export function validIngestPayload(v: unknown): v is IngestPayload {
  return object(v) && (v.action === 'open' ? keys(v,['action','job']) && validIngestJob(v.job) : ['next','close'].includes(v.action) && keys(v,['action','cursor','generation','sequence']) && validCursor(v.cursor) && validCursor(v.generation) && count(v.sequence));
}
export function validIngestPage(v: unknown): v is IngestPage {
  if (!object(v) || !keys(v,['cursor','generation','sequence','tokens','done']) || !validCursor(v.cursor) || !validCursor(v.generation) || !count(v.sequence) || typeof v.done !== 'boolean' || !Array.isArray(v.tokens) || v.tokens.length > INGEST_PAGE_TOKENS || !v.done && !v.tokens.length) return false;
  if (!v.tokens.every((t: unknown) => Array.isArray(t) && (t.length === 1 && ['o','a','s','e','z'].includes(t[0]) || t.length === 2 && (t[0] === 't' && typeof t[1] === 'string' && t[1].length <= INGEST_STRING_CHUNK || t[0] === 'v' && (t[1] === null || typeof t[1] === 'boolean' || typeof t[1] === 'number' && Number.isFinite(t[1])))))) return false;
  return Buffer.byteLength(JSON.stringify(v)) <= INGEST_PAGE_BYTES;
}
