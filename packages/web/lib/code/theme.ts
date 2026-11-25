// The app's look for CodeMirror: one palette read off the --sol-* tokens, the
// chrome both editors share (cursor, selection, search panel, tooltips), the
// notes theme VaultEditor uses, and the code theme the code editor uses.
//
// CodeMirror themes are injected as real CSS rules built from literal values,
// and every built theme mounts a style module that stays in the document. So
// each theme is built once per palette (perPalette) and every editor shares
// it; a light/dark flip builds the other one. The code highlight style takes the same --hljs-* colors the
// Prism CSS in globals.css gives `.token.*`, so a TypeScript file reads the
// same in a transcript's code block and in the editor.

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { cssVar, isDarkTheme, withAlpha } from "../solTheme";

export const EDITOR_FONT = "'JetBrains Mono', ui-monospace, monospace";

/** Custom properties the code editor sets on `.cm-editor` for its cursor. Vim's
 *  block cursor (`.cm-fat-cursor`, styled in vim/theme.ts) colors itself from
 *  these, so it follows the theme with the bar cursor rather than carrying a
 *  color of its own. The block is opaque and the letter on it has one fixed
 *  color chosen against it, never the character's syntax color, so no token
 *  (a string drawn in the cursor's own cyan) can vanish under the cursor. */
export const CODE_CURSOR_VAR = "--code-cursor";
export const CODE_CURSOR_BLOCK_VAR = "--code-cursor-block";
export const CODE_CURSOR_TEXT_VAR = "--code-cursor-text";

/** WCAG relative luminance of a #rgb/#rrggbb color, null for anything else. */
function luminance(color: string): number | null {
  const m = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return 0;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** A diff tint's alpha for this background: as given on a light one, about
 *  twice that on a dark one, where the same tint all but disappears. */
export function diffTint(p: { bg: string }, alpha: number): number {
  const l = luminance(p.bg);
  return l !== null && l < 0.2 ? Math.min(1, alpha * 2) : alpha;
}

/** The block cursor's cell and letter: the cursor's cyan with whichever of
 *  the page's background or text reads better on it, or plain reverse video
 *  (text-colored cell, background-colored letter) in a theme whose cyan
 *  carries neither. Exported for tests. */
export function blockCursorColors(p: { bg: string; text: string; cyan: string }): { block: string; letter: string } {
  const onBg = contrast(p.cyan, p.bg);
  const onText = contrast(p.cyan, p.text);
  if (Math.max(onBg, onText) >= 4.5) return { block: p.cyan, letter: onBg >= onText ? p.bg : p.text };
  return { block: p.text, letter: p.bg };
}

interface Palette {
  bg: string;
  bgAlt: string;
  text: string;
  muted: string;
  dim: string;
  border: string;
  cyan: string;
  blue: string;
  yellow: string;
  green: string;
  violet: string;
  magenta: string;
  red: string;
}

function readPalette(s: CSSStyleDeclaration): Palette {
  return {
    bg: cssVar(s, "--sol-bg", "#fbf5e2"),
    bgAlt: cssVar(s, "--sol-bg-alt", "#eee8d5"),
    text: cssVar(s, "--sol-text", "#002b36"),
    muted: cssVar(s, "--sol-text-muted", "#586e75"),
    dim: cssVar(s, "--sol-text-dim", "#657b83"),
    border: cssVar(s, "--sol-border", "#93a1a1"),
    cyan: cssVar(s, "--sol-cyan", "#2aa198"),
    blue: cssVar(s, "--sol-blue", "#268bd2"),
    yellow: cssVar(s, "--sol-yellow", "#b58900"),
    green: cssVar(s, "--sol-green", "#859900"),
    violet: cssVar(s, "--sol-violet", "#6c71c4"),
    magenta: cssVar(s, "--sol-magenta", "#d33682"),
    red: cssVar(s, "--sol-red", "#dc322f"),
  };
}

/** Cursor, selection, matches, the search panel and completion tooltips: the
 *  app's own chrome rather than CodeMirror's default grey boxes. */
function chromeSpec(p: Palette) {
  return {
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: p.cyan, borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: withAlpha(p.cyan, 0.22),
    },
    ".cm-activeLine": { backgroundColor: withAlpha(p.bgAlt, 0.45) },
    ".cm-selectionMatch": { backgroundColor: withAlpha(p.yellow, 0.2) },
    ".cm-searchMatch": {
      backgroundColor: withAlpha(p.yellow, 0.25),
      outline: `1px solid ${withAlpha(p.yellow, 0.5)}`,
    },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: withAlpha(p.cyan, 0.35) },
    ".cm-matchingBracket, .cm-nonmatchingBracket": {
      backgroundColor: withAlpha(p.cyan, 0.18),
      outline: "none",
    },
    ".cm-panels": {
      backgroundColor: p.bgAlt,
      color: p.text,
      border: "none",
      fontFamily: EDITOR_FONT,
    },
    ".cm-panels.cm-panels-top": { borderBottom: `1px solid ${withAlpha(p.border, 0.4)}` },
    ".cm-panel.cm-search": { padding: "6px 8px", fontSize: "11px" },
    ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": {
      fontFamily: "inherit",
      fontSize: "11px",
    },
    ".cm-panel.cm-search input[type=text]": {
      backgroundColor: p.bg,
      color: p.text,
      border: `1px solid ${withAlpha(p.border, 0.4)}`,
      borderRadius: "3px",
      padding: "2px 6px",
      outline: "none",
    },
    ".cm-panel.cm-search input[type=text]:focus": { borderColor: p.cyan },
    ".cm-panel.cm-search button:not([name=close])": {
      backgroundColor: "transparent",
      backgroundImage: "none",
      color: p.muted,
      border: `1px solid ${withAlpha(p.border, 0.4)}`,
      borderRadius: "3px",
      padding: "2px 6px",
      cursor: "pointer",
    },
    ".cm-panel.cm-search button:not([name=close]):hover": { color: p.text, borderColor: p.cyan },
    ".cm-panel.cm-search [name=close]": { color: p.dim, fontSize: "14px", padding: "0 4px" },
    ".cm-tooltip.cm-tooltip-autocomplete": {
      backgroundColor: p.bg,
      border: `1px solid ${withAlpha(p.border, 0.5)}`,
      borderRadius: "4px",
      boxShadow: "0 6px 20px rgba(0,0,0,0.18)",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul": {
      fontFamily: EDITOR_FONT,
      fontSize: "12px",
      maxHeight: "16em",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "3px 8px", color: p.text },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: withAlpha(p.cyan, 0.18),
      color: p.text,
    },
    ".cm-completionDetail": { color: p.dim, fontStyle: "normal", marginLeft: "8px" },
  };
}

/** Build once per palette. The palette follows the root element's classes
 *  (the light/dark switch), so they key the cache and no style is read on a
 *  cache hit. */
/** What a built theme depends on: the light/dark class, and the tokens a
 *  custom theme writes inline on <html> without touching its class (two
 *  themes of one mode differ only there). */
function themeKey(): string {
  const root = document.documentElement;
  return `${root.className}|${root.getAttribute("style") ?? ""}`;
}

/** Re-run `apply` when the page's theme changes: its light/dark class, or the
 *  tokens a custom theme writes inline on <html>. */
export function observeCodeTheme(apply: () => void): () => void {
  let last = themeKey();
  // Other writes to <html>'s style (a scroll lock) are not a theme change.
  const observer = new MutationObserver(() => {
    const key = themeKey();
    if (key === last) return;
    last = key;
    apply();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  return () => observer.disconnect();
}

function perPalette(build: () => Extension): () => Extension {
  const built = new Map<string, Extension>();
  return () => {
    const key = themeKey();
    let ext = built.get(key);
    if (!ext) built.set(key, (ext = build()));
    return ext;
  };
}

/** The notes editor (VaultEditor): prose line height, markdown punctuation
 *  faded back so the words read first. */
export const solEditorTheme = perPalette(() => {
  const s = getComputedStyle(document.documentElement);
  const p = readPalette(s);
  return [
    EditorView.theme(
      {
        "&": { color: p.text, backgroundColor: "transparent", fontSize: "13px" },
        ".cm-content": { fontFamily: EDITOR_FONT, padding: "0", lineHeight: "1.7", caretColor: p.cyan },
        ".cm-line": { padding: "0" },
        ...chromeSpec(p),
        ".cm-completionIcon": { display: "none" },
      },
      { dark: isDarkTheme() },
    ),
    syntaxHighlighting(
      HighlightStyle.define([
        { tag: t.processingInstruction, color: p.dim },
        { tag: t.contentSeparator, color: p.dim },
        { tag: t.heading, color: p.text, fontWeight: "600" },
        { tag: t.heading1, color: p.text, fontWeight: "700", fontSize: "1.15em" },
        { tag: t.heading2, color: p.text, fontWeight: "700", fontSize: "1.07em" },
        { tag: t.strong, color: p.text, fontWeight: "700" },
        { tag: t.emphasis, color: p.text, fontStyle: "italic" },
        { tag: t.strikethrough, color: p.muted, textDecoration: "line-through" },
        { tag: [t.link, t.url], color: p.cyan },
        { tag: t.monospace, color: p.green },
        { tag: t.quote, color: p.muted, fontStyle: "italic" },
        { tag: t.list, color: p.blue },
        { tag: t.comment, color: p.dim, fontStyle: "italic" },
        { tag: [t.keyword, t.moduleKeyword], color: p.green },
        { tag: [t.string, t.special(t.string)], color: p.cyan },
        { tag: [t.number, t.bool, t.null], color: p.magenta },
        { tag: [t.typeName, t.className], color: p.yellow },
        { tag: [t.function(t.variableName), t.labelName], color: p.blue },
        { tag: [t.propertyName, t.attributeName], color: p.violet },
        { tag: t.invalid, color: p.red },
      ]),
    ),
  ];
});

/** Lezer tags to the Prism token classes globals.css colors, color for color. */
function codeHighlight(s: CSSStyleDeclaration, p: Palette): Extension {
  const hl = (name: string, fallback: string) => cssVar(s, `--hljs-${name}`, fallback);
  const keyword = hl("keyword", p.green);
  const string = hl("string", p.cyan);
  const number = hl("number", p.magenta);
  const fn = hl("function", p.blue);
  const comment = hl("comment", p.dim);
  const type = hl("type", p.yellow);
  const variable = hl("variable", "#cb4b16");
  const secondary = cssVar(s, "--sol-text-secondary", p.text);
  return syntaxHighlighting(
    HighlightStyle.define([
      // .token.comment, .prolog, .doctype, .cdata
      { tag: [t.comment, t.docComment], color: comment, fontStyle: "italic" },
      // .token.punctuation
      { tag: [t.punctuation, t.bracket, t.separator, t.derefOperator], color: p.muted },
      // .token.keyword, .atrule
      {
        tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword, t.modifier, t.self, t.meta, t.annotation, t.processingInstruction],
        color: keyword,
      },
      // .token.string, .attr-value, .template-string
      { tag: [t.string, t.special(t.string), t.attributeValue, t.docString], color: string },
      // .token.number, .boolean, .constant, .symbol, .tag, .property (JSON keys, CSS properties)
      { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.constant(t.variableName), t.tagName], color: number },
      // .token.function, .class-name
      {
        tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.className, t.typeName, t.labelName, t.macroName],
        color: fn,
      },
      // .token.builtin, .attr-name, .selector, .char
      { tag: [t.standard(t.variableName), t.standard(t.typeName), t.attributeName, t.character, t.namespace], color: type },
      // .token.regex, .important, .variable
      { tag: [t.regexp, t.escape, t.special(t.variableName)], color: variable },
      // .token.operator, .entity, .url
      { tag: [t.operator, t.url], color: secondary },
      // Markup inside code files (markdown, docstrings), diff and invalid text.
      { tag: t.heading, fontWeight: "700", color: p.text },
      { tag: t.strong, fontWeight: "700" },
      { tag: t.emphasis, fontStyle: "italic" },
      { tag: t.strikethrough, textDecoration: "line-through" },
      { tag: t.link, color: string, textDecoration: "underline" },
      { tag: t.inserted, color: p.green },
      { tag: t.deleted, color: p.red },
      { tag: t.changed, color: p.yellow },
      { tag: t.invalid, color: p.red },
    ]),
  );
}

/** The code editor: a quiet gutter, a soft active line, a clear selection, and
 *  the cursor tokens vim's block cursor reads. */
export const solCodeTheme = perPalette(() => {
  const s = getComputedStyle(document.documentElement);
  const p = readPalette(s);
  const gutterText = withAlpha(p.dim, 0.55);
  const cursorBlock = blockCursorColors(p);
  return [
    EditorView.theme(
      {
        "&": {
          color: p.text,
          backgroundColor: "transparent",
          fontSize: "13px",
          height: "100%",
          [CODE_CURSOR_VAR]: p.cyan,
          [CODE_CURSOR_BLOCK_VAR]: cursorBlock.block,
          [CODE_CURSOR_TEXT_VAR]: cursorBlock.letter,
        },
        ".cm-scroller": { fontFamily: EDITOR_FONT, lineHeight: "1.6" },
        ".cm-content": { caretColor: p.cyan, padding: "6px 0" },
        ".cm-line": { padding: "0 16px 0 6px" },
        ...chromeSpec(p),
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: `var(${CODE_CURSOR_VAR})`, borderLeftWidth: "2px" },
        ".cm-activeLine": { backgroundColor: withAlpha(p.bgAlt, 0.5) },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
          backgroundColor: withAlpha(p.cyan, 0.24),
        },
        ".cm-gutters": {
          backgroundColor: "transparent",
          color: gutterText,
          border: "none",
          fontFamily: EDITOR_FONT,
          fontSize: "12px",
        },
        ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 14px", minWidth: "36px" },
        ".cm-activeLineGutter": { backgroundColor: "transparent", color: p.muted },
        ".cm-foldGutter .cm-gutterElement": { padding: "0 4px", cursor: "pointer", color: gutterText },
        ".cm-foldGutter .cm-gutterElement:hover": { color: p.text },
        ".cm-foldPlaceholder": {
          backgroundColor: withAlpha(p.bgAlt, 0.8),
          border: `1px solid ${withAlpha(p.border, 0.4)}`,
          color: p.dim,
          borderRadius: "3px",
          padding: "0 4px",
          margin: "0 2px",
        },
        ".cm-specialChar": { color: p.red },
        ".cm-tooltip": {
          backgroundColor: p.bg,
          color: p.text,
          border: `1px solid ${withAlpha(p.border, 0.5)}`,
          borderRadius: "4px",
          fontFamily: EDITOR_FONT,
          fontSize: "12px",
        },
        ".cm-completionIcon": { opacity: "0.6", width: "1.4em" },
        ".cm-completionMatchedText": { textDecoration: "none", color: p.cyan, fontWeight: "600" },
        // The bottom panel is the status bar (statusBar.ts).
        ".cm-panels.cm-panels-bottom": { borderTop: `1px solid ${withAlpha(p.border, 0.3)}`, backgroundColor: "transparent" },
        // Merge view (merge.ts) and the git diff: disk's lines above mine, a
        // button for each side. A tint that reads on cream vanishes on a dark
        // background, so a dark one gets a stronger one.
        ".cm-deletedChunk": { backgroundColor: withAlpha(p.red, diffTint(p, 0.08)), paddingLeft: "6px" },
        ".cm-deletedChunk .cm-deletedText": { backgroundColor: withAlpha(p.red, diffTint(p, 0.2)) },
        ".cm-changedLine": { backgroundColor: withAlpha(p.green, diffTint(p, 0.1)) },
        ".cm-changedText": { backgroundColor: withAlpha(p.green, diffTint(p, 0.22)) },
        ".cm-changedLineGutter": { backgroundColor: p.green },
        ".cm-deletedLineGutter": { backgroundColor: p.red },
        ".cm-chunkButtons": { position: "absolute", insetInlineEnd: "12px", display: "flex", gap: "4px", zIndex: "1" },
        ".cm-chunkButtons button": {
          fontFamily: EDITOR_FONT,
          fontSize: "11px",
          lineHeight: "1.4",
          padding: "0 6px",
          borderRadius: "3px",
          cursor: "pointer",
          border: `1px solid ${withAlpha(p.border, 0.5)}`,
          backgroundColor: p.bg,
          color: p.text,
        },
        ".cm-chunkButtons button:hover": { borderColor: p.cyan },
      },
      { dark: isDarkTheme() },
    ),
    codeHighlight(s, p),
  ];
});
