// A gallery card's picture: the app itself, live, at a quarter scale, mounted
// only while the card is on screen and at most six at once (DESIGN 6.1).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { versionPath } from "../../convex/lib/runPaths";
import { RUNTIME_CSP } from "../../convex/lib/runtime";
import { RUN_ORIGIN } from "../lib/convex";
import { Blob } from "../ui/Blob";
import s from "./Thumbnail.module.css";

const MAX_LIVE = 6;
const SANDBOX = RUNTIME_CSP.replace(/^sandbox /, "");

/** Which visible cards hold one of the live slots, first come first served. */
const slots = (() => {
  const wanting: string[] = [];
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  return {
    want(id: string) {
      if (!wanting.includes(id)) wanting.push(id);
      emit();
    },
    drop(id: string) {
      const i = wanting.indexOf(id);
      if (i >= 0) wanting.splice(i, 1);
      emit();
    },
    has: (id: string) => wanting.indexOf(id) > -1 && wanting.indexOf(id) < MAX_LIVE,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
})();

export function Thumbnail({ slug, version }: { slug: string; version: number }) {
  const box = useRef<HTMLDivElement>(null);
  const id = `${slug}`;
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => (e.isIntersecting ? slots.want(id) : slots.drop(id)), { rootMargin: "120px" });
    io.observe(el);
    return () => {
      io.disconnect();
      slots.drop(id);
    };
  }, [id]);
  const live = useSyncExternalStore(slots.subscribe, () => slots.has(id));
  return (
    <div ref={box} className={s.thumb}>
      <div className={s.placeholder}><Blob size={44} /></div>
      {live && (
        <iframe
          className={`${s.frame} ${loaded ? s.loaded : ""}`}
          src={RUN_ORIGIN + versionPath(slug, version)}
          sandbox={SANDBOX}
          loading="lazy"
          tabIndex={-1}
          aria-hidden
          title=""
          onLoad={() => setLoaded(true)}
        />
      )}
    </div>
  );
}
