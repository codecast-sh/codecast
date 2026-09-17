import { createContext, useContext, useState, useCallback, useRef, useMemo } from "react";
import { Link2, LocateFixed } from "lucide-react";
import { toast } from "sonner";
import { useEventListener } from "../hooks/useEventListener";
import { createPortal } from "react-dom";
import { copyToClipboard } from "../lib/utils";

import { useWatchEffect } from "../hooks/useWatchEffect";

// One image the lightbox can show. `src` is whatever paints (may be a blob: or
// data: URL from the byte cache); `href` is the shareable address of the same
// bytes (the storage URL or the remote markdown URL) — absent when there is
// none, e.g. an inline base64 image. `messageId` is the transcript message the
// image came from, when the registrar knows it.
export type GalleryImage = { src: string; href?: string; messageId?: string };

type ImageGalleryContextType = {
  register: (image: GalleryImage) => void;
  open: (src: string) => void;
  // Open over an explicit list (the header's full-session gallery). register()
  // only sees images that have MOUNTED — the virtualized feed never mounts most
  // of them — so a whole-session open must carry its own list. Cleared on close.
  openList: (images: GalleryImage[], index: number) => void;
};

const ImageGalleryContext = createContext<ImageGalleryContextType | null>(null);

export function useImageGallery() {
  return useContext(ImageGalleryContext);
}

// The message a mounted image belongs to. The transcript row wraps each message
// in this scope once, so every image renderer under it (attachments, tool
// screenshots, markdown images, condensed thumbs) registers with the right id
// without threading a prop through every block in between.
const GalleryMessageContext = createContext<string | undefined>(undefined);

export function GalleryMessageScope({ messageId, children }: { messageId: string | undefined; children: React.ReactNode }) {
  return <GalleryMessageContext.Provider value={messageId}>{children}</GalleryMessageContext.Provider>;
}

export function useGalleryMessageId() {
  return useContext(GalleryMessageContext);
}

// Minimal standalone viewer for one image outside any provider (inbox row
// thumbnails): same dark overlay as the gallery, click or Esc to close.
export function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEventListener("keydown", useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
  }, [onClose]), document);
  return createPortal(
    <div
      className="fixed inset-0 z-[10001] flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.92)" }}
      onClick={e => { e.stopPropagation(); onClose(); }}
    >
      <button
        onClick={e => { e.stopPropagation(); onClose(); }}
        className="absolute top-4 right-4 text-white/50 hover:text-white p-2 transition-colors z-10"
        title="Close (Esc)"
      >
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
      <img
        src={src}
        alt="Image preview"
        className="max-w-[90vw] max-h-[90vh] object-contain rounded"
        onClick={e => e.stopPropagation()}
      />
    </div>,
    document.body
  );
}

// Mount-registered images, tagged with the conversation they were registered
// under. The provider outlives a conversation switch (the inbox keeps one
// ConversationView and swaps its data), so an untagged registry accumulated
// every session ever viewed and an inline click browsed all of them.
// One square hit box per control, icon centred: a bare <a> or an inline icon
// paints the glyph at the top left of a taller line box, so the hover target
// and the visible icon disagree.
const ACTION_CLASS = "inline-flex h-10 w-10 items-center justify-center rounded text-white/35 hover:text-white transition-colors";

type Registry = { conversationId: string | undefined; bySrc: Map<string, GalleryImage>; order: GalleryImage[] };
const emptyRegistry = (conversationId: string | undefined): Registry => ({ conversationId, bySrc: new Map(), order: [] });

export function ImageGalleryProvider({ conversationId, onJumpToMessage, children }: {
  // Scopes the mount registry to one conversation.
  conversationId?: string;
  // Scroll the transcript to a message (the host's own path, which can expand
  // a collapsed group and highlight the row). Called after the lightbox closes.
  onJumpToMessage?: (messageId: string) => void;
  children: React.ReactNode;
}) {
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [overrideList, setOverrideList] = useState<GalleryImage[] | null>(null);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const isOpen = currentIndex >= 0;
  const registry = useRef<Registry>(emptyRegistry(conversationId));
  // Read by register() from child effects, which run before this component's
  // own effects: assigning during render is what makes the first registration
  // after a switch land in the new conversation's registry, not the old one.
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  // The list the open lightbox navigates: an explicit session list wins over
  // the mount-registered order. Registered images from another conversation
  // (state not yet refreshed after a switch) are never shown.
  const registered = registry.current.conversationId === conversationId ? images : [];
  const list = overrideList ?? registered;
  const listRef = useRef(list);
  listRef.current = list;

  const register = useCallback((image: GalleryImage) => {
    if (registry.current.conversationId !== conversationIdRef.current) {
      registry.current = emptyRegistry(conversationIdRef.current);
    }
    const r = registry.current;
    const existing = r.bySrc.get(image.src);
    if (!existing) {
      r.bySrc.set(image.src, image);
      r.order.push(image);
    } else if ((image.href && !existing.href) || (image.messageId && !existing.messageId)) {
      // A later registrar knows more (e.g. the storage URL resolved): fold it in.
      const merged = { ...existing, ...image };
      r.bySrc.set(image.src, merged);
      r.order[r.order.indexOf(existing)] = merged;
    } else {
      return;
    }
    setImages([...r.order]);
  }, []);

  const open = useCallback((src: string) => {
    const idx = registry.current.order.findIndex((i) => i.src === src);
    if (idx >= 0) setCurrentIndex(idx);
  }, []);

  const openList = useCallback((list: GalleryImage[], index: number) => {
    if (list.length === 0) return;
    setOverrideList(list);
    setCurrentIndex(Math.max(0, Math.min(index, list.length - 1)));
  }, []);

  const close = useCallback(() => {
    setCurrentIndex(-1);
    setOverrideList(null);
  }, []);

  // A lightbox open over one conversation must not survive a switch to another.
  useWatchEffect(() => close(), [conversationId, close]);

  const goNext = useCallback(() => {
    setCurrentIndex(i => (i < listRef.current.length - 1 ? i + 1 : i));
  }, []);

  const goPrev = useCallback(() => {
    setCurrentIndex(i => (i > 0 ? i - 1 : i));
  }, []);

  useEventListener("keydown", useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); goNext(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); goPrev(); }
  }, [close, goNext, goPrev]), isOpen ? document : null);

  const ctx = useMemo(() => ({ register, open, openList }), [register, open, openList]);

  // Keep the active thumb visible as arrow keys / clicks move the selection.
  const activeThumbRef = useRef<HTMLButtonElement | null>(null);
  useWatchEffect(() => {
    if (isOpen) activeThumbRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [isOpen, currentIndex]);

  const current = isOpen ? list[currentIndex] : null;
  const currentSrc = current?.src ?? null;
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < list.length - 1;
  const count = list.length;

  const copyLink = useCallback((href: string) => {
    copyToClipboard(href).then(() => toast.success("Image link copied")).catch(() => toast.error("Failed to copy link"));
  }, []);
  const jumpToMessage = useCallback((messageId: string) => {
    close();
    onJumpToMessage?.(messageId);
  }, [close, onJumpToMessage]);

  return (
    <ImageGalleryContext.Provider value={ctx}>
      {children}
      {isOpen && currentSrc && createPortal(
        <div
          className="fixed inset-0 z-[10001] flex items-center justify-center"
          style={{ backgroundColor: "rgba(0,0,0,0.92)" }}
          onClick={close}
        >
          {/* Quiet action cluster: the image's own link and the way back to
              the message that produced it, faint until hovered like the
              arrows, sitting with the close button so the eye has one corner
              to check. Each shows only when it has somewhere to go. */}
          <div className="absolute top-4 right-4 flex items-center gap-0.5 z-10" onClick={e => e.stopPropagation()}>
            {current?.href && (
              <button
                onClick={() => copyLink(current.href!)}
                className={ACTION_CLASS}
                title="Copy link to image"
                aria-label="Copy link to image"
              >
                <Link2 className="w-4 h-4" strokeWidth={2} />
              </button>
            )}
            {current?.messageId && onJumpToMessage && (
              <button
                onClick={() => jumpToMessage(current.messageId!)}
                className={ACTION_CLASS}
                title="Locate in the conversation"
                aria-label="Locate in the conversation"
              >
                <LocateFixed className="w-4 h-4" strokeWidth={2} />
              </button>
            )}
            <button
              onClick={close}
              className={`${ACTION_CLASS} text-white/50`}
              title="Close (Esc)"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {count > 1 && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 text-white/40 text-xs font-mono tabular-nums">
              {currentIndex + 1} / {count}
            </div>
          )}

          {hasPrev && (
            <button
              onClick={e => { e.stopPropagation(); goPrev(); }}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20 hover:text-white/70 p-2 transition-colors"
              title="Previous"
            >
              <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}

          {hasNext && (
            <button
              onClick={e => { e.stopPropagation(); goNext(); }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-white/20 hover:text-white/70 p-2 transition-colors"
              title="Next"
            >
              <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}

          <img
            src={currentSrc}
            alt="Gallery image"
            className={`max-w-[90vw] object-contain rounded ${count > 1 ? "max-h-[82vh]" : "max-h-[90vh]"}`}
            onClick={e => e.stopPropagation()}
          />

          {count > 1 && (
            <div
              className="absolute bottom-3 left-1/2 -translate-x-1/2 max-w-[92vw] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center gap-1.5 px-1.5 py-1.5">
                {list.map(({ src }, i) => (
                  <button
                    key={src}
                    ref={i === currentIndex ? activeThumbRef : undefined}
                    onClick={() => setCurrentIndex(i)}
                    className={`shrink-0 rounded-md overflow-hidden transition-all duration-150 ${
                      i === currentIndex
                        ? "ring-1 ring-white/80 opacity-100"
                        : "opacity-40 hover:opacity-75"
                    }`}
                    title={`Image ${i + 1}`}
                  >
                    <img src={src} alt="" className="h-9 w-9 object-cover" draggable={false} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>,
        document.body
      )}
    </ImageGalleryContext.Provider>
  );
}
