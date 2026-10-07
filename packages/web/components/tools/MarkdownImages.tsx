import type { Components } from "react-markdown";
import { useState, useCallback, Children } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useImageGallery, useGalleryMessageId } from "../ImageGallery";
import { isRemoteImageSrc } from "../../lib/trustedImageOrigins";

const MD_IMAGE_COLLAPSED_HEIGHT = 160;
// Width over height at which an unhinted image leaves the narrow default and
// takes the column: a strip (a top bar, a timeline) is unreadable at 448px.
const WIDE_ASPECT = 2;

/** How an author asked an image to render, through the markdown title slot:
 *  `![caption](url "wide")`. `wide` takes the column and shows the whole image,
 *  `small` is a thumbnail, anything else is auto (narrow, collapsed past
 *  MD_IMAGE_COLLAPSED_HEIGHT, widened for strips). */
type ImageSize = "auto" | "wide" | "small";

function imageSizeFromTitle(title?: string | null): ImageSize {
  const hint = title?.trim().toLowerCase();
  if (hint === "wide" || hint === "full") return "wide";
  if (hint === "small") return "small";
  return "auto";
}

/** Alt text worth showing under the image. `cast image` defaults alt to the
 *  file name, which reads as a real caption; the generic fallbacks don't. */
function captionFromAlt(alt?: string): string | undefined {
  const trimmed = alt?.trim();
  if (!trimmed || /^(image|img)$/i.test(trimmed)) return undefined;
  return trimmed;
}

export function CollapsibleImage({
  src: rawSrc,
  alt,
  title,
  trusted = false,
}: {
  src?: string | Blob;
  alt?: string;
  /** The markdown title, read as a size hint (imageSizeFromTitle). */
  title?: string;
  /** The caller already knows this image is not a third party — a vault asset
   *  resolved to the local daemon's own file endpoint, say. The gate exists to
   *  stop a note auto-fetching from someone else's server; a file the vault is
   *  itself serving is not that, and gating it just hides the user's own
   *  images behind a click. Callers must not set this for anything a note
   *  author could point at an arbitrary host. */
  trusted?: boolean;
}) {
  const src = typeof rawSrc === 'string' ? rawSrc : undefined;
  // Natural width over height, known once the bytes arrive.
  const [aspect, setAspect] = useState<number | null>(null);
  const [clipped, setClipped] = useState(false);
  const loaded = aspect !== null;
  const [errored, setErrored] = useState(false);
  // User opt-in for a remote image: nothing hits the network until the click.
  const [revealed, setRevealed] = useState(false);
  const gallery = useImageGallery();
  const messageId = useGalleryMessageId();

  // A remote http(s) image that the viewer hasn't opted into. Until then we
  // render neither the <img> nor a gallery registration, so the browser issues
  // no request for it (the auto-fetch exfiltration channel stays closed).
  const blocked = !!src && !revealed && !trusted && isRemoteImageSrc(src);

  useWatchEffect(() => {
    if (src && gallery && !blocked) gallery.register({ src, href: src, messageId });
  }, [src, messageId, gallery, blocked]);

  if (!src || errored) return null;

  if (blocked) {
    return (
      <span
        className="my-2 flex max-w-md flex-col gap-1.5 rounded-lg border border-dashed border-[color-mix(in_srgb,var(--sol-border)_50%,transparent)] bg-sol-bg-alt p-3 text-xs"
        onClick={(e) => { e.stopPropagation(); setRevealed(true); }}
        role="button"
        tabIndex={0}
        title="This image is served from a third party. Loading it would let that server see your IP and the click. Only load it if you trust the source."
      >
        <span className="font-medium text-sol-text-muted">Remote image not loaded</span>
        <span className="break-all text-sol-text-dim">{src}</span>
        <span className="text-sol-blue">Click to load image</span>
      </span>
    );
  }

  const caption = captionFromAlt(alt);
  const size = imageSizeFromTitle(title);
  const fullWidth = size === "wide" || (size === "auto" && aspect !== null && aspect >= WIDE_ASPECT);
  // The frame hugs the image up to the cap, so a short image gets no dead
  // space under it and the fade appears only over a cut-off bottom.
  const cap = size === "wide" ? undefined : MD_IMAGE_COLLAPSED_HEIGHT;
  return (
    <span
      className={`my-2 block cursor-pointer ${size === "small" ? "max-w-60" : fullWidth ? "max-w-full" : "max-w-md"}`}
      onClick={() => gallery?.open(src)}
    >
      {/* Soft borders need explicit color-mix values: Tailwind's /opacity
          modifier is a silent no-op on the bare --sol-* var tokens. */}
      <span
        className="relative block overflow-hidden rounded-lg border border-[color-mix(in_srgb,var(--sol-border)_35%,transparent)] hover:border-[color-mix(in_srgb,var(--sol-blue)_40%,transparent)] transition-colors"
        style={loaded ? { maxHeight: cap } : { height: MD_IMAGE_COLLAPSED_HEIGHT }}
      >
        {!loaded && (
          <span className="absolute inset-0 bg-sol-bg-alt flex items-center justify-center z-10">
            <span className="text-sol-text-dim text-xs">Loading image...</span>
          </span>
        )}
        <img
          src={src}
          alt={alt || "Image"}
          className="block w-full h-auto"
          style={loaded ? undefined : { width: 0, height: 0, overflow: 'hidden', position: 'absolute' }}
          onLoad={(e) => {
            const img = e.currentTarget;
            setAspect(img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1);
          }}
          onError={() => setErrored(true)}
        />
        {/* Measured from the rendered box, so a column resize re-decides it. */}
        {loaded && cap !== undefined && <ClipProbe cap={cap} onChange={setClipped} />}
        {clipped && cap !== undefined && (
          <span
            className="absolute inset-x-0 bottom-0 h-16 pointer-events-none block"
            style={{ background: 'linear-gradient(to bottom, transparent, var(--image-fade-bg, var(--sol-bg, #0a0a0a)))' }}
          />
        )}
      </span>
      {caption && (
        <span className="block mt-1 text-[11px] leading-snug text-sol-text-muted">{caption}</span>
      )}
    </span>
  );
}

/** Reports whether the image in its frame runs past the cap. Lives inside the
 *  frame so it can watch the image beside it without a ref on the frame. */
function ClipProbe({ cap, onChange }: { cap: number; onChange: (clipped: boolean) => void }) {
  const watch = useCallback((probe: HTMLSpanElement | null) => {
    const img = probe?.previousElementSibling;
    if (!(img instanceof HTMLImageElement)) return;
    const measure = () => onChange(img.getBoundingClientRect().height > cap + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(img);
    return () => observer.disconnect();
  }, [cap, onChange]);
  return <span hidden ref={watch} />;
}

/** The `img` override every markdown surface shares. It forwards only what
 *  markdown can state, so a node prop can never switch on `trusted`. */
export function MarkdownImg({ src, alt, title }: { src?: string | Blob; alt?: string; title?: string }) {
  return <CollapsibleImage src={src} alt={alt} title={title} />;
}

// A paragraph that is exclusively images (plus whitespace/line breaks) renders
// as a side-by-side grid instead of stacked full-width blocks, so
// `![before](u1) ![after](u2)` reads as a comparison row. Children arrive
// already rendered through the active component map's `img` (CollapsibleImage
// here, VaultImage in the vault), so per-surface image behavior — click gates,
// vault path resolution, gallery registration — is untouched.
function countImageOnlyChildren(node: { children?: Array<{ type?: string; tagName?: string; value?: string }> } | undefined): number {
  let count = 0;
  for (const child of node?.children ?? []) {
    if (child.type === 'element' && child.tagName === 'img') count++;
    else if (child.type === 'text' && !child.value?.trim()) continue;
    else if (child.type === 'element' && child.tagName === 'br') continue;
    else return 0;
  }
  return count;
}

export const ImageRowParagraph: Components['p'] = ({ node, children, ...props }) => {
  const imageCount = countImageOnlyChildren(node);
  if (imageCount >= 2) {
    // Whitespace text nodes between the markdown images would become empty
    // grid cells — keep only the rendered elements.
    const items = Children.toArray(children).filter((c) => typeof c !== 'string' || c.trim() !== '');
    return (
      <span
        className="my-2 grid gap-x-2"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(200px, 1fr))`, maxWidth: imageCount === 2 ? 560 : undefined }}
      >
        {items}
      </span>
    );
  }
  return <p {...props}>{children}</p>;
};

