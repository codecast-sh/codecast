import { useState, useRef, useCallback } from "react";
import { useWatchEffect } from "./useWatchEffect";

// Full-width geometry per block, keyed by a stable id so the state survives
// virtualizer unmount/remount cycles.
const expandedBlocks = new Map<string, { left: number; width: number }>();

function measureExpand(el: HTMLElement, currentLeftOffset = 0): { left: number; width: number } | null {
  const scrollParent = el.closest('.overflow-y-auto') as HTMLElement | null;
  if (!scrollParent) return null;
  const scrollRect = scrollParent.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const naturalLeft = elRect.left - currentLeftOffset;
  const leftOffset = naturalLeft - scrollRect.left - 16;
  const targetWidth = scrollRect.width - 32;
  return { left: -leftOffset, width: targetWidth };
}

export function useFullWidthExpand(key: string) {
  const stored = expandedBlocks.get(key);
  const [expanded, setExpanded] = useState(!!stored);
  const [geo, setGeo] = useState<{ left: number; width: number } | null>(stored || null);
  const containerRef = useRef<HTMLDivElement>(null);

  useWatchEffect(() => {
    const el = containerRef.current;
    if (!el || !expanded) return;
    requestAnimationFrame(() => {
      if (!el.isConnected) return;
      const fresh = measureExpand(el, geo?.left || 0);
      if (!fresh) return;
      if (geo?.left !== fresh.left || geo?.width !== fresh.width) {
        expandedBlocks.set(key, fresh);
        setGeo(fresh);
      }
    });
  }, [expanded, key]);

  const toggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    if (next) {
      const el = containerRef.current;
      if (el) {
        const fresh = measureExpand(el);
        if (fresh) {
          expandedBlocks.set(key, fresh);
          setGeo(fresh);
        }
      }
    } else {
      expandedBlocks.delete(key);
      setGeo(null);
    }
  }, [expanded, key]);

  const style: React.CSSProperties = geo
    ? { position: 'relative', left: geo.left, width: geo.width }
    : {};

  return { expanded, toggle, containerRef, style };
}
