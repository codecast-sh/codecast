/**
 * Which of the human's Chrome profiles the bridge works in.
 *
 * Chrome opens a URL handed to it on the command line in its last-used
 * profile unless `--profile-directory` names one. The extension lives in
 * some profiles and not others, and a `chrome-extension://<id>/` URL opened
 * in a profile without it becomes `chrome-extension://invalid`
 * (ERR_BLOCKED_BY_CLIENT). So every page the CLI opens for the extension
 * (pairing, wake) names the profile that holds it, chosen here.
 *
 * Chrome records each installed extension, Web Store or unpacked, under
 * `extensions.settings.<id>` in the profile's `Secure Preferences` (older
 * builds: `Preferences`); a non-empty `disable_reasons` means it is turned off.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { chromeUserDataRoot, listRealProfiles, type RealProfile } from "../profile.js";
import { BRIDGE_EXTENSION_ID } from "./protocol.js";

export interface ExtensionProfiles {
  /** False when Chrome's profile list could not be read (no Chrome here, WSL, an unreadable Local State): callers then fall back to Chrome's own choice. */
  known: boolean;
  /** Every profile, in Chrome's order (last used first). */
  all: RealProfile[];
  /** The profiles with the extension installed and enabled. */
  withExtension: RealProfile[];
}

function extensionEnabledIn(profileDir: string): boolean {
  for (const file of ["Secure Preferences", "Preferences"]) {
    let prefs: any;
    try {
      prefs = JSON.parse(fs.readFileSync(path.join(profileDir, file), "utf-8"));
    } catch {
      continue;
    }
    const entry = prefs?.extensions?.settings?.[BRIDGE_EXTENSION_ID];
    if (!entry) continue;
    const reasons = entry.disable_reasons;
    const disabled = (Array.isArray(reasons) && reasons.length > 0) || (typeof reasons === "number" && reasons !== 0) || entry.state === 0;
    return !disabled;
  }
  return false;
}

export function extensionProfiles(root: string | null = chromeUserDataRoot()): ExtensionProfiles {
  const all = root ? listRealProfiles("chrome", root) : [];
  if (!root || all.length === 0) return { known: false, all: [], withExtension: [] };
  return { known: true, all, withExtension: all.filter((p) => extensionEnabledIn(path.join(root, p.dir))) };
}

/**
 * The profile the bridge uses, deterministically: the one pinned at the last
 * successful pairing while it still has the extension, else Chrome's
 * last-used profile if it has it, else the first by directory name
 * ("Default", "Profile 1", "Profile 2", …). Null when none has it.
 */
export function pickBridgeProfile(found: ExtensionProfiles, pinned?: string): RealProfile | null {
  const candidates = found.withExtension;
  return (
    candidates.find((p) => p.dir === pinned) ??
    candidates.find((p) => p.lastUsed) ??
    [...candidates].sort((a, b) => a.dir.localeCompare(b.dir, undefined, { numeric: true }))[0] ??
    null
  );
}

/** A `--profile` argument matched against a profile's name, directory or signed-in email (case-insensitive). */
export function matchProfile(profiles: RealProfile[], query: string): RealProfile | null {
  const q = query.trim().toLowerCase();
  return profiles.find((p) => p.dir.toLowerCase() === q || p.name.toLowerCase() === q || p.email?.toLowerCase() === q) ?? null;
}

/** How a profile reads in output: `"Work" (alex@x.com, Profile 2)`. */
export function describeProfile(p: RealProfile): string {
  return `"${p.name}" (${p.email ? `${p.email}, ` : ""}${p.dir})`;
}
