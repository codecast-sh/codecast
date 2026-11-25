// An installed app's icon: the page's declared PNG or the server's monogram
// tile (both already carry their own rounded shape and transparent corners),
// and the initial on a quiet tile while it loads or when it fails.
import { useState } from "react";

export function AppIcon({ src, name, size }: { src: string | null | undefined; name: string; size: number }) {
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size };
  if (!src || failed) {
    return (
      <span
        aria-hidden
        style={{ ...box, fontSize: Math.round(size * 0.45), borderRadius: Math.round(size * 0.22) }}
        className="inline-flex shrink-0 select-none items-center justify-center bg-sol-bg-alt font-semibold text-sol-text-muted ring-1 ring-inset ring-sol-border"
        data-app-icon="fallback"
      >
        {(name.trim()[0] ?? "?").toUpperCase()}
      </span>
    );
  }
  return <img src={src} alt="" style={box} className="shrink-0 object-contain" draggable={false} onError={() => setFailed(true)} data-app-icon />;
}
