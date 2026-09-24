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
