import type { Activity, Block } from './log';
import { parseScopeKey, scopeKey, type Scope } from './scope';
import type { TreeBlock } from './tree';

/** What a handle names. Every parsed handle is still checked against the reader's viewer before it opens. */
export type ParsedHandle =
  | { kind: 'block'; id: string }
  | { kind: 'block'; scope: Scope; at: TreeBlock }
  | { kind: 'story'; key: string; fromMs: number; toMs: number; scope?: Scope }
  | { kind: 'activity'; id: string }
  | { kind: 'ref'; ref: string };

/**
 * Mints and parses the handles a read shows and the agent passes back. Handles
 * are opaque to the model; a host keeps its own format by supplying a codec.
 */
export interface HandleCodec {
  /** The word in a block's rendered frame: `[<tag>:<handle> | dates]`. */
  readonly blockTag: string;
  block(b: Block): string;
  /**
   * A story is one aggregated line: activities of one kind between two
   * instants (inclusive), in one scope when the read that printed it was
   * scoped. A codec that drops the scope makes its stories open across the
   * scopes the viewer may read.
   */
  story(key: string, fromMs: number, toMs: number, scope?: Scope): string;
  activity(a: Activity): string;
  /** Null when the handle is malformed. Anything the codec does not recognize is a host `ref`. */
  parse(handle: string): ParsedHandle | null;
  /** Shortened handles resolve to the full ones that start with them. */
  resolvePrefix?(prefix: string): Promise<string[]>;
}

const NUM = /^-?\d+$/;
const POSITION = /^(\d{1,16})\.(\d{1,16})$/;

/**
 * The default codec. Position is identity in the tree, so a numbered block's
 * handle is its place: `b:<level>.<index>@<scope>`. A legacy leaf with no
 * position is `b:#<id>`; a story is `s:<kind>|<fromMs>|<toMs>`, or
 * `s@<scope, URI-encoded>:<kind>|<fromMs>|<toMs>` in one scope; an activity
 * is `a:<id>`. Handles are constructible, which is why every open checks the
 * viewer.
 */
export const positionalCodec: HandleCodec = {
  blockTag: 'block',
  block: (b) => (b.index == null ? `b:#${b.id}` : `b:${b.level}.${b.index}@${scopeKey(b.scope)}`),
  story: (key, fromMs, toMs, scope) => (scope ? `s@${encodeURIComponent(scopeKey(scope))}:` : 's:') + `${key}|${fromMs}|${toMs}`,
  activity: (a) => `a:${a.id}`,
  parse(handle) {
    const h = handle.trim();
    // No store can hold a NUL byte; a handle carrying one names nothing.
    if (h.includes('\u0000')) return null;
    if (h.startsWith('b:#')) return h.length > 3 ? { kind: 'block', id: h.slice(3) } : null;
    if (h.startsWith('b:')) {
      const at = h.indexOf('@');
      if (at < 0) return null;
      const place = POSITION.exec(h.slice(2, at));
      const scope = parseScopeKey(h.slice(at + 1));
      if (!scope || !place) return null;
      const l = Number(place[1]);
      const i = Number(place[2]);
      // A block's last leaf must still be a countable number.
      if (l > 52 || !Number.isSafeInteger((i + 1) * 2 ** l)) return null;
      return { kind: 'block', scope, at: { level: l, index: i } };
    }
    if (h.startsWith('s:')) return parseStory(h.slice(2));
    if (h.startsWith('s@')) {
      const colon = h.indexOf(':', 2);
      if (colon < 0) return null;
      let key: string;
      try {
        key = decodeURIComponent(h.slice(2, colon));
      } catch {
        return null;
      }
      const scope = parseScopeKey(key);
      const story = parseStory(h.slice(colon + 1));
      return scope && story && story.kind === 'story' ? { ...story, scope } : null;
    }
    if (h.startsWith('a:')) return h.length > 2 ? { kind: 'activity', id: h.slice(2) } : null;
    return h ? { kind: 'ref', ref: h } : null;
  },
};

/** `<key>|<fromMs>|<toMs>`, split from the right so a key may hold '|'. */
export function parseStory(s: string): ParsedHandle | null {
  const b = s.lastIndexOf('|');
  const a = b > 0 ? s.lastIndexOf('|', b - 1) : -1;
  if (a <= 0) return null;
  const key = s.slice(0, a);
  const from = s.slice(a + 1, b);
  const to = s.slice(b + 1);
  if (!NUM.test(from) || !NUM.test(to)) return null;
  const fromMs = Number(from);
  const toMs = Number(to);
  if (fromMs > toMs) return null;
  return { kind: 'story', key, fromMs, toMs };
}
