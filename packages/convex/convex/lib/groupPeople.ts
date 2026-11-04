// Who an issue hit, as distinct people. A source names one person by an id, an
// email or a name, and not always the same one (an anonymous id on one event,
// the signed-in id and email on the next). Every identifier an occurrence
// carries is a key of that one person: event_group_users stores each key as
// an alias, and a person counts once whichever of their keys arrives.

export type UserLike = { id?: string | null; email?: string | null; name?: string | null } | null | undefined;

/** Every identifier an occurrence names its person by, normalized. */
export function userKeys(user: UserLike): string[] {
  const keys = [user?.id, user?.email, user?.name].map((k) => (k ?? "").trim().toLowerCase().slice(0, 200)).filter(Boolean);
  return [...new Set(keys)];
}

/**
 * The people a set of occurrences names: keys that ever ride one occurrence
 * together belong to one person, so each cluster is one person with all their
 * aliases.
 */
export function clusterPeople(users: UserLike[]): string[][] {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  for (const u of users) {
    const keys = userKeys(u);
    for (const k of keys) if (!parent.has(k)) parent.set(k, k);
    for (const k of keys.slice(1)) parent.set(find(k), find(keys[0]));
  }
  const out = new Map<string, string[]>();
  for (const k of parent.keys()) {
    const r = find(k);
    out.set(r, [...(out.get(r) ?? []), k]);
  }
  return [...out.values()];
}

/**
 * A group's stored count corrected by what its kept samples show: each
 * person the samples name whose aliases were stored as several people counts
 * once. `stored` is the group's alias rows; the answer is how many to take
 * off and which aliases to add so the next occurrence matches.
 */
export function mergeStoredPeople(clusters: string[][], stored: ReadonlySet<string>): { over: number; add: string[] } {
  let over = 0;
  const add: string[] = [];
  for (const c of clusters) {
    const held = c.filter((k) => stored.has(k)).length;
    if (!held) continue;
    over += held - 1;
    add.push(...c.filter((k) => !stored.has(k)));
  }
  return { over, add };
}
