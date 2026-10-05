// What a running mod printed and threw, newest last: the same lines
// `cast mod logs` reads, from this window's runtime.

import { useEffect, useState } from "react";
import type { ModRuntime } from "../../lib/mods/host";

export function ModLogList({ runtime }: { runtime: ModRuntime | undefined }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const logs = runtime?.logs ?? [];
  if (!logs.length) return <div className="px-1 py-2 text-[12px] text-sol-text-dim">Nothing logged yet. console.log in the mod lands here and in <span className="font-mono">cast mod logs</span>.</div>;
  return (
    <ol className="space-y-1 font-mono text-[11.5px]">
      {logs.slice(-150).map((l, i) => (
        <li key={i} className="flex gap-2 rounded px-1 py-0.5" style={{ background: l.level === "error" ? "color-mix(in srgb, var(--sol-red) 8%, transparent)" : undefined }}>
          <span className="shrink-0 text-sol-text-dim tabular-nums">{new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
          <span className={`min-w-0 whitespace-pre-wrap break-words ${l.level === "error" ? "text-sol-red" : l.level === "warn" ? "text-sol-yellow" : "text-sol-text-muted"}`}>{l.text}</span>
        </li>
      ))}
    </ol>
  );
}
