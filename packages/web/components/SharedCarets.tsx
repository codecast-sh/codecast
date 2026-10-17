import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { PresenceRow } from "../hooks/useDocPresence";
import { typingEditors } from "../hooks/useSharedDraft";
import "./sharedCarets.css";

// The other people's carets in a shared draft (hooks/useSharedDraft), drawn
// over the textarea. A textarea cannot hold markup, so this is a mirror: the
// same text in the same type at the same width, transparent, with a caret
// placed at each person's offset. It shares the textarea's grid cell, follows
// its scroll, and never takes a click. A caret wears its owner's name while
// they are typing and is a bare line otherwise.

const MIRRORED = [
  "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "tabSize",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "textIndent", "wordSpacing",
] as const;

export const SharedCarets = memo(function SharedCarets({
  inputRef,
  text,
  rows,
  editors,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  rows: readonly PresenceRow[];
  editors: Record<string, number>;
}) {
  const [box, setBox] = useState<{ style: CSSProperties; scroll: number } | null>(null);
  const carets = rows
    .filter((r) => r.cursor_pos != null)
    .map((r) => ({ id: r.user_id, name: r.user_name.split(/[\s@]/)[0] || r.user_name, color: r.user_color, at: Math.max(0, Math.min(text.length, r.cursor_pos!)) }))
    .sort((a, b) => a.at - b.at);
  const typing = new Set(typingEditors(editors));
  const any = carets.length > 0;
  const lastWidth = useRef(0);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || !any) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const style: CSSProperties = { width: el.clientWidth };
      for (const k of MIRRORED) (style as any)[k] = cs[k];
      lastWidth.current = el.clientWidth;
      setBox({ style, scroll: el.scrollTop });
    };
    measure();
    const onScroll = () => setBox((b) => (b ? { ...b, scroll: el.scrollTop } : b));
    const ro = new ResizeObserver(() => { if (el.clientWidth !== lastWidth.current) measure(); });
    ro.observe(el);
    el.addEventListener("scroll", onScroll);
    return () => { ro.disconnect(); el.removeEventListener("scroll", onScroll); };
  }, [inputRef, any]);

  if (!any || !box) return null;
  const parts: React.ReactNode[] = [];
  let from = 0;
  for (const c of carets) {
    parts.push(text.slice(from, c.at));
    parts.push(
      <span key={c.id} className="sd-caret" style={{ "--sd-color": c.color } as CSSProperties} data-typing={typing.has(c.id) || undefined}>
        <span className="sd-caret-flag">{c.name}</span>
      </span>,
    );
    from = c.at;
  }
  parts.push(text.slice(from));
  return (
    <div aria-hidden className="sd-carets [grid-area:1/1]">
      <div className="sd-carets-mirror" style={{ ...box.style, transform: `translateY(${-box.scroll}px)` }}>
        {parts}
        {"​"}
      </div>
    </div>
  );
});
