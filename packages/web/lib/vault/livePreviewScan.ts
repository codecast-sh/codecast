// What live preview should draw over a stretch of markdown, as plain data.
//
// This is the whole judgment of the feature — which characters disappear, which
// get styled, which get swapped for something rendered — with no CodeMirror
// view, no DOM and no widgets in sight. `livePreview.ts` turns these spans into
// decorations; this module can be run and asserted on in a plain test process,
// which is the only way the rules stay pinned (a decoration set is nearly
// unreadable once built).
//
// Two readers run over the text, in this order, because they disagree:
//
//  1. A regex pass using the READING VIEW'S OWN patterns (remarkWikiLink) for
//     wiki links, inline tags and block anchors. The markdown grammar does not
//     know Obsidian syntax and actively mis-reads it — `[[A|b]]` parses as a
//     Link over the inner brackets, `![[x]]` as an Image — so these ranges are
//     claimed first and the tree walk skips anything overlapping them. Sharing
//     the reading view's regexes is what keeps the two views from drifting into
//     two different dialects of the same file (library-decisions.md #3 budgeted
//     a second grammar here; this is the cheaper answer).
//  2. A lezer syntax-tree walk for everything CommonMark/GFM: emphasis,
//     headings, links, images, lists, quotes, rules, fenced code.
//
// Cursor reveal: a construct renders raw whenever any selection range touches
// it (boundary inclusive, so a construct you just finished typing stays raw
// until you move away). Block constructs test the whole line instead — a
// heading's `#` should come back when the cursor is anywhere on that heading,
// not only when it sits on the mark itself.
//
// Nothing here can change the document: spans are a view over bytes that stay
// exactly as they were.

import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import {
  blockIdPattern,
  inlineTagPattern,
  isNumericTag,
  parseWikiInner,
  wikiLinkPattern,
  type WikiLinkParts,
} from "./remarkWikiLink";

// ---------------------------------------------------------------------------
// Span vocabulary
// ---------------------------------------------------------------------------

export type LiveWidget =
  | { type: "bullet" }
  | { type: "rule" }
  | { type: "image"; src: string; alt: string };

export type LiveSpan =
  /** Syntax markers the reader shouldn't see. Replaced, and traversed as one
   *  unit by the cursor (see atomicRanges in livePreview.ts). */
  | { kind: "hide"; from: number; to: number }
  /** Styled content — the words inside `**…**`, a wiki link's display text. */
  | { kind: "mark"; from: number; to: number; class: string; attrs?: Record<string, string> }
  /** A whole-line class: heading size, quote rule, code-block background. */
  | { kind: "line"; from: number; class: string }
  /** The only honest rendering is a drawn thing, not styled text. */
  | { kind: "widget"; from: number; to: number; widget: LiveWidget };

export interface WikiResolution {
  path: string | null;
  ambiguous?: boolean;
}

export interface LiveScanDeps {
  /** Where a wiki link points, for resolved/unresolved styling. Absent = every
   *  link renders plain (the shape a test wants unless it says otherwise). */
  resolveWiki?: (parts: WikiLinkParts) => WikiResolution;
  /** A displayable URL for an image source as written in the file, or null when
   *  it can't be served — in which case the raw markdown stays on screen rather
   *  than a broken image. */
  assetUrl?: (rawSrc: string) => string | null;
}

/** The slice of a lezer SyntaxNode this module uses. Declared structurally so
 *  the scanner needs no @lezer/common dependency of its own. */
interface NodeLike {
  getChild(name: string): { from: number; to: number } | null;
  getChildren(name: string): { from: number; to: number }[];
  parent: NodeLike | null;
}

export interface ScanRange {
  from: number;
  to: number;
}

// Inline syntax is literal inside these: the reading view's findAndReplace
// skips code for the same reason, and a `#` in a URL is not a tag.
const LITERAL_NODES = new Set([
  "FencedCode",
  "CodeText",
  "CodeBlock",
  "InlineCode",
  "URL",
  "Comment",
  "CommentBlock",
  "HTMLTag",
  "HTMLBlock",
  "ProcessingInstructionBlock",
]);

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|avif|bmp|ico)$/i;
const ABSOLUTE_URL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

/** Deliberately a full scan rather than a sorted early-exit: `claimed` grows in
 *  three passes that interleave (a tag before an earlier wiki link, a block
 *  anchor after both), so any ordering assumption here would silently miss
 *  overlaps. These lists hold one viewport's worth of ranges — a few dozen. */
function overlaps(ranges: readonly ScanRange[], from: number, to: number): boolean {
  for (const r of ranges) {
    if (r.from < to && r.to > from) return true;
  }
  return false;
}

/** Merge the requested ranges and widen each to whole lines: a wiki link that
 *  straddles the viewport edge must still be seen whole, and line decorations
 *  need the line start anyway. */
function normalizeRanges(state: EditorState, ranges: readonly ScanRange[]): ScanRange[] {
  const doc = state.doc;
  const widened = ranges
    .map((r) => ({
      from: doc.lineAt(Math.max(0, Math.min(r.from, doc.length))).from,
      to: doc.lineAt(Math.max(0, Math.min(r.to, doc.length))).to,
    }))
    .sort((a, b) => a.from - b.from);
  const merged: ScanRange[] = [];
  for (const r of widened) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export function scanLivePreview(
  state: EditorState,
  ranges: readonly ScanRange[],
  deps: LiveScanDeps = {},
): LiveSpan[] {
  const doc = state.doc;
  const spans: LiveSpan[] = [];
  const scanRanges = normalizeRanges(state, ranges);
  if (!scanRanges.length) return spans;

  const revealed = (from: number, to: number) =>
    state.selection.ranges.some((r) => r.from <= to && r.to >= from);
  const lineRevealed = (pos: number) => {
    const line = doc.lineAt(pos);
    return revealed(line.from, line.to);
  };
  const sameLine = (from: number, to: number) =>
    doc.lineAt(from).number === doc.lineAt(to).number;

  // A replacing decoration from a ViewPlugin may not cover a line break, so
  // every replace is gated on staying inside one line. Anything that would
  // straddle simply renders raw — a correct fallback, never a crash.
  const hide = (from: number, to: number) => {
    if (to > from && sameLine(from, to)) spans.push({ kind: "hide", from, to });
  };
  const widget = (from: number, to: number, w: LiveWidget) => {
    if (to > from && sameLine(from, to)) spans.push({ kind: "widget", from, to, widget: w });
  };
  const mark = (from: number, to: number, cls: string, attrs?: Record<string, string>) => {
    if (to > from) spans.push({ kind: "mark", from, to, class: cls, attrs });
  };
  const lineClasses = new Set<string>();
  const line = (pos: number, cls: string) => {
    const start = doc.lineAt(pos).from;
    const key = `${start}:${cls}`;
    if (lineClasses.has(key)) return;
    lineClasses.add(key);
    spans.push({ kind: "line", from: start, class: cls });
  };

  // -- pass 0: where inline syntax is literal ------------------------------
  const tree = syntaxTree(state);
  const literal: ScanRange[] = [];
  for (const r of scanRanges) {
    tree.iterate({
      from: r.from,
      to: r.to,
      enter(node) {
        if (LITERAL_NODES.has(node.name)) literal.push({ from: node.from, to: node.to });
      },
    });
  }

  // -- pass 1: Obsidian syntax, claimed before the tree walk sees it -------
  const claimed: ScanRange[] = [];
  for (const r of scanRanges) {
    const text = doc.sliceString(r.from, r.to);

    const wikiRe = wikiLinkPattern();
    for (let m = wikiRe.exec(text); m; m = wikiRe.exec(text)) {
      const from = r.from + m.index;
      const to = from + m[0].length;
      if (overlaps(literal, from, to)) continue;
      const parts = parseWikiInner(m[0]);
      if (!parts) continue;
      // Claimed even when it renders raw: the grammar's misreading of these
      // brackets must never win, cursor position notwithstanding.
      claimed.push({ from, to });
      if (revealed(from, to)) continue;
      emitWiki(from, to, m[0], parts);
    }

    const tagRe = inlineTagPattern();
    for (let m = tagRe.exec(text); m; m = tagRe.exec(text)) {
      const tag = m[2];
      const from = r.from + m.index + m[1].length;
      const to = from + 1 + tag.length;
      if (isNumericTag(tag) || overlaps(literal, from, to) || overlaps(claimed, from, to)) continue;
      claimed.push({ from, to });
      // A tag pill hides nothing — `#tag` is its own display text — so it stays
      // rendered under the cursor too, exactly as the reading view shows it.
      mark(from, to, "vault-tag", { "data-live-tag": tag });
    }

    const blockRe = blockIdPattern();
    for (let m = blockRe.exec(text); m; m = blockRe.exec(text)) {
      const from = r.from + m.index;
      const to = from + m[0].length;
      if (overlaps(literal, from, to) || overlaps(claimed, from, to)) continue;
      claimed.push({ from, to });
      if (!lineRevealed(from)) hide(from, to);
    }
  }
  /** True only when this node IS a claim — i.e. the grammar misread vault
   *  syntax as one of its own constructs, so the whole node belongs to the
   *  regex pass. A claim merely sitting INSIDE a legitimate construct (a #tag
   *  in a bold run, a wiki link in a markdown link's text) must NOT disqualify
   *  the outer construct: the reading view renders it normally with the vault
   *  syntax live inside, and the two views have to describe a file the same
   *  way (review finding, R12 — overlap was the old test, and it silently
   *  dropped the outer construct's own decoration). */
  const isClaimed = (from: number, to: number) =>
    claimed.some((c) => c.from <= from && c.to >= to);

  /** `[[Target|alias]]` renders as `alias`, `[[Target#Head]]` as `Target#Head`.
   *  Both are achieved by hiding a prefix and a suffix of the RAW TEXT rather
   *  than substituting a widget — so what's on screen is always a real slice of
   *  the file, and the cursor arriving inside it lands somewhere meaningful.
   *  (The reading view prints `Target › Head` for the subpath form; in an
   *  editor the characters you would type are the more useful truth.) */
  function emitWiki(from: number, to: number, raw: string, parts: WikiLinkParts) {
    if (parts.isEmbed) {
      // Image embeds are the one transclusion worth drawing here; a note embed
      // inside an editor is a document-in-a-document and stays raw.
      const src = IMAGE_EXT.test(parts.target) ? (deps.assetUrl?.(parts.target) ?? null) : null;
      if (src) widget(from, to, { type: "image", src, alt: parts.alias ?? parts.target });
      return;
    }
    const pipe = raw.indexOf("|");
    const textFrom = pipe === -1 ? from + 2 : from + pipe + 1;
    const textTo = to - 2;
    if (textTo <= textFrom) return;
    const res = deps.resolveWiki?.(parts) ?? { path: null };
    const cls = !res.path
      ? "wiki-link wiki-link-unresolved"
      : res.ambiguous
        ? "wiki-link wiki-link-ambiguous"
        : "wiki-link";
    hide(from, textFrom);
    hide(textTo, to);
    mark(textFrom, textTo, cls, {
      "data-live-wiki": raw,
      title: res.path ?? `"${parts.target}" does not exist yet — click to create`,
    });
  }

  // -- pass 2: CommonMark + GFM from the syntax tree -----------------------

  /** `**text**`, `*text*`, `~~text~~`, `` `text` ``: style the content always,
   *  hide the fences unless the cursor is in there. */
  const inlineWrapped = (
    node: { from: number; to: number; node: NodeLike },
    markName: string,
    cls: string,
  ) => {
    if (isClaimed(node.from, node.to)) return;
    const marks = node.node.getChildren(markName);
    const open = marks[0];
    const close = marks.length > 1 ? marks[marks.length - 1] : null;
    const textFrom = open ? open.to : node.from;
    const textTo = close ? close.from : node.to;
    mark(textFrom, textTo, cls);
    if (revealed(node.from, node.to)) return;
    if (open) hide(open.from, open.to);
    if (close) hide(close.from, close.to);
  };

  for (const r of scanRanges) {
    tree.iterate({
      from: r.from,
      to: r.to,
      enter(node) {
        const name = node.name;

        if (name.startsWith("ATXHeading")) {
          const level = Number(name.slice(-1)) || 1;
          line(node.from, `cm-live-h${level}`);
          if (lineRevealed(node.from)) return;
          for (const hm of node.node.getChildren("HeaderMark")) {
            if (hm.from === node.from) {
              // Swallow the space after the hashes too, or the prose starts
              // one column further right than an unmarked paragraph.
              let end = hm.to;
              while (end < node.to && doc.sliceString(end, end + 1) === " ") end++;
              hide(hm.from, end);
            } else {
              // A closed heading's trailing `###`, with its leading space.
              let start = hm.from;
              while (start > node.from && doc.sliceString(start - 1, start) === " ") start--;
              hide(start, hm.to);
            }
          }
          return;
        }

        switch (name) {
          case "StrongEmphasis":
            return inlineWrapped(node, "EmphasisMark", "cm-live-strong");
          case "Emphasis":
            return inlineWrapped(node, "EmphasisMark", "cm-live-em");
          case "Strikethrough":
            return inlineWrapped(node, "StrikethroughMark", "cm-live-strike");
          case "InlineCode":
            return inlineWrapped(node, "CodeMark", "cm-live-code");

          case "Link": {
            if (isClaimed(node.from, node.to)) return;
            const marks = node.node.getChildren("LinkMark");
            if (marks.length < 2) return;
            const textFrom = marks[0].to;
            const textTo = marks[1].from;
            if (textTo <= textFrom) return;
            const url = node.node.getChild("URL");
            const href = url ? doc.sliceString(url.from, url.to) : "";
            mark(textFrom, textTo, "cm-live-link", href ? { "data-live-href": href } : undefined);
            if (revealed(node.from, node.to)) return;
            hide(node.from, textFrom);
            hide(textTo, node.to);
            return;
          }

          case "Image": {
            if (isClaimed(node.from, node.to) || revealed(node.from, node.to)) return;
            const url = node.node.getChild("URL");
            if (!url) return;
            const raw = doc.sliceString(url.from, url.to);
            const src = ABSOLUTE_URL.test(raw) ? raw : (deps.assetUrl?.(raw) ?? null);
            if (!src) return;
            const marks = node.node.getChildren("LinkMark");
            const alt =
              marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : "";
            widget(node.from, node.to, { type: "image", src, alt });
            return;
          }

          case "ListMark": {
            const text = doc.sliceString(node.from, node.to);
            // A task item's `-` keeps its shape: `• [ ] thing` reads worse than
            // the source it stands for, and the checkbox is the marker there.
            const isTask = !!node.node.parent?.getChild("Task");
            if (/^[-*+]$/.test(text) && !isTask) widget(node.from, node.to, { type: "bullet" });
            else mark(node.from, node.to, "cm-live-listmark");
            return;
          }

          case "QuoteMark": {
            // An Obsidian callout is a blockquote whose first line opens with
            // `[!type]`. The quote rule is the same; the difference is that the
            // marker line becomes a title, so it gets the callout's accent and
            // the `[!type]` token itself is hidden (the label reads as the
            // title). Matching the reading view's callout family by name keeps
            // the two modes describing the same document the same way.
            const lineAt = doc.lineAt(node.from);
            const callout = lineAt.text.match(/^\s*>\s*\[!(\w+)\][+-]?/);
            if (callout) {
              const kind = callout[1].toLowerCase();
              line(lineAt.from, `cm-live-quote cm-live-callout cm-live-callout-${kind}`);
            } else {
              line(node.from, "cm-live-quote");
            }
            if (lineRevealed(node.from)) return;
            let end = node.to;
            if (doc.sliceString(end, end + 1) === " ") end++;
            // Hide the `[!type]` token with the quote mark, so the callout's
            // own words are what's left on screen.
            if (callout) {
              const tokenStart = lineAt.text.indexOf("[!", end - lineAt.from);
              if (tokenStart >= 0) {
                const abs = lineAt.from + tokenStart;
                const close = lineAt.text.indexOf("]", tokenStart);
                if (close > tokenStart) {
                  let tokenEnd = lineAt.from + close + 1;
                  if (/[+-]/.test(doc.sliceString(tokenEnd, tokenEnd + 1))) tokenEnd++;
                  if (doc.sliceString(tokenEnd, tokenEnd + 1) === " ") tokenEnd++;
                  hide(node.from, tokenEnd);
                  return;
                }
              }
            }
            hide(node.from, end);
            return;
          }

          case "HorizontalRule": {
            if (revealed(node.from, node.to)) return;
            widget(node.from, node.to, { type: "rule" });
            return;
          }

          case "FencedCode": {
            // Raw and complete — nothing about a code fence reads better
            // rendered — but set apart by a background, the way the reading
            // view sets it apart with one.
            const first = doc.lineAt(Math.max(node.from, r.from)).number;
            const last = doc.lineAt(Math.min(node.to, r.to)).number;
            for (let n = first; n <= last; n++) line(doc.line(n).from, "cm-live-codeblock");
            return;
          }
        }
      },
    });
  }

  spans.sort((a, b) => a.from - b.from);
  return spans;
}
