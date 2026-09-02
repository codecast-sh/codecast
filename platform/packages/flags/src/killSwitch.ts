// Minimum version kill switches. A row per lever ("min_cli_version",
// "min_desktop_version"); a client below the minimum must update before it
// may continue. Storage and the admin check are injected; the compare and the
// wording live here.
//
// compareVersions matches @platform/cli-kit/update's function. It is repeated
// here so web and mobile consumers of this package do not pull Node typed
// updater code into their type check. If cli-kit exposes its pure version
// module on its own export path, import it from there and delete this copy.

/** Numeric, segment by segment compare: "1.2.10" > "1.2.9". Missing segments
 *  count as 0, so "1.2" equals "1.2.0". Returns -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map((s) => parseInt(s, 10) || 0);
  const partsB = b.split(".").map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}

/** True when `version` is below the minimum. No minimum set: never below. */
export function isBelowMinimum(version: string, minimum: string | null | undefined): boolean {
  if (!minimum) return false;
  return compareVersions(version, minimum) < 0;
}

const SEMVER = /^\d+\.\d+\.\d+$/;
export function isValidVersion(value: string): boolean {
  return SEMVER.test(value);
}

export const INVALID_VERSION_MESSAGE = "Invalid version format. Use semver (e.g., 1.0.12)";

export interface KillSwitchStorage {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, actorId: string) => Promise<void>;
}

export interface KillSwitchOptions<Token> {
  storage: KillSwitchStorage;
  /** Resolve the caller from its token. Null: unauthorized. `admin` false:
   *  forbidden. */
  authenticate: (token: Token) => Promise<{ userId: string; admin: boolean } | null>;
}

export interface KillSwitch<Token> {
  /** Current minimum for `lever` ("min_cli_version"), or null when unset. */
  getMinimum: (lever: string) => Promise<string | null>;
  /** Admin only. Validates the version and stores it. */
  setMinimum: (lever: string, version: string, token: Token) => Promise<{ success: true; version: string }>;
  /** Must the client running `version` update before continuing? */
  mustUpdate: (lever: string, version: string) => Promise<boolean>;
}

export function createKillSwitch<Token>(opts: KillSwitchOptions<Token>): KillSwitch<Token> {
  const getMinimum = (lever: string) => opts.storage.get(lever);
  return {
    getMinimum,
    setMinimum: async (lever, version, token) => {
      if (!isValidVersion(version)) throw new Error(INVALID_VERSION_MESSAGE);
      const who = await opts.authenticate(token);
      if (!who) throw new Error("Unauthorized");
      if (!who.admin) throw new Error("Admin access required");
      await opts.storage.set(lever, version, who.userId);
      return { success: true, version };
    },
    mustUpdate: async (lever, version) => isBelowMinimum(version, await getMinimum(lever)),
  };
}
