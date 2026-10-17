"use client";
// What a scroller hides, for the line page's edge fades (line.css
// .line-edge-fade): the flow of stations and the project pills both say
// "there is more past this edge" the same way; the org drawer's pinned lead
// reads the bottom edge.
import { useState, type RefObject } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";

export type ScrollEdges = { left: boolean; right: boolean; top: boolean; bottom: boolean };

function readEdges(el: HTMLElement): ScrollEdges {
  return { left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2, top: el.scrollTop > 2, bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 2 };
}

/** Which edges of `ref` hide content, kept current through scrolls and resizes.
 *  `remount` names what swaps the scroller's element, so the observers follow it. */
export function useScrollEdges(ref: RefObject<HTMLElement | null>, remount: unknown = null): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ left: false, right: false, top: false, bottom: false });
  useWatchEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const next = readEdges(el);
      setEdges((e) => (e.left === next.left && e.right === next.right && e.top === next.top && e.bottom === next.bottom ? e : next));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => { el.removeEventListener("scroll", measure); ro?.disconnect(); };
  }, [ref, remount]);
  return edges;
}

/** Edge-fade attributes for a scroller: spread onto the element that scrolls. */
export const edgeAttrs = (e: ScrollEdges) => ({ "data-edge-left": e.left ? "true" : undefined, "data-edge-right": e.right ? "true" : undefined });

/** Scroll a sideways row so `el` sits at its center, clear of both faded
 *  edges. Rects and scrollTo, not scrollIntoView, so the page never scrolls. */
export function centerInRow(row: HTMLElement, el: HTMLElement, behavior: ScrollBehavior = "auto") {
  const box = row.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  row.scrollTo({ left: row.scrollLeft + (r.left + r.width / 2) - (box.left + box.width / 2), behavior });
}
