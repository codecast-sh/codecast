// A file attached to a message from the web composer. The browser cannot name
// a path on the session's machine, so the file goes to storage and the message
// carries a tag naming it. The daemon delivering the message saves the file on
// the session's machine and hands the agent the local path instead of the tag.

export type AttachedFileRef = { storageId: string; name: string };

const FILE_TAG_RE = /\[File (.+?) · upload ([A-Za-z0-9]{8,})\]/g;

/** A file name that fits inside the tag and on disk: no path, brackets or line breaks. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\[\]\n\r\t\0]/g, "").replace(/·/g, "-").trim().slice(0, 120);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "file";
}

export function formatFileTag(ref: AttachedFileRef): string {
  return `[File ${safeFileName(ref.name)} · upload ${ref.storageId}]`;
}

/** The person's words followed by one tag per attached file. */
export function appendFileTags(text: string, files: AttachedFileRef[]): string {
  if (files.length === 0) return text;
  const tags = files.map(formatFileTag).join("\n");
  const words = text.trimEnd();
  return words ? `${words}\n\n${tags}` : tags;
}

export function parseFileTags(text: string): AttachedFileRef[] {
  return [...text.matchAll(FILE_TAG_RE)].map((m) => ({ name: m[1], storageId: m[2] }));
}

/** Replaces each tag with what `resolve` gives for it: the local path as
 *  `[File <path>]`, or a note that the file is gone when it returns null.
 *  A throw from `resolve` (a fetch that failed in transit) propagates, so the
 *  caller can retry the delivery rather than send the text without the file. */
export async function materializeFileTags(
  text: string,
  resolve: (ref: AttachedFileRef) => Promise<string | null>,
): Promise<string> {
  const refs = parseFileTags(text);
  if (refs.length === 0) return text;
  const paths = new Map<string, string | null>();
  for (const ref of refs) {
    if (!paths.has(ref.storageId)) paths.set(ref.storageId, await resolve(ref));
  }
  return text.replace(FILE_TAG_RE, (_all, name: string, storageId: string) => {
    const path = paths.get(storageId);
    return path ? `[File ${path}]` : `[File ${name}: no longer available]`;
  });
}
