// Getting from a note back to the actual file on disk.
//
// The vault's whole premise is that these are real files in a real folder, so
// "where is this thing?" has to have an answer. Two verbs: show it in the OS
// file manager, or hand it to whatever application owns the file type.
//
// Deliberately not a store action — it mutates nothing and returns nothing the
// UI renders, so it stays a plain call the components make directly.

import { vaultOp } from "./client";
import { useVaultStore } from "../../store/vaultStore";

export type RevealMode = "reveal" | "open";

/** True when this vault's files are physically on this machine. A mirrored
 *  vault's files live on another device, so there is nothing local to show. */
export function canRevealLocally(): boolean {
  const s = useVaultStore.getState();
  return !!s.endpoint && !!s.activeVaultId && !s.isRemote;
}

/** Show `path` in the file manager, or open it in its default application.
 *  Returns an error message for the UI, or null on success. */
export async function revealVaultPath(path: string, mode: RevealMode = "reveal"): Promise<string | null> {
  const { endpoint, activeVaultId, isRemote } = useVaultStore.getState();
  if (isRemote) return "This vault is mirrored from another machine — its files aren't on this device.";
  if (!endpoint || !activeVaultId) return "Not connected to this machine's daemon.";
  try {
    await vaultOp(endpoint, activeVaultId, { op: "reveal", path, mode });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** The label for the file manager on this platform, so the menu says the thing
 *  the user's own OS calls it rather than a generic phrase. */
export function fileManagerName(): string {
  if (typeof navigator === "undefined") return "file manager";
  const ua = navigator.userAgent;
  if (ua.includes("Mac")) return "Finder";
  if (ua.includes("Windows")) return "Explorer";
  return "file manager";
}
