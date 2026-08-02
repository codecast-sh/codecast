// Which of the three ways to look at a note is on screen, and what the app
// remembers about that choice.
//
// Reading, live preview and source are one spectrum, not three screens: the
// same note, the same scroll, progressively more of the syntax visible. Two
// pieces of memory make that feel right.
//
//  * PER FILE: leave a note mid-edit, read three others, come back and you are
//    still editing it. Deliberately not in the URL — `?f=` addresses the note,
//    and a shared link should open the way the recipient reads notes.
//  * GLOBALLY, the last EDITING mode used. Someone who works in raw source
//    should get raw source the next time they press the edit chord, in a note
//    they have never opened. Without this, every new note would drag them back
//    through live preview.
//
// Both are session-lived: they describe how you are working right now, not a
// preference worth persisting.

export type VaultViewMode = "reading" | "live" | "source";
export type VaultEditMode = Exclude<VaultViewMode, "reading">;

// Keyed by path ALONE this map leaked across vaults — two vaults both holding
// `README.md` (or today's daily note) shared one mode, and a deleted note's
// mode was inherited by whatever was created at its path later. The scope is
// the vault, so the vault is part of the key (review finding, R12).
const modeByPath = new Map<string, VaultViewMode>();
let lastEditMode: VaultEditMode = "live";
let scopeVaultId = "";

const key = (path: string) => `${scopeVaultId}::${path}`;

/** Point the memory at a vault. Switching vaults forgets the previous one's
 *  modes rather than carrying them onto same-named notes. */
export function setVaultModeScope(vaultId: string | null) {
  const next = vaultId ?? "";
  if (next === scopeVaultId) return;
  scopeVaultId = next;
  modeByPath.clear();
}

/** Forget one path's mode — called when a note is deleted, so a later note at
 *  the same path opens in reading mode like any other new note. */
export function forgetVaultViewMode(path: string) {
  modeByPath.delete(key(path));
}

/** Follow a rename so the mode travels with the file. */
export function moveVaultViewMode(from: string, to: string) {
  const mode = modeByPath.get(key(from));
  if (mode === undefined) return;
  modeByPath.delete(key(from));
  modeByPath.set(key(to), mode);
}

export function vaultViewMode(path: string | null): VaultViewMode {
  if (!path) return "reading";
  return modeByPath.get(key(path)) ?? "reading";
}

export function setVaultViewMode(path: string, mode: VaultViewMode): VaultViewMode {
  modeByPath.set(key(path), mode);
  if (mode !== "reading") lastEditMode = mode;
  return mode;
}

/** The edit chord: into the way you last edited, or back out to reading. */
export function toggleVaultEditMode(path: string): VaultViewMode {
  return setVaultViewMode(path, vaultViewMode(path) === "reading" ? lastEditMode : "reading");
}

/** The source chord: raw bytes, or back to live preview once you're done
 *  looking. From reading it goes straight to source rather than stepping
 *  through live preview — jumping to the raw file is the whole point of it. */
export function toggleVaultSourceMode(path: string): VaultViewMode {
  return setVaultViewMode(path, vaultViewMode(path) === "source" ? "live" : "source");
}

/** Test seam: forget every remembered mode. */
export function resetVaultViewModes() {
  modeByPath.clear();
  lastEditMode = "live";
  scopeVaultId = "";
}
