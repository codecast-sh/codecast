// How a folder list (the chosen folders, the excluded ones) is read: a folder
// is in it when it is listed or sits below a listed one. Its own leaf, so the
// daemon's sync rule loads these few lines and nothing else.

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** A folder is the listed one or sits below it. A listed "/" covers only
 *  itself, as the daemon has always read it. */
export function folderCovers(folder: string, above: string): boolean {
  const [a, b] = [trimSlash(folder), trimSlash(above)];
  return a === b || a.startsWith(b + "/");
}

const HOME_FOLDER = /^\/(?:Users|home)\/[^/]+(?=\/|$)/;

/** A folder's place under its machine's home ("" for the home itself), or
 *  null for a folder outside any home. One person's machines keep a project
 *  at the same place under home even when the account names differ
 *  (/Users/david/git/app on a laptop, /Users/rentamac/git/app on a rented
 *  Mac), so this is what names "the same folder" across their machines. */
export function folderUnderHome(folder: string): string | null {
  const t = trimSlash(folder);
  const m = t.match(HOME_FOLDER);
  return m ? t.slice(m[0].length) : null;
}

/** The same folder on this machine: a listed folder from another of the
 *  person's machines moved under `home`. Folders outside a home stay put. */
export function folderOnThisMachine(folder: string, home: string): string {
  const rest = folderUnderHome(folder);
  return rest === null || !home ? folder : trimSlash(home) + rest;
}

/** folderCovers across the person's machines: a folder listed on one machine
 *  covers the same place under home on every other. A folder list (the chosen
 *  folders, the excluded ones) belongs to the person, not to one machine. */
export function folderCoversOnAnyMachine(folder: string, above: string): boolean {
  if (folderCovers(folder, above)) return true;
  const [a, b] = [folderUnderHome(folder), folderUnderHome(above)];
  return a !== null && b !== null && (a === b || a.startsWith(b + "/"));
}
