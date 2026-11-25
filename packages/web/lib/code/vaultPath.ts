// A path someone typed or a command passed, as a path inside the vault.
// Opening a missing path makes a new file on the first save, so a path that
// only looks relative (an absolute path, `~`, `..` out of the root) must be
// resolved or refused here, never trimmed into a junk folder in the repo.

export type VaultPathResult = { path: string } | { refused: string };

/** `input` relative to the vault root, or why it is not a path in the vault.
 *  An absolute path counts when it lies under `root`. */
export function resolveVaultPath(input: string, root: string | null | undefined): VaultPathResult {
  let s = input.trim();
  if (!s) return { refused: "needs a file name" };
  if (/^~(\/|$)/.test(s)) return { refused: "~ isn't expanded here; give a path inside this folder" };
  if (s.startsWith("/")) {
    const r = root?.replace(/\/+$/, "");
    if (!r || !(s === r || s.startsWith(`${r}/`))) return { refused: "is outside this folder" };
    s = s.slice(r.length);
  }
  const parts: string[] = [];
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return { refused: "leaves this folder" };
      parts.pop();
    } else parts.push(seg);
  }
  if (!parts.length) return { refused: "names the folder, not a file" };
  return { path: parts.join("/") };
}
