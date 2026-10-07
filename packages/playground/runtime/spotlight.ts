// The landing spotlight: when a version goes live, the shell names the
// element its change is about and a soft ring draws around it for a moment,
// so whoever is watching sees where the change landed.
import { ringLayer } from "./picker";

const SPOTLIGHT_MS = 1200;
const MOST = 6;

/** Ring the visible elements `selector` matches (the first few); false when
 *  none is on screen, and the shell marks the landing another way. */
export function spotlight(selector: string, color: string): boolean {
  const els = onScreen(selector);
  for (const el of els) {
    const layer = ringLayer(color, spotlightCss(color));
    let frame = requestAnimationFrame(function follow() {
      layer.place(el);
      frame = requestAnimationFrame(follow);
    });
    layer.place(el);
    setTimeout(() => {
      cancelAnimationFrame(frame);
      layer.remove();
    }, SPOTLIGHT_MS);
  }
  return els.length > 0;
}

function onScreen(selector: string): Element[] {
  let matches: NodeListOf<Element>;
  try {
    matches = document.querySelectorAll(selector);
  } catch {
    return [];
  }
  return [...matches]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    })
    .slice(0, MOST);
}

/** Brighter than the picker's ring, with a light inner line, so it reads
 *  on a dark app as well as a light one. */
const spotlightCss = (color: string) => `
  .ring { box-shadow: inset 0 0 0 1px rgba(255, 253, 249, .55), 0 0 0 1px rgba(255, 253, 249, .35), 0 0 0 7px color-mix(in srgb, ${color} 26%, transparent); }
  .box { animation: spot ${SPOTLIGHT_MS}ms cubic-bezier(.2, .8, .2, 1) forwards; }
  @keyframes spot {
    0% { opacity: 0; transform: scale(1.06); }
    20% { opacity: 1; transform: none; }
    70% { opacity: 1; }
    100% { opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    @keyframes spot { 0% { opacity: 0; } 15% { opacity: 1; } 75% { opacity: 1; } 100% { opacity: 0; } }
  }
`;
