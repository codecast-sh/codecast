// A gallery card's picture (DESIGN 6.1). Every app is laid out as an 800x800
// page and scaled to cover the tile from its top left corner (cut at the
// foot of a wide tile, at the right of a tall one, where a page's title
// rarely is), so each reads at a legible size and its still and its live
// preview line up exactly. The
// still shows at once; the live app (PreviewFrame, real data, no writes)
// takes over only while the card is hovered, has people in it, or has no
// still yet, and then only in a few slots at a time: each preview is a whole
// app with its own connection. A preview of a version with no still
// pictures it for everyone after.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Id } from "../../convex/_generated/dataModel";
import { STILL_VIEWPORT } from "../../convex/lib/limits";
import { Blob } from "../ui/Blob";
import { PreviewFrame } from "./PreviewFrame";
import s from "./Thumbnail.module.css";
/** Live previews at once: two on a phone, with data saver, or on a small device. */
const maxLive = () => {
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  return matchMedia("(max-width: 767px)").matches || saveData || navigator.hardwareConcurrency <= 4 ? 2 : 6;
};

/** Which cards hold a live slot: a hovered card first, then page order. */
const slots = (() => {
  const wanting = new Map<string, { el: Element; hovered: boolean }>();
  let order: string[] = [];
  const listeners = new Set<() => void>();
  const emit = () => {
    order = [...wanting]
      .sort(([, a], [, b]) => Number(b.hovered) - Number(a.hovered) || (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .map(([id]) => id);
    listeners.forEach((l) => l());
  };
  return {
    want(id: string, el: Element, hovered: boolean) {
      wanting.set(id, { el, hovered });
      emit();
    },
    drop(id: string) {
      if (wanting.delete(id)) emit();
    },
    has: (id: string) => {
      const i = order.indexOf(id);
      return i > -1 && i < maxLive();
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
})();

type Props = { appId: Id<"apps">; slug: string; name: string; version: number; still: string | null; busy: boolean; hovered: boolean };

export function Thumbnail({ appId, slug, name, version, still, busy, hovered }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const scale = useCover(box);
  const [visible, setVisible] = useState(false);
  const [imageShown, setImageShown] = useState(false);
  const [painted, setPainted] = useState(false);
  const wants = visible && (hovered || busy || !still);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!wants || !box.current) return slots.drop(slug);
    slots.want(slug, box.current, hovered);
    return () => slots.drop(slug);
  }, [wants, hovered, slug]);

  const live = useSyncExternalStore(slots.subscribe, () => slots.has(slug));
  useEffect(() => setPainted(false), [live, version]);

  return (
    <div ref={box} className={s.thumb} style={{ "--scale": scale } as React.CSSProperties}>
      {!imageShown && !painted && (
        <div className={s.placeholder}>
          <Blob size={28} faint />
        </div>
      )}
      {still && <img className={`${s.still} ${imageShown ? s.shown : ""}`} src={still} alt="" onLoad={() => setImageShown(true)} />}
      {live && (
        <PreviewFrame
          key={version}
          appId={appId}
          slug={slug}
          name={name}
          version={version}
          pictureIt={!still}
          className={`${s.frame} ${painted ? s.shown : ""}`}
          onPainted={() => setPainted(true)}
        />
      )}
    </div>
  );
}

/** The scale at which the page covers the tile. */
function useCover(box: React.RefObject<HTMLDivElement | null>): number {
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setScale(Math.max(e.contentRect.width / STILL_VIEWPORT.width, e.contentRect.height / STILL_VIEWPORT.height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [box]);
  return scale;
}
