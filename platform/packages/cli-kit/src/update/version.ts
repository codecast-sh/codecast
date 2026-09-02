// Pure version and channel logic. No I/O, so every branch is testable.

/** Numeric, segment by segment comparison: "1.2.10" > "1.2.9". Missing
 *  segments count as 0, so "1.2" equals "1.2.0". Returns -1, 0, or 1. */
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

/** True when `version` is below the fleet minimum. A null minimum (no kill
 *  switch set) is never below. */
export function isBelowMinimum(version: string, minimum: string | null | undefined): boolean {
  if (!minimum) return false;
  return compareVersions(version, minimum) < 0;
}

export type UpdateDecision =
  | { kind: "none" }
  | { kind: "available"; version: string }
  | { kind: "forced"; version: string; minimum: string };

/**
 * One decision for every surface: nothing to do, a newer build exists and the
 * user may take it, or the installed build is below the published minimum and
 * the update must be applied without asking. A forced update targets the
 * latest build, never the minimum itself.
 */
export function decideUpdate(input: {
  current: string;
  latest: string | null | undefined;
  minimum?: string | null;
}): UpdateDecision {
  const { current, latest, minimum } = input;
  if (!latest) return { kind: "none" };
  if (isBelowMinimum(current, minimum)) {
    return { kind: "forced", version: latest, minimum: minimum as string };
  }
  if (compareVersions(latest, current) > 0) return { kind: "available", version: latest };
  return { kind: "none" };
}

// ── channels ─────────────────────────────────────────────────────────────────

/** A channel names one manifest under the release base URL. "stable" reads
 *  latest.json; a "beta" channel would read latest-beta.json. */
export interface ChannelSpec {
  name: string;
  /** Manifest path relative to the release base URL. */
  manifestPath: string;
}

export const STABLE_CHANNEL: ChannelSpec = { name: "stable", manifestPath: "latest.json" };

/**
 * Pick the channel. Precedence: explicit request, then a persisted choice,
 * then the first channel in the list (the default). An unknown name falls
 * back to the default so a stale state file cannot pin a client to a channel
 * that no longer exists.
 */
export function resolveChannel(
  channels: readonly ChannelSpec[],
  requested?: string | null,
  persisted?: string | null,
): ChannelSpec {
  if (channels.length === 0) return STABLE_CHANNEL;
  const byName = (name: string | null | undefined) =>
    name ? channels.find((c) => c.name === name) : undefined;
  return byName(requested) ?? byName(persisted) ?? channels[0];
}

export function manifestUrl(releaseBaseUrl: string, channel: ChannelSpec): string {
  return `${releaseBaseUrl.replace(/\/+$/, "")}/${channel.manifestPath.replace(/^\/+/, "")}`;
}

// ── platform keys ────────────────────────────────────────────────────────────

const PLATFORM_NAMES: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };
const ARCH_NAMES: Record<string, string> = { arm64: "arm64", x64: "x64", x86_64: "x64" };

/** "darwin-arm64", "linux-x64", "windows-x64": the key used by latest.json,
 *  checksums.json, the npm shim and the Homebrew formula alike. Windows on ARM
 *  has no native build and runs the x64 binary under emulation. */
export function platformKey(platform: string, arch: string): string {
  const p = PLATFORM_NAMES[platform] ?? platform;
  const a = p === "windows" ? "x64" : ARCH_NAMES[arch] ?? arch;
  return `${p}-${a}`;
}

/** Release asset file name for a binary name and platform key. */
export function assetName(binaryName: string, key: string): string {
  return key.startsWith("windows") ? `${binaryName}-${key}.exe` : `${binaryName}-${key}`;
}
