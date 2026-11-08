// Convex hands every written document to its Rust side as JSON, and that side
// refuses a string holding half of a UTF-16 surrogate pair ("Received invalid
// json: unexpected end of hex escape"), failing the whole mutation. JS makes
// such strings whenever a `.slice(0, n)` lands inside an emoji, and the tree
// has hundreds of those cuts on their way to a write. makeWellFormedDb is the
// one boundary every wrapped mutation's writes cross (functions.ts): a lone
// half becomes U+FFFD there, so a cut emoji costs one character, not the
// write. Pure, loads without the Convex runtime.

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function wellFormedString(s: string): string {
  LONE_SURROGATE.lastIndex = 0;
  return LONE_SURROGATE.test(s) ? s.replace(LONE_SURROGATE, "�") : s;
}

/** The value with every string made well formed; the same reference when nothing needed it. */
export function wellFormedValue<T>(value: T): T {
  if (typeof value === "string") return wellFormedString(value) as T;
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const next = wellFormedValue(value[i]);
      if (next !== value[i]) (out ??= value.slice())[i] = next;
    }
    return (out ?? value) as T;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    let out: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(value)) {
      const next = wellFormedValue(v);
      if (next !== v) (out ??= { ...(value as Record<string, unknown>) })[k] = next;
    }
    return (out ?? value) as T;
  }
  return value;
}

/** Cut `s` to at most `max` UTF-16 units without leaving half a surrogate pair at the end. */
export function clipText(s: string, max: number): string {
  if (s.length <= max) return s;
  const code = s.charCodeAt(max - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

function lastWellFormed(args: any[]): any[] {
  const last = args.length - 1;
  const value = wellFormedValue(args[last]);
  return value === args[last] ? args : [...args.slice(0, last), value];
}

export function makeWellFormedDb(db: any): any {
  return {
    ...db,
    get: (...args: any[]) => db.get(...args),
    query: (...args: any[]) => db.query(...args),
    normalizeId: (...args: any[]) => db.normalizeId(...args),
    system: db.system,
    // The value is always the last argument, whichever overload the caller used.
    insert: (...args: any[]) => db.insert(...lastWellFormed(args)),
    patch: (...args: any[]) => db.patch(...lastWellFormed(args)),
    replace: (...args: any[]) => db.replace(...lastWellFormed(args)),
    delete: (...args: any[]) => db.delete(...args),
  };
}
