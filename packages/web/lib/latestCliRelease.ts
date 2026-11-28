import { useState } from "react";
import { compareVersions } from "@codecast/shared/contracts/orgTemplateManifest";
import { useMountEffect } from "../hooks/useMountEffect";

// The CLI release dl.codecast.sh/latest.json names, read through the web
// server (/api/cli/latest: the manifest sends no CORS header). Settings >
// Daemon's Update names it, as `cast devices update` does, so a machine's
// day-old cached check can neither hide that it is behind nor clear the
// request before it updates (ct-102439).

let read: Promise<string | null> | null = null;

function fetchLatest(): Promise<string | null> {
  read ??= fetch("/api/cli/latest", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (typeof j?.version === "string" ? j.version : null))
    .catch(() => null)
    .then((v) => {
      // A failed read is tried again on the next mount.
      if (v === null) read = null;
      return v;
    });
  return read;
}

/** The latest CLI release: undefined while it is read, null when the read failed. */
export function useLatestCliRelease(): string | null | undefined {
  const [latest, setLatest] = useState<string | null | undefined>(undefined);
  useMountEffect(() => {
    let live = true;
    void fetchLatest().then((v) => { if (live) setLatest(v); });
    return () => { live = false; };
  });
  return latest;
}

const RELEASE = /^\d+\.\d+\.\d+$/;

/** Whether a machine running `version` is behind `latest`. Unknown or non-release versions are not called behind. */
export function behindRelease(version: string | undefined, latest: string | null): boolean {
  return !!version && !!latest && RELEASE.test(version) && compareVersions(version, latest) < 0;
}

/** The highest release of those given, or null when none is one. A window's read of the manifest is kept for its life,
 *  so a device's own check can name a newer release than it: Update sends the newer, which a lower one would clear. */
export function newestRelease(...versions: Array<string | null | undefined>): string | null {
  return versions.filter((v): v is string => !!v && RELEASE.test(v)).reduce<string | null>((a, b) => (a && compareVersions(a, b) >= 0 ? a : b), null);
}
