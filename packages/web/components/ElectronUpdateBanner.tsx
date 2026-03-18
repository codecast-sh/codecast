"use client";

import { useState } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { isElectron, getAppVersion } from "../lib/desktop";

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

export function ElectronUpdateBanner() {
  const [updateInfo, setUpdateInfo] = useState<{ downloadUrl: string; latest: string; current: string } | null>(null);

  useMountEffect(() => {
    if (!isElectron()) return;
    let cancelled = false;

    async function check() {
      try {
        const current = await getAppVersion();
        if (!current || cancelled) return;
        const res = await fetch("/api/desktop/version");
        if (!res.ok || cancelled) return;
        const { version: latest, downloadUrl } = await res.json();
        if (compareVersions(current, latest) < 0) {
          setUpdateInfo({ downloadUrl, latest, current });
        }
      } catch {}
    }

    check();
    const interval = setInterval(check, 60 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  });

  if (!updateInfo) return null;

  return (
    <div className="bg-sol-red/15 border-b border-sol-red/40 px-4 py-2.5 flex items-center justify-between gap-4 z-[100]">
      <span className="text-sm text-sol-text">
        Update available: <span className="font-mono text-sol-red">{updateInfo.current}</span>
        {" -> "}
        <span className="font-mono text-sol-green">{updateInfo.latest}</span>
      </span>
      <a
        href={updateInfo.downloadUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="px-3 py-1 text-xs font-medium bg-sol-red/20 hover:bg-sol-red/30 text-sol-red rounded transition-colors flex-shrink-0"
      >
        Download update
      </a>
    </div>
  );
}
