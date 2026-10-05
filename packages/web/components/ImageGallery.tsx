import { createContext, useContext, useState, useCallback, useRef, useMemo } from "react";
import { Link2, LocateFixed, MessageSquarePlus, X } from "lucide-react";
import { toast } from "sonner";
import { useEventListener } from "../hooks/useEventListener";
import { createPortal } from "react-dom";
import { copyToClipboard } from "../lib/utils";
import { useInboxStore } from "../store/inboxStore";
import { addImagePin } from "../lib/reviewActions";
import { pinNumbers, type PendingComment } from "../lib/quoteFormat";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { CommentEditor } from "./MessageReview";
import { useCurrentUser } from "../hooks/useCurrentUser";

import { useWatchEffect } from "../hooks/useWatchEffect";
import { usePanZoom } from "../hooks/usePanZoom";

// One image the lightbox can show. `src` is whatever paints (may be a blob: or
// data: URL from the byte cache); `href` is the shareable address of the same
// bytes (the storage URL or the remote markdown URL) — absent when there is
// none, e.g. an inline base64 image. `messageId` is the transcript message the
// image came from, when the registrar knows it. `storageId` names the stored
// bytes (so a quote can attach the picture itself) and `timestamp` when it
// landed, both when known.
export type GalleryImage = { src: string; href?: string; messageId?: string; storageId?: string; timestamp?: number };

type ImageGalleryContextType = {
  register: (image: GalleryImage) => void;
  open: (src: string) => void;
  // Open over an explicit list (the header's full-session gallery). register()
  // only sees images that have MOUNTED — the virtualized feed never mounts most
  // of them — so a whole-session open must carry its own list. Cleared on close.
  openList: (images: GalleryImage[], index: number) => void;
  // The conversation whose quote batch notes pinned in this transcript join,
  // when the viewer can reply here. Framed pages read it to take notes too.
  quoteTo?: string;
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
  const zoom = usePanZoom(src);
  useEventListener("keydown", useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === "0") { e.preventDefault(); e.stopPropagation(); zoom.reset(); }
  }, [onClose, zoom.reset]), document);
  return createPortal(
    <div
      ref={zoom.surfaceRef}
      className="fixed inset-0 z-[10001] flex items-center justify-center overflow-hidden"
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
        {...zoom.imageProps}
      />
      <ZoomBadge scale={zoom.scale} />
    </div>,
    document.body
  );
}

// Zoom level while zoomed in, with the way back. Hidden at 100%: the gesture
// is discoverable from the trackpad, and an idle viewer stays quiet.
function ZoomBadge({ scale }: { scale: number }) {
  if (scale <= 1) return null;
  return (
    <div className="pointer-events-none absolute bottom-16 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 rounded bg-black/70 px-2 py-1 text-[11px] font-mono tabular-nums text-white/60">
      {Math.round(scale * 100)}%
      <span className="text-white/30">·</span>
      <KeyCap size="xs">0</KeyCap> reset
    </div>
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

export function ImageGalleryProvider({ conversationId, onJumpToMessage, quotable = false, children }: {
  // Scopes the mount registry to one conversation.
  conversationId?: string;
  // The viewer can reply here: clicking a point of an image pins a note there,
  // into the conversation's quote batch, the same one paragraph quotes build up.
  quotable?: boolean;
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
    } else if ((image.href && !existing.href) || (image.messageId && !existing.messageId) || (image.storageId && !existing.storageId)) {
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
    // A pin's note editor lives in the lightbox; don't leave it "open" behind.
    const s = useInboxStore.getState();
    if (conversationIdRef.current && s.reviewComments[conversationIdRef.current]?.some((c) => c.id === s.reviewEditingId && c.image)) {
      s.setReviewEditingId(null);
    }
  }, []);

  // A lightbox open over one conversation must not survive a switch to another.
  useWatchEffect(() => close(), [conversationId, close]);

  const goNext = useCallback(() => {
    setCurrentIndex(i => (i < listRef.current.length - 1 ? i + 1 : i));
  }, []);

  const goPrev = useCallback(() => {
    setCurrentIndex(i => (i > 0 ? i - 1 : i));
  }, []);

  // Notes pinned to points of the gallery's images, from the quote batch. A
  // signature of the pin fields keeps the lightbox from re-rendering on every
  // unrelated batch write.
  const canPin = quotable && !!conversationId;
  const pinsSig = useInboxStore((s) => {
    if (!canPin) return "";
    return JSON.stringify((s.reviewComments[conversationId!] ?? []).filter((c) => c.image?.point).map((c) => [c.id, c.image!.src, c.image!.point, c.body]));
  });
  const { pinsBySrc, pinNumber } = useMemo(() => {
    const by = new Map<string, PendingComment[]>();
    if (!pinsSig) return { pinsBySrc: by, pinNumber: new Map<string, number>() };
    const comments = useInboxStore.getState().reviewComments[conversationId!] ?? [];
    for (const c of comments) {
      if (!c.image?.point) continue;
      by.set(c.image.src, [...(by.get(c.image.src) ?? []), c]);
    }
    return { pinsBySrc: by, pinNumber: pinNumbers(comments) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinsSig]);
  const pinCount = useMemo(() => [...pinsBySrc.values()].reduce((n, l) => n + l.length, 0), [pinsBySrc]);
  const editingId = useInboxStore((s) => s.reviewEditingId);
  const { user: author } = useCurrentUser();
  const zoom = usePanZoom(isOpen ? listRef.current[currentIndex]?.src : null);

  useEventListener("keydown", useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); goNext(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); goPrev(); }
    else if (e.key === "0") { e.preventDefault(); e.stopPropagation(); zoom.reset(); }
  }, [close, goNext, goPrev, zoom.reset]), isOpen ? document : null);

  const quoteTo = canPin ? conversationId : undefined;
  const ctx = useMemo(() => ({ register, open, openList, quoteTo }), [register, open, openList, quoteTo]);

  // Keep the active thumb visible as arrow keys / clicks move the selection.
  const activeThumbRef = useRef<HTMLButtonElement | null>(null);
  useWatchEffect(() => {
    if (isOpen) activeThumbRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [isOpen, currentIndex]);

  const current = isOpen ? list[currentIndex] : null;
  const currentPins = current ? pinsBySrc.get(current.src) ?? [] : [];
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

  // A click on the picture pins a note at that point. The point is measured
  // against the picture's on-screen box, which already includes any zoom, and
  // kept as fractions so it maps onto the file the agent receives.
  const pinAt = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    if (!canPin || !current) return;
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    // A click while a pin on this picture still has no note moves that pin:
    // the first click missed, it was not a second remark.
    const store = useInboxStore.getState();
    const unwritten = (store.reviewComments[conversationId!] ?? [])
      .find((c) => c.id === store.reviewEditingId && c.image?.src === current.src && !c.body.trim());
    if (unwritten) store.removeReviewComment(conversationId!, unwritten.id);
    addImagePin(
      conversationId!,
      { ...current, width: img.naturalWidth || undefined, height: img.naturalHeight || undefined },
      { x: clamp((e.clientX - rect.left) / rect.width), y: clamp((e.clientY - rect.top) / rect.height) },
    );
  }, [canPin, current, conversationId]);

  return (
    <ImageGalleryContext.Provider value={ctx}>
      {children}
      {isOpen && currentSrc && createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Image gallery"
          ref={zoom.surfaceRef}
          className="fixed inset-0 z-[10001] flex items-center justify-center overflow-hidden"
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

          {(count > 1 || pinCount > 0) && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-3 text-white/40 text-xs font-mono tabular-nums">
              {count > 1 && <span>{currentIndex + 1} / {count}</span>}
              {pinCount > 0 && <span className="text-sol-yellow/80">{pinCount} {pinCount === 1 ? "note" : "notes"} on your next message</span>}
            </div>
          )}

          {hasPrev && (
            <button
              onClick={e => { e.stopPropagation(); goPrev(); }}
              className="absolute left-3 top-1/2 -translate-y-1/2 z-10 text-white/20 hover:text-white/70 p-2 transition-colors"
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
              className="absolute right-3 top-1/2 -translate-y-1/2 z-10 text-white/20 hover:text-white/70 p-2 transition-colors"
              title="Next"
            >
              <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}

          {/* Clicking a point of the picture pins a note there. The zoom
              transform sits on the box around the picture so the pins ride
              along with it; each pin undoes the scale to keep its size. */}
          <div className="relative flex flex-col items-center" onClick={e => e.stopPropagation()}>
            <div className="relative" {...zoom.imageProps}>
              <img
                src={currentSrc}
                alt="Gallery image"
                draggable={false}
                className={`block max-w-[90vw] object-contain rounded ${count > 1 ? "max-h-[78vh]" : "max-h-[86vh]"} ${
                  canPin && !zoom.zoomed ? "cursor-crosshair" : ""}`}
                onClick={pinAt}
              />
              {currentPins.map((c) => (
                <ImagePin
                  key={c.id}
                  conversationId={conversationId!}
                  comment={c}
                  number={pinNumber.get(c.id) ?? 0}
                  scale={zoom.scale}
                  editing={editingId === c.id}
                  author={author}
                />
              ))}
            </div>
            {canPin && !zoom.zoomed && (
              <div className="mt-2 flex items-center gap-1.5 text-[11px] font-mono text-white/35">
                <MessageSquarePlus className="h-3 w-3" strokeWidth={2} />
                click anywhere on the image to pin a note for the agent
              </div>
            )}
          </div>

          <ZoomBadge scale={zoom.scale} />

          {count > 1 && (
            <div
              className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 max-w-[92vw] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center gap-1.5 px-1.5 py-1.5">
                {list.map(({ src }, i) => (
                  <button
                    key={src}
                    ref={i === currentIndex ? activeThumbRef : undefined}
                    onClick={() => setCurrentIndex(i)}
                    className={`relative shrink-0 rounded-md overflow-hidden transition-all duration-150 ${
                      i === currentIndex
                        ? "ring-1 ring-white/80 opacity-100"
                        : pinsBySrc.has(src) ? "ring-1 ring-sol-yellow/70 opacity-80 hover:opacity-100" : "opacity-40 hover:opacity-75"
                    }`}
                    title={pinsBySrc.has(src) ? `Image ${i + 1} (${pinsBySrc.get(src)!.length} notes)` : `Image ${i + 1}`}
                  >
                    <img src={src} alt="" className="h-9 w-9 object-cover" draggable={false} />
                    {pinsBySrc.has(src) && (
                      <span className="absolute bottom-0 right-0 flex h-3.5 min-w-3.5 items-center justify-center rounded-tl bg-sol-yellow px-0.5 text-[9px] font-bold leading-none text-black">
                        {pinsBySrc.get(src)!.length}
                      </span>
                    )}
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

// One note pinned to a point of the picture: a numbered dot, and the note
// editor beside it while it is being written. Clicking the dot reopens the
// note; the editor's corner button takes the pin away. The editor opens
// toward the middle of the picture so it stays on screen near any edge.
function ImagePin({ conversationId, comment, number, scale, editing, author }: {
  conversationId: string;
  comment: PendingComment;
  number: number;
  scale: number;
  editing: boolean;
  author: unknown;
}) {
  const { x, y } = comment.image!.point!;
  const store = useInboxStore.getState;
  return (
    <div
      className="absolute z-10"
      style={{ left: `${x * 100}%`, top: `${y * 100}%`, transform: `scale(${1 / scale})`, transformOrigin: "0 0" }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={`absolute -left-3 -top-3 flex h-6 w-6 items-center justify-center rounded-full border-2 bg-sol-yellow text-[11px] font-bold text-black shadow-[0_0_0_2px_rgba(0,0,0,0.45)] transition-transform hover:scale-110 ${
          editing ? "border-white" : "border-black/60"}`}
        title={comment.body || "Pinned note (click to edit)"}
        aria-label={`Note ${number}${comment.body ? `: ${comment.body}` : ""}`}
        onClick={() => store().setReviewEditingId(editing ? null : comment.id)}
      >
        {number}
      </button>
      {!editing && comment.body && (
        <div className="pointer-events-none absolute left-4 -top-2.5 max-w-[16rem] truncate rounded bg-black/75 px-1.5 py-0.5 text-[11px] text-white/85">
          {comment.body}
        </div>
      )}
      {editing && (
        <div
          className="absolute w-72 rounded-md border border-sol-border bg-sol-bg p-2 shadow-xl"
          style={{
            ...(x > 0.6 ? { right: "1rem" } : { left: "1rem" }),
            ...(y > 0.6 ? { bottom: "0.5rem" } : { top: "-0.5rem" }),
          }}
        >
          <div className="mb-1 flex items-center justify-between text-[10px] font-mono text-sol-text-dim">
            <span>Note {number} on this point</span>
            <button
              type="button"
              className="rounded p-0.5 hover:text-sol-red"
              title="Remove this pin"
              aria-label="Remove this pin"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => store().removeReviewComment(conversationId, comment.id)}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <CommentEditor conversationId={conversationId} comment={comment} author={author} onDone={() => {}} />
        </div>
      )}
    </div>
  );
}
