import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The own-workspace gate (ct-56832). A proposal may only touch records of its
// freeze's workspace. Two reps in flight once shared /tmp, and a Union rep
// read the codecast rep's org inputs and proposed 48 codecast closes; graded
// against Union's labels, that run says nothing about the prompt.
//
// What can be proved offline is ownership by another workspace: every id a
// local snapshot or a workspace's labels hold belongs to that workspace. A
// snapshot is not an index of its workspace (the analyzer also finds records
// through git history and, on an uncut snapshot, live reads), so an id no
// workspace on record holds is left alone rather than failed.
//
// Ids are found by shape in any field of a change, since the contract puts
// them in many (task, plan, scope.add, seat.existing, file.project, ...); a
// field that holds a title instead is simply not an id.

/** Short ids (task, plan, project, initiative), full Convex ids, and session short ids. */
const SHAPE = '(?:ct|pl|pj|in)-[a-z0-9]+|[a-z0-9]{32}|jx[a-z0-9]{5}';
const ID = new RegExp(`(?<![A-Za-z0-9_-])(${SHAPE})(?![A-Za-z0-9_-])`, 'g');
const ID_EXACT = new RegExp(`^(?:${SHAPE})$`);

/** Every record id a proposal's changes name, in order of first mention. */
export function proposalRecordIds(changes: Array<{ change?: unknown }>): string[] {
  const ids = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      const s = v.trim().replace(/^(project|plan):/, '');
      if (ID_EXACT.test(s)) ids.add(s);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const row of changes) walk(row?.change ?? row);
  return [...ids];
}

/** Every record id under a dir (its files and captured reads, recursively). */
function idsUnder(dir: string, into: Set<string>): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) idsUnder(p, into);
    else for (const m of readFileSync(p, 'utf8').matchAll(ID)) into.add(m[1]!);
  }
}

/** A record id and the workspaces whose snapshots or labels hold it. */
export type RecordOwners = Map<string, Set<string>>;

const owned = new Map<string, RecordOwners>();
/** Which workspaces hold each record id, from dirs each known to be one workspace's. Read once per set of dirs. */
export function recordOwners(sources: Array<{ workspace: string; dir: string }>): RecordOwners {
  const key = JSON.stringify(sources);
  const hit = owned.get(key);
  if (hit) return hit;
  const owners: RecordOwners = new Map();
  for (const s of sources) {
    const ids = new Set<string>();
    idsUnder(s.dir, ids);
    for (const id of ids) owners.set(id, (owners.get(id) ?? new Set()).add(s.workspace));
  }
  owned.set(key, owners);
  return owners;
}

/** The ids a proposal touches that another workspace holds and this one does not, each with the workspaces that hold it. A session short id is held where a full id starting with it is. */
export function foreignRecords(changes: Array<{ change?: unknown }>, workspace: string, owners: RecordOwners): Array<{ id: string; owners: string[] }> {
  const holders = (id: string): Set<string> => {
    if (owners.has(id) || !/^jx[a-z0-9]{5}$/.test(id)) return owners.get(id) ?? new Set();
    const all = new Set<string>();
    for (const [full, ws] of owners) if (full.length === 32 && full.startsWith(id)) ws.forEach((w) => all.add(w));
    return all;
  };
  return proposalRecordIds(changes).flatMap((id) => {
    const ws = holders(id);
    return ws.size && !ws.has(workspace) ? [{ id, owners: [...ws].sort() }] : [];
  });
}
