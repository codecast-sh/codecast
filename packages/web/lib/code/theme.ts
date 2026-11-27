// The app's look for CodeMirror: one palette read off the --sol-* tokens, the
// chrome both editors share (cursor, selection, search panel, tooltips), the
// notes theme VaultEditor uses, and the code theme the code editor uses.
//
// CodeMirror themes are injected as real CSS rules built from literal values,
// and every built theme mounts a style module that stays in the document. So
// each theme is built once per palette (perPalette) and every editor shares
// it; a light/dark flip builds the other one. The code highlight style paints
// the same var(--hljs-*) colors the Prism CSS in globals.css gives `.token.*`,
// so a file reads the same in a transcript's code block and in the editor
// (codeHighlightParity.test.ts tokenizes both and compares every character).

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, languageDataProp, syntaxHighlighting, type Language, type TagStyle } from "@codemirror/language";
import { tags as t, type Highlighter } from "@lezer/highlight";

/** A tree's node type, as a highlighter's scope receives it. */
type NodeType = Parameters<NonNullable<Highlighter["scope"]>>[0];
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
/** The four kinds of highlight an editor draws, each its own look so none
 *  reads as another: the selection (blue, grey once the editor loses focus),
 *  every search hit (yellow), the current hit (stronger yellow, outlined), and
 *  the other places the word under the cursor appears (a faint neutral).
 *  Cyan stays the cursor's. The multibuffer and vim's visual mode read these
 *  too. */
export const HIGHLIGHT = {
  selection: "color-mix(in srgb, var(--sol-blue) 22%, transparent)",
  selectionBlurred: "color-mix(in srgb, var(--sol-text) 9%, transparent)",
  match: "color-mix(in srgb, var(--sol-yellow) 22%, transparent)",
  currentMatch: "color-mix(in srgb, var(--sol-yellow) 45%, transparent)",
  currentMatchOutline: "1px solid var(--sol-yellow)",
  word: "color-mix(in srgb, var(--sol-text) 8%, transparent)",
} as const;

/** Every surface that floats over the text (tooltips, completion, the
 *  language overlays, the git ref menu): the app's popover card, lifted by
 *  its popover shadow, one radius. The fallbacks serve the styles that do not
 *  define those tokens. */
export const OVERLAY = {
  backgroundColor: "var(--sol-card)",
  color: "var(--sol-text)",
  border: "1px solid color-mix(in srgb, var(--sol-border) 60%, transparent)",
  borderRadius: "6px",
  boxShadow: "var(--shadow-popover, 0 1px 2px rgb(0 0 0 / 0.08), 0 8px 20px -6px rgb(0 0 0 / 0.28))",
} as const;

function chromeSpec(p: Palette) {
  return {
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: p.cyan, borderLeftWidth: "2px" },
    // The editor holding the keys shows its selection and its line; one that
    // does not greys the selection and drops the line band, so of two split
    // panes only one looks live.
    ".cm-selectionBackground, .cm-content ::selection": { backgroundColor: HIGHLIGHT.selectionBlurred },
    "&.cm-focused .cm-selectionBackground, &.cm-focused .cm-content ::selection": { backgroundColor: HIGHLIGHT.selection },
    ".cm-activeLine": { backgroundColor: "transparent" },
    "&.cm-focused .cm-activeLine": { backgroundColor: withAlpha(p.bgAlt, 0.5) },
    ".cm-selectionMatch": { backgroundColor: HIGHLIGHT.word },
    ".cm-searchMatch": { backgroundColor: HIGHLIGHT.match },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: HIGHLIGHT.currentMatch, outline: HIGHLIGHT.currentMatchOutline },
    // A hit under the selection is still a hit.
    ".cm-searchMatch .cm-selectionMatch, .cm-selectionMatch .cm-searchMatch": { backgroundColor: "transparent" },
    ".cm-matchingBracket, .cm-nonmatchingBracket": {
      backgroundColor: "transparent",
      outline: `1px solid ${withAlpha(p.border, 0.9)}`,
      borderRadius: "1px",
    },
    "&.cm-focused .cm-nonmatchingBracket": { outlineColor: p.red },
    ".cm-panels": {
      backgroundColor: p.bgAlt,
      color: p.text,
      border: "none",
      fontFamily: EDITOR_FONT,
    },
    ".cm-panels.cm-panels-top": { borderBottom: `1px solid ${withAlpha(p.border, 0.4)}` },
    // Chrome type for the search panel's labels and buttons; the query
    // fields keep the editor's face, since what is typed there is code.
    ".cm-panel.cm-search": { padding: "6px 8px", fontFamily: "var(--font-ui)", fontSize: "var(--fs-meta)", lineHeight: "16px" },
    ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": {
      fontFamily: "inherit",
      fontSize: "var(--fs-meta)",
    },
    ".cm-panel.cm-search input[type=text]": {
      fontFamily: EDITOR_FONT,
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
    // The completion docs panel sits outside its tooltip, so nothing clips.
    ".cm-tooltip": { ...OVERLAY, fontFamily: EDITOR_FONT, fontSize: "12px" },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li:first-child": { borderRadius: "5px 5px 0 0" },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li:last-child": { borderRadius: "0 0 5px 5px" },
    ".cm-tooltip.cm-tooltip-autocomplete > ul": {
      fontFamily: EDITOR_FONT,
      fontSize: "12px",
      maxHeight: "16em",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "3px 8px", color: p.text },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: withAlpha(p.cyan, 0.16),
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

// ── syntax colors ───────────────────────────────────────────────────────────

/** The colors the Prism CSS in globals.css paints `.token.*` with, written as
 *  the same var() so a theme change repaints both without a rebuild. */
export const SYNTAX = {
  plain: "var(--sol-text-secondary)",
  keyword: "var(--hljs-keyword)",
  string: "var(--hljs-string)",
  number: "var(--hljs-number)",
  fn: "var(--hljs-function)",
  comment: "var(--hljs-comment)",
  type: "var(--hljs-type)",
  variable: "var(--hljs-variable)",
  punctuation: "var(--sol-text-muted)",
} as const;

/** Lezer tags to the Prism token classes, color for color. Each line names
 *  the Prism classes it stands for. */
export const CODE_HIGHLIGHT: readonly TagStyle[] = [
  // .token.comment, .prolog, .doctype, .cdata
  { tag: [t.comment, t.docComment], color: SYNTAX.comment, fontStyle: "italic" },
  // .token.punctuation
  { tag: [t.punctuation, t.bracket, t.separator, t.derefOperator], color: SYNTAX.punctuation },
  // .token.keyword, .atrule; `null`, `this` and `super` are keywords to Prism
  {
    tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword, t.modifier, t.self, t.null, t.meta, t.annotation, t.processingInstruction],
    color: SYNTAX.keyword,
  },
  // .token.string, .attr-value, .template-string
  { tag: [t.string, t.special(t.string), t.attributeValue, t.docString], color: SYNTAX.string },
  // .token.number, .boolean, .constant, .symbol, .tag, .property (object keys)
  { tag: [t.number, t.bool, t.atom, t.unit, t.constant(t.variableName), t.tagName, t.definition(t.propertyName)], color: SYNTAX.number },
  // .token.function, .class-name
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.className, t.typeName, t.labelName, t.macroName],
    color: SYNTAX.fn,
  },
  // .token.builtin, .attr-name, .selector, .char
  { tag: [t.standard(t.variableName), t.standard(t.typeName), t.attributeName, t.character, t.namespace], color: SYNTAX.type },
  // .token.regex, .important, .variable
  { tag: [t.regexp, t.escape, t.special(t.variableName)], color: SYNTAX.variable },
  // .token.operator, .entity, .url
  { tag: [t.operator, t.url], color: SYNTAX.plain },
  // Markup inside code files: a heading is Prism's `title important`.
  { tag: t.heading, fontWeight: "700", color: SYNTAX.variable },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: SYNTAX.string, textDecoration: "underline" },
  { tag: t.inserted, color: "var(--sol-green)" },
  { tag: t.deleted, color: "var(--sol-red)" },
  { tag: t.changed, color: "var(--sol-yellow)" },
  { tag: t.invalid, color: "var(--sol-red)" },
];

/** Where a language's grammar names a thing the shared map colors another
 *  way: Prism gives each language its own token names, so a property is a
 *  key's color in CSS and JSON, a YAML key is an `atrule`, and every part of a
 *  CSS selector is one `selector`. Keyed by the language's name in
 *  languages.ts; these specs win over the shared ones for that language. */
const SCRIPT: readonly TagStyle[] = [
  // `:`, `=>` and `...` are Prism operators; `super` a keyword.
  { tag: t.punctuation, color: SYNTAX.plain },
  { tag: t.atom, color: SYNTAX.keyword },
];
/** Prism's TypeScript drops JavaScript's `literal-property`, so a key in a
 *  .ts block is plain. */
const TYPESCRIPT: readonly TagStyle[] = [...SCRIPT, { tag: t.definition(t.propertyName), color: SYNTAX.plain }];

export const CODE_LANGUAGE_HIGHLIGHT: Readonly<Record<string, readonly TagStyle[]>> = {
  JavaScript: SCRIPT,
  JSX: SCRIPT,
  TypeScript: TYPESCRIPT,
  TSX: TYPESCRIPT,
  JSON: [{ tag: t.propertyName, color: SYNTAX.number }],
  CSS: [
    { tag: t.propertyName, color: SYNTAX.number },
    { tag: [t.className, t.tagName, t.labelName, t.constant(t.className), t.attributeName], color: SYNTAX.type },
  ],
  YAML: [{ tag: t.definition(t.propertyName), color: SYNTAX.keyword }],
  // `#`, `**`, `_` and list bullets.
  Markdown: [{ tag: t.processingInstruction, color: SYNTAX.punctuation }],
};

const sharedStyle = HighlightStyle.define(CODE_HIGHLIGHT as TagStyle[]);
/** Each language's full style: the shared specs, then its own. */
const languageStyles = new Map(
  Object.entries(CODE_LANGUAGE_HIGHLIGHT).map(([name, own]) => [name, HighlightStyle.define([...CODE_HIGHLIGHT, ...own] as TagStyle[])]),
);
/** A loaded language's data facet to its style (registerCodeLanguage). */
const styleByData = new WeakMap<object, HighlightStyle>();

/** Called as a language loads (languages.ts), so its trees take its style. */
export function registerCodeLanguage(name: string, language: Language): void {
  const style = languageStyles.get(name);
  if (style) styleByData.set(language.data, style);
}

function styleFor(type: NodeType): HighlightStyle {
  const data = type.prop(languageDataProp);
  return (data && styleByData.get(data)) || sharedStyle;
}

/** One highlighter per style, each owning the trees whose language it is for,
 *  so exactly one colors any tree (a language nested in another keeps its
 *  own). Two highlighters on one tree would add their classes together and
 *  leave the color to stylesheet order. The multibuffer highlights its
 *  excerpts with these. */
/** Every code highlight style, the shared one first. */
export const CODE_HIGHLIGHT_STYLES: readonly HighlightStyle[] = [sharedStyle, ...languageStyles.values()];

export const CODE_HIGHLIGHTERS: readonly Highlighter[] = CODE_HIGHLIGHT_STYLES.map((hs) => ({
  style: (tags) => hs.style(tags),
  scope: (type: NodeType) => styleFor(type) === hs,
}));

/** Only a HighlightStyle brings its stylesheet along, so they mount here. */
const codeHighlight: Extension = [
  ...CODE_HIGHLIGHTERS.map((h) => syntaxHighlighting(h)),
  ...CODE_HIGHLIGHT_STYLES.map((hs) => EditorView.styleModule.of(hs.module!)),
];

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
        // Plain identifiers in the ink a transcript's code block uses.
        "&": {
          color: SYNTAX.plain,
          backgroundColor: "transparent",
          fontSize: "13px",
          height: "100%",
          [CODE_CURSOR_VAR]: p.cyan,
          [CODE_CURSOR_BLOCK_VAR]: cursorBlock.block,
          [CODE_CURSOR_TEXT_VAR]: cursorBlock.letter,
        },
        // A whole-pixel line box (13px at 1.6, rounded), shared by the text
        // and the smaller gutter type, so both center on one row and every
        // row starts on a device pixel. Settings > Editor rounds the same way
        // (codeLineHeightPx in setup.ts).
        ".cm-scroller": { fontFamily: EDITOR_FONT, lineHeight: "21px" },
        ".cm-content": { caretColor: p.cyan, padding: "6px 0" },
        ".cm-line": { padding: "0 16px 0 6px" },
        ...chromeSpec(p),
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: `var(${CODE_CURSOR_VAR})`, borderLeftWidth: "2px" },
        ".cm-gutters": {
          backgroundColor: "transparent",
          color: gutterText,
          border: "none",
          fontFamily: EDITOR_FONT,
          fontSize: "12px",
        },
        ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 14px", minWidth: "36px" },
        ".cm-activeLineGutter": { backgroundColor: "transparent" },
        "&.cm-focused .cm-activeLineGutter": { color: p.muted },
        ".cm-foldGutter .cm-gutterElement": {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "16px",
          cursor: "pointer",
          color: gutterText,
        },
        ".cm-foldGutter .cm-gutterElement:hover": { color: p.text },
        ".cm-fold-marker": { display: "flex" },
        ".cm-fold-marker[data-fold=open]": { opacity: "0", transition: "opacity 120ms" },
        ".cm-gutters:hover .cm-fold-marker[data-fold=open], .cm-activeLineGutter .cm-fold-marker[data-fold=open]": { opacity: "1" },
        ".cm-foldPlaceholder": {
          backgroundColor: withAlpha(p.bgAlt, 0.8),
          border: `1px solid ${withAlpha(p.border, 0.4)}`,
          color: p.dim,
          borderRadius: "3px",
          padding: "0 4px",
          margin: "0 2px",
        },
        ".cm-specialChar": { color: p.red },
        ".cm-completionIcon": { opacity: "0.6", width: "1.4em" },
        ".cm-completionMatchedText": { textDecoration: "none", color: p.cyan, fontWeight: "600" },
        // The bottom panel is the status bar (statusBar.ts).
        ".cm-panels.cm-panels-bottom": { borderTop: `1px solid ${withAlpha(p.border, 0.3)}`, backgroundColor: "transparent" },
        // Merge view (merge.ts) and the git diff: disk's lines above mine, a
        // button for each side. The tints are the app's diff tints
        // (globals.css --diff-*), the ones every diff card draws.
        ".cm-deletedChunk": { backgroundColor: "var(--diff-del-line)", paddingLeft: "6px" },
        ".cm-deletedChunk .cm-deletedText": { backgroundColor: "var(--diff-del-word)" },
        ".cm-changedLine": { backgroundColor: "var(--diff-add-line)" },
        ".cm-changedText": { backgroundColor: "var(--diff-add-word)" },
        // The split view's old side marks what left.
        "&.cm-merge-a .cm-changedLine": { backgroundColor: "var(--diff-del-line)" },
        "&.cm-merge-a .cm-changedText": { backgroundColor: "var(--diff-del-word)" },
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
    codeHighlight,
  ];
});
