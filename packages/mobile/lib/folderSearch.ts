// The new-session sheet's folder search past the recent session folders: the
// machine's checkouts (local_project_roots, which its daemon publishes on every
// heartbeat), and a new folder when a typed name matches nothing. The daemon
// creates a missing folder inside home when the session starts there.

const HOME_RE = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/;

/** Display-only "~" collapse. web/lib/utils' inferHomeDir sits beside
 *  window/document helpers, so the one-line version lives here rather than
 *  dragging that module into the Hermes bundle. */
export const displayPath = (p: string) => p.replace(HOME_RE, "~");

const folderName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
const parentOf = (p: string) => p.replace(/\/+$/, "").replace(/\/[^/]*$/, "");

/** A typed "~/x" as the absolute path on the machine whose folders are known. */
export function expandHome(typed: string, known: string[]): string {
  if (!/^~(\/|$)/.test(typed)) return typed;
  const home = known.map((p) => p.match(HOME_RE)?.[1]).find(Boolean);
  return home ? home + typed.slice(1) : typed;
}

/** Checkouts whose folder name contains the query, name-prefix matches first,
 *  minus the ones the recents already list. */
export function checkoutMatches(roots: string[], query: string, listed: Set<string>): string[] {
  const q = query.toLowerCase();
  return roots
    .filter((r) => !listed.has(r) && folderName(r).toLowerCase().includes(q))
    .sort((a, b) => Number(!folderName(a).toLowerCase().startsWith(q)) - Number(!folderName(b).toLowerCase().startsWith(q)));
}

/** Where a new folder with this name goes: beside most of the machine's
 *  checkouts (else its recent folders). Null for a name that isn't one plain
 *  folder name, or when nothing says where code lives. */
export function newFolderPath(name: string, roots: string[], recents: string[]): string | null {
  if (!/^[\w.-]+$/.test(name) || name === "." || name === "..") return null;
  const counts = new Map<string, number>();
  for (const p of roots.length ? roots : recents) {
    const parent = parentOf(p);
    if (HOME_RE.test(parent)) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [parent, n] of counts) if (!best || n > counts.get(best)!) best = parent;
  return best ? `${best}/${name}` : null;
}
