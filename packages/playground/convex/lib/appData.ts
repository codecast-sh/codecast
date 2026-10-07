// What the runtime data layer accepts from app code: collection and key
// names, document values, shared values and presence state. App code is
// untrusted, so every value is checked here before it reaches the database,
// and each check says what is wrong in words an app author can act on.
import { DATA_NAME_MAX, DATA_WHERE_FIELDS_MAX, MAX_DATA_DEPTH, MAX_DATA_DOC_BYTES, MAX_PRESENCE_STATE_BYTES } from "./limits";
import { byteLength } from "./files";

/** useShared values live in this collection, one doc per key. App
 *  collection names cannot start with "~", so it never collides. */
export const SHARED_COLLECTION = "~shared";
/** useMine values: one doc per visitor per key, keyed "<visitor id>:<key>"
 *  by the server from the caller's token, so no app can read another
 *  person's. */
export const MINE_COLLECTION = "~mine";

/** A read's or removeWhere's filter: top-level fields equal to these values. */
export type Where = Record<string, string | number | boolean | null>;

/** Fields the SDK adds to every doc it hands an app; never stored. */
export const RESERVED_FIELDS = ["_id", "_by", "_at"] as const;

export type Checked<T> = { ok: true; value: T; size: number } | { ok: false; problem: string };

export function isCollectionName(name: string): boolean {
  return name.length <= DATA_NAME_MAX && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(name);
}

export function isSharedKey(key: string): boolean {
  return key.length > 0 && key.length <= DATA_NAME_MAX && !/[\u0000-\u001f]/.test(key);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype;
}

/** Why `value` cannot be stored as JSON-shaped data, or null when it can. */
function shapeProblem(value: unknown, depth = 0): string | null {
  if (depth > MAX_DATA_DEPTH) return `nesting is deeper than ${MAX_DATA_DEPTH} levels`;
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? null : "numbers must be finite";
  if (Array.isArray(value)) {
    for (const item of value) {
      const p = shapeProblem(item, depth + 1);
      if (p) return p;
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (!k || k.startsWith("$")) return `"${k}" is not an allowed field name`;
      const p = shapeProblem(v, depth + 1);
      if (p) return p;
    }
    return null;
  }
  return `${typeof value} values cannot be stored; use strings, numbers, booleans, arrays and objects`;
}

function checkJson<T>(value: T, maxBytes: number, what: string): Checked<T> {
  const problem = shapeProblem(value);
  if (problem) return { ok: false, problem: `${what}: ${problem}` };
  const size = byteLength(JSON.stringify(value));
  if (size > maxBytes) return { ok: false, problem: `${what} is ${size} bytes; the limit is ${maxBytes}` };
  return { ok: true, value, size };
}

/** A collection doc: a plain object, reserved SDK fields dropped. */
export function checkDoc(value: unknown): Checked<Record<string, unknown>> {
  if (!isPlainObject(value)) return { ok: false, problem: "a doc must be a plain object" };
  const doc = Object.fromEntries(Object.entries(value).filter(([k]) => !(RESERVED_FIELDS as readonly string[]).includes(k)));
  return checkJson(doc, MAX_DATA_DOC_BYTES, "doc");
}

/** A useShared value: any JSON-shaped value. */
export function checkShared(value: unknown): Checked<unknown> {
  return checkJson(value, MAX_DATA_DOC_BYTES, "shared value");
}

/** setMyState: a plain object, small. */
export function checkPresenceState(value: unknown): Checked<Record<string, unknown>> {
  if (!isPlainObject(value)) return { ok: false, problem: "presence state must be a plain object" };
  return checkJson(value, MAX_PRESENCE_STATE_BYTES, "presence state");
}

/** A `where`: a plain object of up to DATA_WHERE_FIELDS_MAX plain field
 *  names, each matched against a string, number, boolean or null. */
export function checkWhere(where: unknown): Checked<Where> {
  if (!isPlainObject(where)) return { ok: false, problem: "where must be a plain object, like { round: 3 }" };
  const entries = Object.entries(where);
  if (entries.length > DATA_WHERE_FIELDS_MAX) return { ok: false, problem: `where matches at most ${DATA_WHERE_FIELDS_MAX} fields` };
  for (const [k, v] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)) return { ok: false, problem: `where: "${k}" is not a field name it can match` };
    if (!(v === null || ["string", "boolean"].includes(typeof v) || (typeof v === "number" && Number.isFinite(v)))) {
      return { ok: false, problem: `where: ${k} must be a string, number, boolean or null` };
    }
  }
  return { ok: true, value: where as Where, size: 0 };
}

/** Whether a doc matches a `where`, the way the server filters. */
export function matchesWhere(doc: Record<string, unknown>, where: Where | null | undefined): boolean {
  return !where || Object.entries(where).every(([k, v]) => doc[k] === v);
}
