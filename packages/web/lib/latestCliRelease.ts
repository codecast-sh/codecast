import { useEffect, useState } from "react";
import { compareVersions } from "@codecast/shared/contracts/orgTemplateManifest";

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
  useEffect(() => {
    let live = true;
    void fetchLatest().then((v) => { if (live) setLatest(v); });
    return () => { live = false; };
  }, []);
  return latest;
}

/** Whether a machine running `version` is behind `latest`. Unknown or non-release versions are not called behind. */
export function behindRelease(version: string | undefined, latest: string | null): boolean {
  const release = /^\d+\.\d+\.\d+$/;
  return !!version && !!latest && release.test(version) && compareVersions(version, latest) < 0;
}
