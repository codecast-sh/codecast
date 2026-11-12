// Which folders the session rail's Filter menu offers up front.
//
// Every folder a session ever ran in is a filter, and a long-lived account
// collects dozens of them: real repos, but also one-off scratch folders named
// after a prompt ("and-just-in-general-this-…") or a UUID. The menu leads with
// a short list of the folders the person actually works in, and keeps the
// rest one step away behind "All folders…". Nothing is dropped: the full list
// is still the whole of projectCounts.

export const FOLDER_SHORT_LIST_SIZE = 5;
export const FOLDER_ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Per folder: sessions active inside the window, and the newest activity. */
export type FolderActivity = { recent: number; lastActive: number };

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LONG_HEX = /^[0-9a-f]{16,}$/i;

/** A folder named like a generated id: a UUID (possibly with a suffix) or a long hex run. */
export function isUuidLikeFolder(name: string): boolean {
  return UUID_LIKE.test(name) || LONG_HEX.test(name);
}

/** A folder a tool named after a prompt: lowercase words joined by hyphens,
 *  four or more of them ("yaml-create-a-github-file"). Real repos rarely are. */
export function looksPromptDerived(name: string): boolean {
  if (name !== name.toLowerCase()) return false;
  const words = name.split("-");
  return words.length >= 4 && words.every((w) => /^[a-z0-9]+$/.test(w));
}

/** Scratch: a generated id, or a prompt-named folder that only ever held one session. */
export function isScratchFolder(name: string, sessionCount: number): boolean {
  return isUuidLikeFolder(name) || (sessionCount <= 1 && looksPromptDerived(name));
}

/**
 * The Filter menu's short list: the most active non-scratch folders over the
 * last 30 days, by sessions in that window, then by recency, then by all-time
 * count. Folders with no activity in the window only fill in when nothing
 * qualifies, so an account that went quiet still gets a useful list.
 */
export function folderShortList(
  projectCounts: ReadonlyArray<readonly [string, number]>,
  activity: Readonly<Record<string, FolderActivity>> | undefined,
  limit: number = FOLDER_SHORT_LIST_SIZE,
): string[] {
  const candidates = projectCounts.filter(([name, count]) => !isScratchFolder(name, count));
  const recentOf = (name: string) => activity?.[name]?.recent ?? 0;
  const lastOf = (name: string) => activity?.[name]?.lastActive ?? 0;
  const ranked = [...candidates].sort(
    ([a, ac], [b, bc]) => recentOf(b) - recentOf(a) || lastOf(b) - lastOf(a) || bc - ac || a.localeCompare(b),
  );
  const active = ranked.filter(([name]) => recentOf(name) > 0);
  return (active.length > 0 ? active : ranked).slice(0, limit).map(([name]) => name);
}
