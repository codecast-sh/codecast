// Formatting inside stickies, text and shapes. The stored text is plain with a
// small markdown subset (what a person types and what an agent writes):
// **bold**, *italic*, ~~strike~~, `- ` and `1. ` list lines, bare URLs and
// [label](url) links. The editor shows the marks; the canvas draws them.
import { Fragment, type CSSProperties, type ReactNode } from "react";
import { markRuns, richLines } from "./boardMarks";

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
      // On the canvas a link opens with Cmd/Ctrl-click; it is not a stop when Tab walks the board.
      tabIndex={-1}
      className="board-a"
      // A press on the canvas selects and drags the element; Cmd/Ctrl-click opens the link.
      onClick={(e) => { if (!(e.metaKey || e.ctrlKey)) e.preventDefault(); }}
    >
      {label}
    </a>
  );
}

/** One line's inline marks, drawn from the same runs the editor and the export use. */
function inlineMarks(text: string): ReactNode[] {
  return markRuns(text).map((r, i) => {
    let n: ReactNode = r.t;
    if (r.s) n = <s>{n}</s>;
    if (r.i) n = <em>{n}</em>;
    if (r.b) n = <strong>{n}</strong>;
    const href = r.href ? safeHref(r.href) : null;
    // Plain runs stay bare text: a sticky's one-line title is what the far zoom level keeps.
    return href ? link(href, n, i) : <Fragment key={i}>{n}</Fragment>;
  });
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
            <span key={i} className="board-line board-li" style={LI}>
              <span aria-hidden style={{ flex: "none", opacity: 0.7 }}>{l.kind === "bullet" ? "•" : `${l.n}.`}</span>
              <span>{body}</span>
            </span>
          );
        }
        if (titleFirst && i === 0) return <strong key={i} className="board-line">{body}</strong>;
        return <span key={i} className="board-line">{l.text ? body : "\u00a0"}</span>;
      })}
    </>
  );
}

const LI: CSSProperties = { gap: "0.45em", textAlign: "left", width: "100%" };
