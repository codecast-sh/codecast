// Where the workspace's pickers (quick open, the tab switcher, go to line)
// sit: centered over the focused group's editor area and hung from its top
// edge, as Zed and VS Code place them, never centered on the window where
// they spill over the file tree.

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

const GAP = 6;
const MARGIN = 8;

/** The focused group's editor area inside a workspace root. */
function focusedGroupBody(root: Element): DOMRect | null {
  const group = root.querySelector("[data-code-group]:not([data-group-idle])") ?? root.querySelector("[data-code-group]");
  const body = group?.querySelector("[data-group-body]") ?? group;
  return body ? body.getBoundingClientRect() : null;
}

export function anchorStyle(box: DOMRect | null, width: number): CSSProperties {
  if (!box || box.width === 0) return { position: "fixed", top: "14vh", left: "50%", width: `min(${width}px, 92vw)`, transform: "translateX(-50%)" };
  const w = Math.max(240, Math.min(width, box.width - 2 * MARGIN));
  const left = Math.max(MARGIN, Math.min(box.left + box.width / 2 - w / 2, window.innerWidth - w - MARGIN));
  return { position: "fixed", top: box.top + GAP, left, width: w };
}

/** A ref for the overlay's outer element and the style for its panel. */
export function useGroupAnchor<T extends HTMLElement>(width: number): { ref: React.RefObject<T | null>; style: CSSProperties } {
  const ref = useRef<T | null>(null);
  const [style, setStyle] = useState<CSSProperties>(() => anchorStyle(null, width));
  useLayoutEffect(() => {
    const measure = () => {
      const root = ref.current?.closest("[data-code-workspace]");
      setStyle(anchorStyle(root ? focusedGroupBody(root) : null, width));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [width]);
  return { ref, style };
}
