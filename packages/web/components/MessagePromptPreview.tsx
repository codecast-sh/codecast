import { useMemo, useState, type MouseEventHandler, type Ref } from "react";
import { Image as ImageIcon } from "lucide-react";
import { useStorageImageUrls } from "../hooks/useStorageImageUrl";
import { messagePreview, type PromptImage } from "../lib/messagePreview";
import { isRemoteImageSrc } from "../lib/trustedImageOrigins";
import { ImageLightbox, useImageGallery } from "./ImageGallery";

export function MessagePromptPreview({
  content, images, variant = "row", textClassName = "", textRef, onTextClick,
}: {
  content: string;
  images?: PromptImage[];
  variant?: "row" | "sticky" | "preview";
  textClassName?: string;
  textRef?: Ref<HTMLDivElement>;
  onTextClick?: MouseEventHandler<HTMLDivElement>;
}) {
  const preview = useMemo(() => messagePreview(content, images, src => !isRemoteImageSrc(src)), [content, images]);
  const urls = useStorageImageUrls(preview.images.map(image => image.storage_id));
  const gallery = useImageGallery();
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const srcs = preview.images.map(image => image.storage_id ? urls[image.storage_id] : image.src);
  const limit = variant === "preview" ? 4 : 2;
  const visible = preview.images.slice(0, limit);

  return (
    <div data-prompt-preview={variant} className={`min-w-0 ${variant === "preview" ? "flex flex-col gap-2.5" : "flex items-start gap-2.5"}`}>
      {(preview.text || visible.length === 0) && (
        <div ref={textRef} className={`min-w-0 flex-1 break-words ${textClassName}`} onClick={onTextClick}>
          {preview.text}
        </div>
      )}
      {visible.length > 0 && (
        <div className={`flex shrink-0 gap-1.5 ${variant === "preview" ? "w-full" : ""}`}>
          {visible.map((image, index) => {
            const src = srcs[index];
            const unavailable = src === null || (!!src && failed.has(src));
            const remaining = index === limit - 1 ? preview.images.length - limit : 0;
            return (
              <button
                key={image.key}
                type="button"
                aria-label={unavailable ? `Image ${index + 1} unavailable` : `Open image ${index + 1}${remaining > 0 ? ` and ${remaining} more` : ""}`}
                title={unavailable ? "Image unavailable" : src ? "Open image" : "Loading image"}
                aria-disabled={!src || unavailable}
                className={`relative overflow-hidden rounded border border-sol-border/50 bg-sol-bg-alt text-sol-text-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-cyan active:scale-[0.97] ${src && !unavailable ? "cursor-zoom-in hover:border-sol-cyan/70" : "cursor-default"} ${variant === "preview" ? "h-24 min-w-0 flex-1" : variant === "sticky" ? "h-12 w-12" : "h-10 w-10"}`}
                onKeyDown={e => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); }}
                onClick={e => {
                  e.stopPropagation();
                  if (!src || unavailable) return;
                  const available = [...new Set(srcs.filter((value): value is string => !!value && !failed.has(value)))];
                  if (gallery) gallery.openList(available, available.indexOf(src));
                  else setLightbox(src);
                }}
              >
                {src && !unavailable ? (
                  <img
                    src={src}
                    alt={`Image ${index + 1}`}
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover object-top"
                    onError={() => setFailed(previous => new Set(previous).add(src))}
                  />
                ) : <ImageIcon className="mx-auto h-4 w-4 opacity-50" aria-hidden />}
                {remaining > 0 && <span className="absolute inset-0 flex items-center justify-center bg-sol-bg/80 text-xs font-medium text-sol-text">+{remaining}</span>}
              </button>
            );
          })}
        </div>
      )}
      {lightbox && <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}
