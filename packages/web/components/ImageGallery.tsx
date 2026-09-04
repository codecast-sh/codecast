import { createContext, useContext, useState, useCallback, useRef, useMemo } from "react";
import { useEventListener } from "../hooks/useEventListener";
import { createPortal } from "react-dom";

import { useWatchEffect } from "../hooks/useWatchEffect";
type ImageGalleryContextType = {
  register: (src: string) => void;
  open: (src: string) => void;
  // Open over an explicit list (the header's full-session gallery). register()
  // only sees images that have MOUNTED — the virtualized feed never mounts most
  // of them — so a whole-session open must carry its own list. Cleared on close.
  openList: (srcs: string[], index: number) => void;
};

const ImageGalleryContext = createContext<ImageGalleryContextType | null>(null);

export function useImageGallery() {
  return useContext(ImageGalleryContext);
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

export function ImageGalleryProvider({ children }: { children: React.ReactNode }) {
  const [images, setImages] = useState<string[]>([]);
  const [overrideList, setOverrideList] = useState<string[] | null>(null);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const isOpen = currentIndex >= 0;
  const imageSet = useRef(new Set<string>());
  const imageOrder = useRef<string[]>([]);

  // The list the open lightbox navigates: an explicit session list wins over
  // the mount-registered order.
  const list = overrideList ?? images;
  const listRef = useRef(list);
  listRef.current = list;

  const register = useCallback((src: string) => {
    if (!imageSet.current.has(src)) {
      imageSet.current.add(src);
      imageOrder.current.push(src);
      setImages([...imageOrder.current]);
    }
  }, []);

  const open = useCallback((src: string) => {
    const idx = imageOrder.current.indexOf(src);
    if (idx >= 0) setCurrentIndex(idx);
  }, []);

  const openList = useCallback((srcs: string[], index: number) => {
    if (srcs.length === 0) return;
    setOverrideList(srcs);
    setCurrentIndex(Math.max(0, Math.min(index, srcs.length - 1)));
  }, []);

  const close = useCallback(() => {
    setCurrentIndex(-1);
    setOverrideList(null);
  }, []);

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

  const currentSrc = isOpen ? list[currentIndex] : null;
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < list.length - 1;
  const count = list.length;

  return (
    <ImageGalleryContext.Provider value={ctx}>
      {children}
      {isOpen && currentSrc && createPortal(
        <div
          className="fixed inset-0 z-[10001] flex items-center justify-center"
          style={{ backgroundColor: "rgba(0,0,0,0.92)" }}
          onClick={close}
        >
          <button
            onClick={close}
            className="absolute top-4 right-4 text-white/50 hover:text-white p-2 transition-colors z-10"
            title="Close (Esc)"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

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
                {list.map((src, i) => (
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
