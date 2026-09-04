// Vault note markdown renderer: the shared MD component set with vault-aware
// links and images, plus Obsidian callouts.
//
// Wiki links carry their raw source in a wiki:// href (see remarkWikiLink).
// Resolution happens at render time through VaultLinkContext, so the parsed
// element tree stays cacheable while resolution can change as the vault index
// evolves (a new note can turn a dangling link live without a re-parse).

import { createContext, memo, useContext } from "react";
import Link from "next/link";
import ReactMarkdown, { defaultUrlTransform, type Components, type Options } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import "katex/dist/katex.min.css";
import { ChevronDown, ExternalLink } from "lucide-react";
import { CollapsibleImage } from "../tools/MarkdownRenderer";
import { MD_COMPONENTS } from "../../lib/markdownComponents";
import {
  parseWikiInner,
  vaultRemarkPlugins,
  wikiRawFromHref,
  WIKI_EMBED_SCHEME,
  WIKI_SCHEME,
  TAG_SCHEME,
  type WikiLinkParts,
} from "../../lib/vault/remarkWikiLink";
import { parseEntityRefHref, type VaultEntityRef } from "@codecast/shared/vault";
import { EntityIdPill } from "../EntityIdPill";
import { useInboxStore } from "../../store/inboxStore";
import { slugifyHeading } from "../../lib/vault/parseNote";
import { filesHref } from "../../lib/vault/vaultHref";
import { VAULT_HTML_SCHEMA, isAuthorityRelativeUrl } from "../../lib/vault/htmlPolicy";
// Render-time-only cycle with VaultHoverPreview (it renders VaultMarkdown
// inside the card); safe because neither module touches the other at eval.
import { useHoverPreview } from "./VaultHoverPreview";

export interface VaultLinkResolution {
  path: string | null;
  ambiguous?: boolean;
}

export interface VaultLinkContextValue {
  resolve: (target: string, parts?: WikiLinkParts) => VaultLinkResolution;
  navigate: (path: string, subpath?: string, subpathType?: "heading" | "block") => void;
  createNote?: (target: string) => void;
  /** Absolute URL for a vault-relative asset path (img src), null offline. */
  assetUrl: (path: string) => string | null;
  /** Open the tag pane focused on a tag (inline #tag pill click). */
  openTag?: (tag: string) => void;
  /** Render an embedded note body (depth-limited by the provider). */
  renderEmbed?: (parts: WikiLinkParts, resolvedPath: string | null) => React.ReactNode;
  /** Toggle the `- [ ]` / `- [x]` on a source line of THIS note. `line` is
   *  1-based in the rendered body, which starts below the frontmatter — the
   *  provider owns the offset back to the file. */
  toggleTask?: (line: number, checked: boolean) => void;
}

export const VaultLinkContext = createContext<VaultLinkContextValue | null>(null);

/** False inside a transclusion: the body rendered there belongs to a DIFFERENT
 *  note than the link context, so its line numbers would write to the wrong
 *  file. Checkboxes in embeds render, but don't take clicks. */
export const TaskEditContext = createContext(true);

/** The source line of the task item a checkbox sits in. react-markdown gives
 *  positions on the list item (the `input` mdast-util-to-hast synthesizes has
 *  none), so the item hands its line down to the checkbox. */
const TaskSourceLine = createContext<number | null>(null);

function WikiLinkAnchor({ href, children }: { href: string; children: React.ReactNode }) {
  const ctx = useContext(VaultLinkContext);
  const hover = useHoverPreview();
  const raw = wikiRawFromHref(href);
  const parts = raw ? parseWikiInner(raw) : null;
  if (!ctx || !parts) return <span>{children}</span>;

  const res = ctx.resolve(parts.target, parts);

  // Branch on the SCHEME, not parts.isEmbed: hoistWikiEmbeds demotes an
  // embed that sits inline in prose by rewriting its scheme to wiki://, and
  // that demotion must win here (a block transclusion card inside a <p> is
  // invalid HTML). The raw text still says "![[...]]" either way.
  if (href.startsWith(WIKI_EMBED_SCHEME) && ctx.renderEmbed) {
    return <>{ctx.renderEmbed(parts, res.path)}</>;
  }

  if (res.path) {
    return (
      <a
        href={filesHref({ path: res.path })}
        // Real href so middle-click and "copy link" behave, but the click is
        // handled here and moves the view through the store — no router
        // transition follows, so the navigation bar must not start.
        data-no-progress=""
        className={`wiki-link ${res.ambiguous ? "wiki-link-ambiguous" : ""}`}
        title={res.ambiguous ? `${res.path} (ambiguous — multiple matches)` : res.path}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.button === 1) return; // browser/tab handling
          e.preventDefault();
          hover?.onLinkLeave();
          ctx.navigate(res.path!, parts.subpath, parts.subpathType);
        }}
        onMouseEnter={(e) => hover?.onLinkEnter(e.currentTarget, res.path!)}
        onMouseLeave={() => hover?.onLinkLeave()}
      >
        {children}
      </a>
    );
  }

  // Unresolved: faded, click creates the note (when the provider allows it).
  return (
    <a
      href="#"
      className="wiki-link wiki-link-unresolved"
      title={ctx.createNote ? `"${parts.target}" does not exist yet — click to create` : `"${parts.target}" does not exist`}
      onClick={(e) => {
        e.preventDefault();
        ctx.createNote?.(parts.target);
      }}
    >
      {children}
    </a>
  );
}

/** A person reference. People have no `EntityType` and no id-addressed page, so
 *  EntityIdPill can't draw them; this is the same pill its `@name` mentions get
 *  (MentionPill in EntityIdPill.tsx, which isn't exported), resolved against the
 *  local team roster so it costs no query. An unknown username still renders —
 *  the handle is readable on its own. */
function PersonPill({ username }: { username: string }) {
  const member = useInboxStore((s) =>
    (s.teamMembers || []).find(
      (m: any) => (m.github_username || "").toLowerCase() === username.toLowerCase(),
    ),
  );
  return (
    <Link
      href={`/team/${encodeURIComponent(username)}`}
      className="not-prose inline-flex items-center gap-0.5 px-1.5 py-0 rounded text-[11px] font-medium leading-[1.4] bg-sol-blue/10 text-sol-blue border border-sol-blue/20 align-baseline no-underline"
    >
      @{member?.github_username || username}
    </Link>
  );
}

/** The pill a codecast object reference renders as — the same one a task id
 *  gets in a conversation, so a note and a message describe the object the same
 *  way. An id that resolves to nothing shows its own handle rather than an
 *  empty pill; a URL whose id could never name an object of that type never
 *  reaches here (parseEntityRefHref rejects it) and stays a plain link. */
export function EntityRefPill({
  refr,
  children,
}: {
  refr: VaultEntityRef;
  children?: React.ReactNode;
}) {
  if (refr.type === "person") return <PersonPill username={refr.id} />;
  return <EntityIdPill type={refr.type} id={refr.id} fallback={<span>{children ?? refr.id}</span>} />;
}

function VaultLink({ href, children, node: _node, ...props }: any) {
  const ctx = useContext(VaultLinkContext);
  const url: string = href ?? "";
  if (url.startsWith(TAG_SCHEME)) {
    const tag = decodeURIComponent(url.slice(TAG_SCHEME.length));
    return (
      <a
        href="#"
        className="vault-tag"
        onClick={(e) => {
          e.preventDefault();
          ctx?.openTag?.(tag);
        }}
      >
        {children}
      </a>
    );
  }
  if (url.startsWith(WIKI_SCHEME) || url.startsWith(WIKI_EMBED_SCHEME)) {
    return <WikiLinkAnchor href={url}>{children}</WikiLinkAnchor>;
  }
  // An ordinary markdown link to a codecast object URL. It stays a working link
  // in Obsidian, on GitHub and in any plain editor; here it becomes the pill.
  const entityRef = parseEntityRefHref(url);
  if (entityRef) {
    return <EntityRefPill refr={entityRef}>{children}</EntityRefPill>;
  }
  if (/^https?:\/\//i.test(url)) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="text-sol-blue hover:underline">
        {children}
        <ExternalLink className="inline w-3 h-3 ml-0.5 -mt-0.5 opacity-60" />
      </a>
    );
  }
  // Relative markdown link inside the vault ([text](Other%20Note.md)).
  if (ctx && /\.(md|markdown)(#.*)?$/i.test(url)) {
    const clean = decodeURIComponent(url.split("#")[0]);
    return (
      <a
        href={filesHref({ path: clean })}
        className="wiki-link"
        onClick={(e) => {
          e.preventDefault();
          ctx.navigate(clean);
        }}
      >
        {children}
      </a>
    );
  }
  return (
    <a href={url} rel="noopener noreferrer" {...props}>
      {children}
    </a>
  );
}

function VaultImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const ctx = useContext(VaultLinkContext);
  const raw = typeof src === "string" ? src : undefined;
  // Vault-relative asset → daemon-served URL; anything else takes the shared
  // remote-image click-to-load path.
  if (ctx && raw && !/^[a-z][a-z0-9+.-]*:/i.test(raw) && !raw.startsWith("//")) {
    const clean = decodeURIComponent(raw);
    const resolved = ctx.assetUrl(clean);
    // A path the vault itself resolved: the bytes come from this machine's own
    // daemon, so it is not the third party the click gate is defending against.
    if (resolved) return <CollapsibleImage src={resolved} alt={alt} trusted />;
  }
  return <CollapsibleImage src={src} alt={alt} />;
}

/** A GFM task item, made live: clicking the checkbox rewrites the bracket on
 *  the note's source line (Obsidian's behavior — reading mode is not read-only
 *  for tasks). Non-task items fall through to the shared renderer. */
function VaultListItem({ node, children }: any) {
  const ctx = useContext(VaultLinkContext);
  const editable = useContext(TaskEditContext);
  const className: unknown = node?.properties?.className;
  const isTask = Array.isArray(className) && className.includes("task-list-item");
  const line: unknown = node?.position?.start?.line;
  if (isTask && typeof line === "number") {
    const checked = !!node.children?.find((c: any) => c.tagName === "input")?.properties?.checked;
    return (
      <li
        className={`list-none -ml-4 ${checked ? "text-sol-text-muted" : "text-sol-text-secondary"}`}
        data-vault-task-line={line}
      >
        <TaskSourceLine.Provider value={editable && ctx?.toggleTask ? line : null}>
          {children}
        </TaskSourceLine.Provider>
      </li>
    );
  }
  const Base = MD_COMPONENTS.li as React.ComponentType<{ children?: React.ReactNode }> | undefined;
  return Base ? <Base>{children}</Base> : <li>{children}</li>;
}

function VaultCheckbox({ type, checked }: { type?: string; checked?: boolean }) {
  const ctx = useContext(VaultLinkContext);
  const line = useContext(TaskSourceLine);
  if (type !== "checkbox") return null;
  if (line === null || !ctx?.toggleTask) {
    return <input type="checkbox" checked={!!checked} disabled readOnly className="mr-1.5 align-middle" />;
  }
  return (
    <input
      type="checkbox"
      checked={!!checked}
      onChange={(e) => ctx.toggleTask!(line, e.target.checked)}
      className="mr-1.5 align-middle cursor-pointer accent-[var(--sol-cyan)]"
    />
  );
}

const CALLOUT_STYLES: Record<string, { border: string; accent: string; label: string }> = {
  note: { border: "var(--sol-blue)", accent: "var(--sol-blue)", label: "Note" },
  info: { border: "var(--sol-blue)", accent: "var(--sol-blue)", label: "Info" },
  tip: { border: "var(--sol-cyan)", accent: "var(--sol-cyan)", label: "Tip" },
  hint: { border: "var(--sol-cyan)", accent: "var(--sol-cyan)", label: "Hint" },
  important: { border: "var(--sol-cyan)", accent: "var(--sol-cyan)", label: "Important" },
  summary: { border: "var(--sol-cyan)", accent: "var(--sol-cyan)", label: "Summary" },
  abstract: { border: "var(--sol-cyan)", accent: "var(--sol-cyan)", label: "Abstract" },
  todo: { border: "var(--sol-blue)", accent: "var(--sol-blue)", label: "Todo" },
  success: { border: "var(--sol-green)", accent: "var(--sol-green)", label: "Success" },
  check: { border: "var(--sol-green)", accent: "var(--sol-green)", label: "Check" },
  done: { border: "var(--sol-green)", accent: "var(--sol-green)", label: "Done" },
  question: { border: "var(--sol-yellow)", accent: "var(--sol-yellow)", label: "Question" },
  help: { border: "var(--sol-yellow)", accent: "var(--sol-yellow)", label: "Help" },
  faq: { border: "var(--sol-yellow)", accent: "var(--sol-yellow)", label: "FAQ" },
  warning: { border: "var(--sol-orange)", accent: "var(--sol-orange)", label: "Warning" },
  caution: { border: "var(--sol-orange)", accent: "var(--sol-orange)", label: "Caution" },
  attention: { border: "var(--sol-orange)", accent: "var(--sol-orange)", label: "Attention" },
  failure: { border: "var(--sol-red)", accent: "var(--sol-red)", label: "Failure" },
  fail: { border: "var(--sol-red)", accent: "var(--sol-red)", label: "Failure" },
  missing: { border: "var(--sol-red)", accent: "var(--sol-red)", label: "Missing" },
  danger: { border: "var(--sol-red)", accent: "var(--sol-red)", label: "Danger" },
  error: { border: "var(--sol-red)", accent: "var(--sol-red)", label: "Error" },
  bug: { border: "var(--sol-red)", accent: "var(--sol-red)", label: "Bug" },
  example: { border: "var(--sol-violet)", accent: "var(--sol-violet)", label: "Example" },
  quote: { border: "var(--sol-text-dim)", accent: "var(--sol-text-dim)", label: "Quote" },
  cite: { border: "var(--sol-text-dim)", accent: "var(--sol-text-dim)", label: "Quote" },
};

// Matches ONLY the marker line: `[!type]`, `[!type]+`/`-` (fold markers),
// optional title after it. Applied to the FIRST LINE of the first text node —
// remark keeps soft line breaks inside one text node, so `> [!note] Title`
// followed by `> Body` arrives as "[!note] Title\nBody" and a whole-string
// anchor either fails to match or swallows the body.
const CALLOUT_RE = /^\[!(\w+)\][+-]?[ \t]*(.*)$/;

/** The first paragraph's leading text node, split into its first line and the
 *  remainder of that same text node. */
function firstLineOf(children: any): { firstLine: string; restOfNode: string } | null {
  const arr = Array.isArray(children) ? children : [children];
  for (const child of arr) {
    // react-markdown interleaves whitespace-only text children ("\n") between
    // block elements — skip them or the marker paragraph is never reached.
    if (typeof child === "string") {
      if (!child.trim()) continue;
      const nl = child.indexOf("\n");
      return nl === -1
        ? { firstLine: child, restOfNode: "" }
        : { firstLine: child.slice(0, nl), restOfNode: child.slice(nl + 1) };
    }
    if (child?.props?.node?.tagName === "p" || child?.type === "p") {
      const pChildren = child.props?.children;
      const pArr = Array.isArray(pChildren) ? pChildren : [pChildren];
      if (typeof pArr[0] !== "string") return null;
      const nl = pArr[0].indexOf("\n");
      return nl === -1
        ? { firstLine: pArr[0], restOfNode: "" }
        : { firstLine: pArr[0].slice(0, nl), restOfNode: pArr[0].slice(nl + 1) };
    }
    // Any other element before a paragraph means no marker line.
    return null;
  }
  return null;
}

function VaultBlockquote({ children }: { children?: React.ReactNode }) {
  // Obsidian callout: blockquote whose first line is `[!type] optional title`.
  const first = firstLineOf(children);
  const match = first?.firstLine.match(CALLOUT_RE);
  if (match && first) {
    const kind = match[1].toLowerCase();
    const style = CALLOUT_STYLES[kind] ?? CALLOUT_STYLES.note;
    const title = match[2] || style.label;
    const arr = Array.isArray(children) ? children : [children];
    const firstParaIdx = arr.findIndex((c: any) => c?.props?.node?.tagName === "p" || c?.type === "p");
    // Rebuild the first paragraph with only the marker LINE removed; every
    // following line and inline element stays.
    const body = arr.map((child: any, i: number) => {
      if (i !== firstParaIdx) return child;
      const pChildren = child.props?.children;
      const pArr = Array.isArray(pChildren) ? pChildren : [pChildren];
      const rebuilt = [first.restOfNode, ...pArr.slice(1)].filter(
        (r: any) => r !== "" && r != null,
      );
      if (!rebuilt.length) return null;
      return <p key={i}>{rebuilt}</p>;
    });
    return (
      <div
        className="my-3 rounded border-l-[3px] px-3 py-2"
        style={{
          borderLeftColor: style.border,
          background: `color-mix(in srgb, ${style.accent} 7%, transparent)`,
        }}
      >
        <div className="text-xs font-semibold mb-1" style={{ color: style.accent }}>
          {title}
        </div>
        <div className="text-sm text-sol-text-secondary [&>p]:my-1">{body}</div>
      </div>
    );
  }
  return (
    <blockquote className="border-l-2 border-sol-border pl-3 my-2 text-sol-text-muted italic">
      {children}
    </blockquote>
  );
}

// Preserve wiki:// and wikiembed:// hrefs (the payload carriers); everything
// else goes through react-markdown's standard sanitizer, plus the vault's own
// rule against authority-relative references (`//evil.com`), which look
// relative to a scheme allowlist and so slip past every one of them.
function vaultUrlTransform(url: string): string {
  if (url.startsWith(WIKI_SCHEME) || url.startsWith(WIKI_EMBED_SCHEME) || url.startsWith(TAG_SCHEME)) return url;
  if (isAuthorityRelativeUrl(url)) return "";
  return defaultUrlTransform(url);
}

function hastText(node: any): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  if (Array.isArray(node.children)) return node.children.map(hastText).join("");
  return "";
}

/** Rehype pass stamping `id="vh-<slug>"` on headings, DEDUPED in document
 *  order with the same rule as the index engine's headingSlugs (first
 *  occurrence bare, repeats -2/-3…). Duplicate heading texts previously
 *  collided into duplicate DOM ids, breaking the outline and heading links
 *  for every occurrence past the first (review finding, R5). */
function rehypeVaultHeadingIds() {
  const HEADING = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
  return (tree: any) => {
    const seen = new Map<string, number>();
    const walk = (node: any) => {
      if (node?.type === "element" && HEADING.has(node.tagName)) {
        const base = slugifyHeading(hastText(node));
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        node.properties = { ...node.properties, id: `vh-${n === 1 ? base : `${base}-${n}`}` };
      }
      if (Array.isArray(node?.children)) node.children.forEach(walk);
    };
    walk(tree);
  };
}

/** Heading components render the id the rehype pass computed (never their own
 *  — per-component slugs can't see document order, which dedupe requires).
 *  Each heading also carries a fold toggle: clicking the chevron hides every
 *  sibling element until the next heading of the same or higher level, the way
 *  Obsidian's reading view folds a section. Fold state is CSS-only (a data
 *  attribute plus a sibling selector), so it survives re-renders without any
 *  React state keyed to positions that shift when the note changes. */
/** Which sections are folded, keyed by note path + heading id. Session-lived
 *  and outside React: folds are a view gesture, and rebuilding them from state
 *  on every keystroke of an unrelated note would be churn for nothing. */
const foldedSections = new Set<string>();

/** The note a rendered body belongs to, so fold state is keyed per note. A
 *  context rather than a module variable: refs attach bottom-up, so a heading
 *  would otherwise read the PREVIOUS note's scope and never restore its fold. */
export const FoldScopeContext = createContext("");

function applyFold(h: HTMLElement, level: number, folded: boolean) {
  h.setAttribute("data-folded", folded ? "true" : "false");
  let el = h.nextElementSibling as HTMLElement | null;
  while (el) {
    const lvl = el.getAttribute?.("data-vault-level");
    if (lvl && Number(lvl) <= level) break;
    el.style.display = folded ? "none" : "";
    el = el.nextElementSibling as HTMLElement | null;
  }
}

function anchoredHeading(Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6", className: string) {
  const level = Number(Tag.slice(1));
  return function VaultHeading({ id, children }: { id?: string; children?: React.ReactNode }) {
    const scope = useContext(FoldScopeContext);
    const key = `${scope}::${id ?? ""}`;
    // Re-apply a remembered fold once this heading's siblings exist in the DOM.
    const ref = (node: HTMLElement | null) => {
      if (!node) return;
      if (foldedSections.has(key)) requestAnimationFrame(() => applyFold(node, level, true));
    };
    return (
      <Tag ref={ref as never} id={id} className={`vault-heading ${className}`} data-vault-level={level}>
        <button
          type="button"
          className="vault-fold-toggle"
          aria-label="Fold section"
          onClick={(e) => {
            const h = e.currentTarget.parentElement as HTMLElement | null;
            if (!h) return;
            const nowFolded = h.getAttribute("data-folded") !== "true";
            applyFold(h, level, nowFolded);
            if (nowFolded) foldedSections.add(key);
            else foldedSections.delete(key);
          }}
        >
          <ChevronDown className="w-3 h-3" />
        </button>
        {children}
      </Tag>
    );
  };
}

// ORDER IS THE SECURITY PROPERTY. rehypeRaw parses the note's inline HTML —
// arbitrary bytes from an arbitrary repo — and rehypeSanitize immediately cuts
// that tree down to lib/vault/htmlPolicy's allowlist. Everything after runs on
// an already-safe tree, which is also why highlight/KaTeX/heading-id markup
// (classes and MathML the schema would never admit) survives untouched.
//
// Nothing here bypasses the vault's own components: the sanitized `img` and `a`
// still render through VaultImage/VaultLink, so an HTML `<img>` gets the same
// vault-relative asset resolution and the same third-party click gate as a
// markdown one.
// Not `as const`: react-markdown's prop is a mutable PluggableList, and the
// referential stability the memo needs comes from this being a module constant,
// not from deep readonliness.
const VAULT_REHYPE_PLUGINS: NonNullable<Options["rehypePlugins"]> = [
  rehypeRaw,
  [rehypeSanitize, VAULT_HTML_SCHEMA],
  rehypeHighlight,
  rehypeKatex,
  rehypeVaultHeadingIds,
];
const VAULT_COMPONENTS: Components = {
  ...MD_COMPONENTS,
  a: VaultLink,
  img: VaultImage,
  blockquote: VaultBlockquote,
  li: VaultListItem,
  input: VaultCheckbox,
  h1: anchoredHeading("h1", "text-lg font-bold mt-0 mb-3 text-sol-text"),
  h2: anchoredHeading("h2", "text-base font-semibold mt-4 mb-2 text-sol-text"),
  h3: anchoredHeading("h3", "text-sm font-semibold mt-3 mb-1 text-sol-text-muted"),
  h4: anchoredHeading("h4", "text-sm font-semibold mt-3 mb-1 text-sol-text-muted"),
  h5: anchoredHeading("h5", "text-[13px] font-semibold mt-2 mb-1 text-sol-text-muted"),
  h6: anchoredHeading("h6", "text-[13px] font-semibold mt-2 mb-1 text-sol-text-dim"),
  // Obsidian tables size to their content, not the container.
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="overflow-x-auto my-3">
      <table className="w-auto text-xs border-collapse border border-sol-border/50">{children}</table>
    </div>
  ),
};

export const VaultMarkdown = memo(function VaultMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={vaultRemarkPlugins}
      rehypePlugins={VAULT_REHYPE_PLUGINS}
      components={VAULT_COMPONENTS}
      urlTransform={vaultUrlTransform}
    >
      {content}
    </ReactMarkdown>
  );
});
