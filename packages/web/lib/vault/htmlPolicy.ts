// What raw HTML a vault note is allowed to render, and which URLs it may name.
//
// Vault files are ARBITRARY files from ARBITRARY repositories: a user clones a
// hostile repo, opens it in Files, and the README renders. So the markdown is
// attacker-controlled and this module is a security boundary, not a formatting
// convenience.
//
// It exists because almost every README opens with presentational HTML — a
// centered logo, a row of badge images, a `<details>` block — and a renderer
// with no HTML support prints those tags as literal text, so the first screen
// of every project looked broken.
//
// THE BOUNDARY IS ONE PASS: `rehype-raw` parses the raw HTML with a real HTML5
// parser (parse5), then `rehype-sanitize` reduces the tree to the allowlist
// below. Nothing downstream re-admits anything: the trusted rehype passes
// (highlight, KaTeX, heading ids) run AFTER sanitize, so their own classes and
// markup are never subject to it, and no second sanitizer runs over the result.
// There is no `dangerouslySetInnerHTML` anywhere on this path — the sanitized
// tree becomes React elements, which is what lets `<img>` and `<a>` land on the
// vault's own components and inherit the remote-image click gate.
//
// Two rules to keep in mind when editing the schema:
//
//  1. Attribute names are HAST property names (`colSpan`, `className`), not
//     HTML attribute names (`colspan`, `class`).
//  2. A per-tag definition that REJECTS a value falls through to the `'*'`
//     defaults. So pinning a value (`input`'s `type` to `checkbox`) only holds
//     if that attribute name is absent from `'*'`.

import type { Options as SanitizeSchema } from "rehype-sanitize";

/** URL schemes an `href` may name. `wiki`/`wikiembed`/`vaulttag` are the
 *  renderer's own payload carriers (see remarkWikiLink) and never reach the
 *  network; the rest are the three a document legitimately links out with.
 *  `data:` is absent on purpose — see the note on the schema below. */
const HREF_PROTOCOLS = ["http", "https", "mailto", "wiki", "wikiembed", "vaulttag"];

/** An `src` may only be a vault-relative path or a plain web URL. */
const SRC_PROTOCOLS = ["http", "https"];

// A reference with no scheme but an authority — `//evil.com`, plus the `\\`
// and whitespace-prefixed forms a browser normalizes into it. It names a third
// party while looking relative, so a scheme allowlist never gets to judge it.
// `\x00-\x20` is every leading byte a browser strips before parsing a URL.
const AUTHORITY_RELATIVE_RE = /^[\x00-\x20]*[/\\]{2}/;
// The same rule as an allowlist entry: any value that is NOT authority-relative.
const NOT_AUTHORITY_RELATIVE = /^(?![\x00-\x20]*[/\\]{2})/;

/** True for a URL the vault refuses to point at. Used by the sanitize schema
 *  AND by the renderer's `urlTransform` — one rule, applied at both points a
 *  URL can enter the DOM. */
export function isAuthorityRelativeUrl(url: string): boolean {
  return AUTHORITY_RELATIVE_RE.test(url);
}

// Tags whose CONTENT must die with them. Anything not in `tagNames` is
// unwrapped by default (children promoted), which is right for a stray
// `<span class=…>` but wrong for the HTML parser's raw-text elements:
// unwrapping `<style>` or `<iframe>` spills their source into the page as
// prose. `form` is here because a form in a README is never legitimate.
const STRIP_WITH_CONTENT = [
  "script",
  "style",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "xmp",
  "plaintext",
  "textarea",
  "title",
  "template",
  "form",
  "svg",
  "math",
  "object",
  "embed",
  "applet",
  "link",
  "meta",
  "base",
  "head",
  "frame",
  "frameset",
];

/**
 * The allowlist. Everything not named here is removed.
 *
 * Deliberately absent, beyond the obvious script vectors:
 *
 *  - `style`, `class` and `id` as author-controlled attributes. A `style` is a
 *    full-page overlay away from clickjacking (`position:fixed;inset:0`), and
 *    an arbitrary `class` reaches whatever utilities the app's stylesheet
 *    happens to ship. The few classes below are pinned to exact values the
 *    markdown pipeline itself emits, and `id` to the footnote namespace.
 *  - Every `on*` handler, by construction: an allowlist admits names, so no
 *    casing trick (`OnErRoR`) reaches the DOM.
 *  - `srcset` and `<source>`. A `<source>` fetches the moment it renders and
 *    cannot be held behind the click gate the way an `<img>` can, so allowing
 *    it would reopen the tracking-pixel channel that gate exists to close.
 *    `<picture>` stays allowed and its `<img>` fallback renders normally, so a
 *    theme-switching README logo still shows its light-mode image.
 *  - `data:` URIs. `data:image/svg+xml` is a script vector, and telling the
 *    safe image subtypes apart means parsing attacker-chosen MIME text for a
 *    form no README needs.
 */
export const VAULT_HTML_SCHEMA: SanitizeSchema = {
  tagNames: [
    // Presentational HTML that READMEs actually open with.
    "p", "div", "span", "a", "img", "br", "hr",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "strong", "b", "em", "i", "code", "pre", "blockquote",
    "ul", "ol", "li",
    "table", "thead", "tbody", "tr", "th", "td",
    "kbd", "sub", "sup", "small", "center", "picture",
    "details", "summary",
    // Emitted by the markdown pipeline itself, not by note authors: GFM
    // strikethrough, task-list checkboxes, and the footnotes section.
    "del", "input", "section",
  ],

  attributes: {
    a: [
      // Rejects `//evil.com`; `protocols` below rejects every bad scheme.
      ["href", NOT_AUTHORITY_RELATIVE],
      // GFM footnote scaffolding.
      "ariaLabel",
      ["ariaDescribedBy", "footnote-label"],
      "dataFootnoteRef",
      "dataFootnoteBackref",
      ["className", "data-footnote-backref"],
      ["id", /^user-content-fnref-\d+$/],
    ],
    img: [["src", NOT_AUTHORITY_RELATIVE], "alt"],
    ol: ["start", "type"],
    // `language-*` drives syntax highlighting; `math-*` is how remark-math
    // marks a formula for KaTeX, which runs after this pass.
    code: [["className", /^language-./, "math-inline", "math-display"]],
    li: [["className", "task-list-item"], ["id", /^user-content-fn-\d+$/]],
    ul: [["className", "contains-task-list"]],
    h2: [["className", "sr-only"], ["id", "footnote-label"]],
    section: [["className", "footnotes"], "dataFootnotes"],
    td: ["colSpan", "rowSpan"],
    th: ["colSpan", "rowSpan"],
    details: ["open"],
    // Pinned, and none of these three names appear in `'*'`, so a raw
    // `<input type="text">` cannot fall through to a permissive default.
    input: [["type", "checkbox"], ["disabled", true], ["checked", true]],
    "*": ["align", "width", "height", "title"],
  },

  protocols: { href: HREF_PROTOCOLS, src: SRC_PROTOCOLS },

  // Any `input` that survives is forced back to a disabled checkbox.
  required: { input: { disabled: true, type: "checkbox" } },

  strip: STRIP_WITH_CONTENT,

  // Comments are dropped, which also disposes of the `--><script>` trick: the
  // parser has already resolved where the comment ends before this pass sees a
  // tree, so the script is a real element by then, and `strip` takes it.
  allowComments: false,
  allowDoctypes: false,

  // No prefix, because no attacker-chosen `id` survives the allowlist above —
  // the only ids that pass are the footnote ones the pipeline emits, which
  // arrive already namespaced and would otherwise be prefixed a second time,
  // breaking every footnote link.
  clobberPrefix: "",
};
