// Two sessions on the same work can carry the same title (a coordinator and
// the worker it spawned). Each session whose title another session also
// carries gets a tag, its short handle, that the card, the tab, the window
// and the header show beside the title; a unique title gets none (ct-97018).

type TitledRow = { title?: string | null; short_id?: string | null } | undefined;

const tagsBySessions = new WeakMap<object, Map<string, string>>();

/** Session id to its tag, for every session sharing its title. One pass per
 *  sessions collection ref, then a lookup per read. */
export function duplicateTitleTags(sessions: Record<string, TitledRow>): Map<string, string> {
  const cached = tagsBySessions.get(sessions);
  if (cached) return cached;
  const byTitle = new Map<string, string[]>();
  for (const id in sessions) {
    const title = sessions[id]?.title?.trim();
    if (!title) continue;
    const ids = byTitle.get(title);
    if (ids) ids.push(id);
    else byTitle.set(title, [id]);
  }
  const tags = new Map<string, string>();
  for (const ids of byTitle.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) tags.set(id, sessions[id]?.short_id || id.slice(0, 7));
  }
  tagsBySessions.set(sessions, tags);
  return tags;
}

/** The tag that tells this session apart from another of the same title, or null. */
export function sessionTitleTag(sessions: Record<string, TitledRow> | undefined, id: string | null | undefined): string | null {
  return sessions && id ? duplicateTitleTags(sessions).get(id) ?? null : null;
}

export function taggedTitle(title: string, tag: string | null): string {
  return tag ? `${title} · ${tag}` : title;
}
