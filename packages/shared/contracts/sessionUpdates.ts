export interface SessionUpdateMember {
  id: string;
  from: string;
  sent_at: number;
  body: string;
}

export const SESSION_UPDATE_WINDOW_MS = 2000;
export const SESSION_UPDATE_MAX_HOLD_MS = 15000;
export const SESSION_UPDATE_MAX_MEMBERS = 8;
export const SESSION_UPDATE_MAX_BATCH_BYTES = 16384;
export const SESSION_UPDATE_MAX_BODY_BYTES = 8192;

const OPEN = '<session-updates version="1">';
const CLOSE = '</session-updates>';
const encoder = new TextEncoder();
const IDENTIFIER = /^[a-zA-Z0-9:_-]{1,128}$/;

export function formatSessionUpdateBatch(batchId: string, members: SessionUpdateMember[]): string {
  const payload = JSON.stringify({
    id: batchId,
    members: members.map(({ id, from, sent_at, body }) => ({ id, from, sent_at, body })),
  }).replace(/[<>&]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `${OPEN}\n${payload}\n${CLOSE}`;
}

function stripPrefix(raw: string): string {
  return raw.replace(/^[\x00-\x1f\s]+/, '')
    .replace(/^(?:(?:<system-reminder>[\s\S]*?<\/system-reminder>|<task-reminder>[\s\S]*?<\/task-reminder>)[\x00-\x1f\s]*)+/, '');
}

export function isSessionUpdateBatch(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && /^<session-updates(?:\s|>)/.test(stripPrefix(raw.slice(0, SESSION_UPDATE_MAX_BATCH_BYTES * 2)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function isMember(value: unknown): value is SessionUpdateMember {
  return isRecord(value) && Object.keys(value).length === 4
    && isIdentifier(value.id) && isIdentifier(value.from)
    && typeof value.sent_at === 'number' && Number.isSafeInteger(value.sent_at)
    && value.sent_at >= 0 && value.sent_at <= 8640000000000000
    && typeof value.body === 'string' && value.body.trim().length > 0
    && encoder.encode(value.body).byteLength <= SESSION_UPDATE_MAX_BODY_BYTES;
}

export function parseSessionUpdateBatch(raw: string | null | undefined): { id: string; members: SessionUpdateMember[] } | null {
  if (typeof raw !== 'string' || raw.length > SESSION_UPDATE_MAX_BATCH_BYTES * 2) return null;
  const text = stripPrefix(raw);
  if (!text.startsWith(OPEN)) return null;
  const end = text.indexOf(CLOSE, OPEN.length);
  if (end === -1 || stripPrefix(text.slice(end + CLOSE.length)).length > 0) return null;
  if (encoder.encode(text.slice(0, end + CLOSE.length)).byteLength > SESSION_UPDATE_MAX_BATCH_BYTES) return null;
  const payload = text.slice(OPEN.length, end).trim();
  if (/[<>&]/.test(payload)) return null;
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(value) || Object.keys(value).length !== 2 || !isIdentifier(value.id)) return null;
  const members = value.members;
  if (!Array.isArray(members) || members.length === 0 || members.length > SESSION_UPDATE_MAX_MEMBERS || !members.every(isMember)) return null;
  if (new Set(members.map((member) => member.id)).size !== members.length) return null;
  return { id: value.id, members };
}
