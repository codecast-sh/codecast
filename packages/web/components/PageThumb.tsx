"use client";
// The thumbnail of a published page, wherever one is shown. The capture
// `cast publish` took comes first; a page without one (markdown, a failed
// headless capture, a watch republish) frames the live page in preview mode,
// laid out at the capture's 1200x630 and scaled to fit. Only a gated page,
// whose content stays behind its gate, falls back to a glyph.

import { useRef, useState } from "react";
import { useDerivedSize } from "../hooks/useDerivedSize";
import { pagePreviewSrc, pageThumbUrl } from "../lib/publishedPageUrls";

const CAPTURE_W = 1200;
const CAPTURE_H = 630;

export function PageThumb({
  slug,
  version,
  hasThumb,
  gated,
  title,
  fallback,
}: {
  slug: string;
  version: number;
  /** undefined = unknown: try the capture and fall through if it 404s. */
  hasThumb?: boolean;
  gated?: boolean;
  title?: string;
  fallback: React.ReactNode;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  if (gated) return <>{fallback}</>;
  if (hasThumb !== false && !thumbFailed) {
    return (
      <img
        src={pageThumbUrl(slug, version)}
        alt={title ?? ""}
        loading="lazy"
        onError={() => setThumbFailed(true)}
        className="w-full h-full object-cover object-top"
      />
    );
  }
  return <LivePreview slug={slug} version={version} title={title} />;
}

function LivePreview({ slug, version, title }: { slug: string; version: number; title?: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const scale = useDerivedSize(boxRef, (w) => (w > 0 ? w / CAPTURE_W : 0), () => 0);
  return (
    <div ref={boxRef} className="relative w-full h-full overflow-hidden bg-white pointer-events-none">
      {scale > 0 && (
        <iframe
          src={pagePreviewSrc(slug, version)}
          title={title ?? "Page preview"}
          loading="lazy"
          tabIndex={-1}
          aria-hidden
          sandbox="allow-scripts"
          scrolling="no"
          className="absolute top-0 left-0 border-0 origin-top-left"
          style={{ width: CAPTURE_W, height: CAPTURE_H, transform: `scale(${scale})` }}
        />
      )}
    </div>
  );
}
