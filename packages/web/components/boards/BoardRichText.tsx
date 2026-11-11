// Formatting inside stickies, text and shapes. The stored text is plain with a
// small markdown subset (what a person types and what an agent writes):
// **bold**, *italic*, ~~strike~~, `- ` and `1. ` list lines, bare URLs and
// [label](url) links. The editor shows the marks; the canvas draws them.
import type { CSSProperties, ReactNode } from "react";
import { INLINE, richLines } from "./boardMarks";

function safeHref(url: string): string | null {
  return /^(https?:\/\/|mailto:)/i.test(url) ? url : null;
}

function link(href: string, label: ReactNode, key: number): ReactNode {
  return (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      style={{ color: "var(--sol-blue)", textDecoration: "underline", textUnderlineOffset: "0.15em", cursor: "pointer" }}
      // A press on the canvas selects and drags the element; Cmd/Ctrl-click opens the link.
      onClick={(e) => { if (!(e.metaKey || e.ctrlKey)) e.preventDefault(); }}
    >
      {label}
    </a>
  );
}

/** One line's inline marks. */
function inlineMarks(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0, i = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={i++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("~~")) out.push(<s key={i++}>{t.slice(2, -2)}</s>);
    else if (t.startsWith("*")) out.push(<em key={i++}>{t.slice(1, -1)}</em>);
    else if (t.startsWith("[")) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      const href = safeHref(mm[2]);
      out.push(href ? link(href, mm[1], i++) : t);
    } else {
      // A bare URL drops trailing sentence punctuation.
      const url = t.replace(/[.,;:!?]+$/, "");
      const href = safeHref(url);
      out.push(href ? link(href, url.replace(/^https?:\/\//, ""), i++) : url);
      if (url.length < t.length) out.push(t.slice(url.length));
    }
    last = at + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Lines with their marks. `titleFirst` draws a sticky's first line bold when
 * more lines follow (a card's title over its body).
 */
export function RichText({ text, titleFirst }: { text: string; titleFirst?: boolean }) {
  const lines = richLines(text);
  // One plain line stays bare text: it is the sticky's title, the one line the far zoom level keeps.
  if (lines.length === 1 && lines[0].kind === "text") return <>{inlineMarks(lines[0].text)}</>;
  return (
    <>
      {lines.map((l, i) => {
        const body = inlineMarks(l.text);
        if (l.kind !== "text") {
          return (
            <span key={i} style={LI}>
              <span aria-hidden style={{ flex: "none", opacity: 0.7 }}>{l.kind === "bullet" ? "•" : `${l.n}.`}</span>
              <span>{body}</span>
            </span>
          );
        }
        if (titleFirst && i === 0) return <strong key={i} style={{ display: "block" }}>{body}</strong>;
        return <span key={i} style={{ display: "block" }}>{l.text ? body : "\u00a0"}</span>;
      })}
    </>
  );
}

const LI: CSSProperties = { display: "flex", gap: "0.45em", textAlign: "left", width: "100%" };
