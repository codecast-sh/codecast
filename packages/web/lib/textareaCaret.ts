// Pixel position of a character index inside a <textarea>, for anchoring UI at
// the caret — the mention popup opens at the "@" the user typed, not centered
// in whatever container the composer happens to fill.
//
// A textarea exposes no caret geometry, so this uses the standard mirror trick:
// clone the textarea's text-layout styles onto a hidden div, fill it with the
// text up to the index, and read where a marker span lands. The mirror must
// copy every property that affects line breaking — font, padding, border,
// white-space — or the measured caret drifts from the real one exactly on the
// wrapped lines where it matters most.

const MIRROR_PROPS = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "textIndent",
  "wordSpacing",
  "tabSize",
] as const;

/** Coordinates of `index` within the textarea's border box, in px, unscrolled —
 *  subtract scrollTop/scrollLeft for the visible position. */
export function textareaCaretRect(
  textarea: HTMLTextAreaElement,
  index: number,
): { left: number; top: number; height: number } {
  const mirror = document.createElement("div");
  const style = window.getComputedStyle(textarea);
  for (const prop of MIRROR_PROPS) {
    mirror.style[prop as any] = style[prop as any];
  }
  // A textarea wraps long words; a div only matches with both of these.
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";

  mirror.textContent = textarea.value.slice(0, Math.max(0, index));
  const marker = document.createElement("span");
  // A zero-width marker measures the gap BEFORE the next character, which is
  // where a caret actually sits.
  marker.textContent = "​";
  mirror.appendChild(marker);

  document.body.appendChild(mirror);
  const left = marker.offsetLeft;
  const top = marker.offsetTop;
  const height = marker.offsetHeight || parseInt(style.lineHeight, 10) || 18;
  document.body.removeChild(mirror);
  return { left, top, height };
}
