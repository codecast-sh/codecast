/**
 * Scopes: the places a log lives. A person, a group chat, a channel, a team
 * and the global scope are all scopes; the host registers which kinds exist
 * and how each behaves. Every row also carries a partition, a wall no read
 * crosses.
 */

/** A host-registered kind of place: 'person', 'group', 'channel', 'team', 'global', … */
export type ScopeType = string;

export interface Scope {
  readonly type: ScopeType;
  readonly id: string;
}

/** `type:id`. The id may itself contain ':'; only the first ':' separates. */
export const scopeKey = (s: Scope): string => `${s.type}:${s.id}`;

export function parseScopeKey(key: string): Scope | null {
  const at = key.indexOf(':');
  if (at <= 0 || at === key.length - 1) return null;
  return { type: key.slice(0, at), id: key.slice(at + 1) };
}

export const sameScope = (a: Scope, b: Scope): boolean => a.type === b.type && a.id === b.id;

export const GLOBAL: Scope = { type: 'global', id: 'global' };

export interface ScopeTypeDef {
  type: ScopeType;
  /** Summarize this scope's log into a tree. Off for short-lived scopes. Default true. */
  compress?: boolean;
  /** Shows in the cross-scope feed. Off for tenancy walls or noise. Default true. */
  inGlobalFeed?: boolean;
  /** May a run in this scope write memory to the global scope? Default false. */
  writesGlobalMemory?: boolean;
  /** False for read-only scopes nothing runs at. Default true. */
  runnable?: boolean;
}

/** Reads slice across scopes. */
export type ScopeSelector =
  | { scope: Scope }
  | { anyOf: Scope[] }
  | { types: ScopeType[] }
  /** The cross-scope feed: every scope whose type shows in the feed, minus `except`. */
  | { all: true; except?: ScopeType[] };

/** A wall no read crosses. Every row carries one; every read names one. */
export type Partition = string;
export const DEFAULT_PARTITION: Partition = 'default';

export interface Viewer {
  agentId: string;
  partition: Partition;
  /** The scopes a run may open by handle. */
  canRead(scope: Scope): boolean | Promise<boolean>;
}

/** A viewer that may read exactly the given scopes (by default, one: the run's own). */
export function scopedViewer(agentId: string, scopes: Scope | Scope[], partition: Partition = DEFAULT_PARTITION): Viewer {
  const keys = new Set((Array.isArray(scopes) ? scopes : [scopes]).map(scopeKey));
  return { agentId, partition, canRead: (s) => keys.has(scopeKey(s)) };
}

/** A viewer that may read every scope in its partition (an operator agent reading the feed). */
export function partitionViewer(agentId: string, partition: Partition = DEFAULT_PARTITION): Viewer {
  return { agentId, partition, canRead: () => true };
}

/** The host's scope types with their defaults applied. Unregistered types take the defaults. */
export interface ScopeRegistry {
  def(type: ScopeType): Required<ScopeTypeDef>;
  /** Types whose logs are never summarized. */
  uncompressed(): ScopeType[];
  /** Types kept out of the cross-scope feed. */
  offFeed(): ScopeType[];
}

export function scopeRegistry(defs: readonly ScopeTypeDef[] = []): ScopeRegistry {
  const byType = new Map<ScopeType, Required<ScopeTypeDef>>();
  for (const d of defs) {
    byType.set(d.type, {
      type: d.type,
      compress: d.compress ?? true,
      inGlobalFeed: d.inGlobalFeed ?? true,
      writesGlobalMemory: d.writesGlobalMemory ?? false,
      runnable: d.runnable ?? true,
    });
  }
  const def = (type: ScopeType) =>
    byType.get(type) ?? { type, compress: true, inGlobalFeed: true, writesGlobalMemory: false, runnable: true };
  return {
    def,
    uncompressed: () => [...byType.values()].filter((d) => !d.compress).map((d) => d.type),
    offFeed: () => [...byType.values()].filter((d) => !d.inGlobalFeed).map((d) => d.type),
  };
}

/** One scope, or null when the selector spans several. */
export function singleScope(select: ScopeSelector): Scope | null {
  if ('scope' in select) return select.scope;
  if ('anyOf' in select && select.anyOf.length === 1) return select.anyOf[0];
  return null;
}

/**
 * The selector a store runs: `all` gains the registry's off-feed types in
 * `except`, so a store never needs the registry to honor the feed's walls.
 */
export function storeSelector(select: ScopeSelector, registry: ScopeRegistry): ScopeSelector {
  if ('all' in select) {
    return { all: true, except: [...new Set([...(select.except ?? []), ...registry.offFeed()])] };
  }
  return select;
}

/** Whether a scope falls inside a store selector (already widened by storeSelector). */
export function selects(select: ScopeSelector, s: Scope): boolean {
  if ('scope' in select) return sameScope(select.scope, s);
  if ('anyOf' in select) return select.anyOf.some((x) => sameScope(x, s));
  if ('types' in select) return select.types.includes(s.type);
  return !(select.except ?? []).includes(s.type);
}
