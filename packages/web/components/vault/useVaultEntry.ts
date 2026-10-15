import { useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useVaultStore } from "../../store/vaultStore";

/**
 * Whether a reader has a file to show. The file list is a scan that can lag
 * the disk (a cached copy, a missed watch event, the entry cap), so a path it
 * lacks is "asking" until the daemon has been asked, and "missing" only once
 * the daemon says so or cannot be reached.
 */
export function useVaultEntryState(path: string): "present" | "asking" | "missing" {
  const exists = useVaultStore((s) => !!s.files[path]);
  const endpoint = useVaultStore((s) => s.endpoint);
  const [asked, setAsked] = useState<string | null>(null);

  useWatchEffect(() => {
    if (exists || !endpoint) return;
    let cancelled = false;
    void useVaultStore.getState().ensureEntry(path).then(() => {
      if (!cancelled) setAsked(path);
    });
    return () => { cancelled = true; };
  }, [path, exists, endpoint]);

  if (exists) return "present";
  return endpoint && asked !== path ? "asking" : "missing";
}
