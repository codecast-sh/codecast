"use client";
import { createContext, useContext, useState, useCallback, useRef, useMemo } from "react";
import { useEventListener } from "../hooks/useEventListener";
import { createPortal } from "react-dom";

type ImageGalleryContextType = {
  register: (src: string) => void;
  open: (src: string) => void;
};

const ImageGalleryContext = createContext<ImageGalleryContextType | null>(null);

export function useImageGallery() {
  return useContext(ImageGalleryContext);
}

export function ImageGalleryProvider({ children }: { children: React.ReactNode }) {
  const [images, setImages] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const isOpen = currentIndex >= 0;
  const imageSet = useRef(new Set<string>());
  const imageOrder = useRef<string[]>([]);

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

  const close = useCallback(() => setCurrentIndex(-1), []);

  const goNext = useCallback(() => {
    setCurrentIndex(i => {
      const len = imageOrder.current.length;
      return i < len - 1 ? i + 1 : i;
    });
  }, []);

  const goPrev = useCallback(() => {
    setCurrentIndex(i => (i > 0 ? i - 1 : i));
  }, []);

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!isOpen) return;
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); goNext(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); goPrev(); }
  }, document);

  const ctx = useMemo(() => ({ register, open }), [register, open]);

  const currentSrc = isOpen ? images[currentIndex] : null;
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < images.length - 1;
  const count = images.length;

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
            className="max-w-[90vw] max-h-[90vh] object-contain rounded"
            onClick={e => e.stopPropagation()}
          />
        </div>,
        document.body
      )}
    </ImageGalleryContext.Provider>
  );
}
