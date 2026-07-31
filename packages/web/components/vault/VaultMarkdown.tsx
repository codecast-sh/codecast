// Vault note markdown renderer: the shared MD component set with vault-aware
// links and images, plus Obsidian callouts.
//
// Wiki links carry their raw source in a wiki:// href (see remarkWikiLink).
// Resolution happens at render time through VaultLinkContext, so the parsed
// element tree stays cacheable while resolution can change as the vault index
// evolves (a new note can turn a dangling link live without a re-parse).

import { createContext, memo, useContext } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import { ExternalLink } from "lucide-react";
import { MD_COMPONENTS, CollapsibleImage } from "../tools/MarkdownRenderer";
import {
  parseWikiInner,
  vaultRemarkPlugins,
  wikiRawFromHref,
  WIKI_EMBED_SCHEME,
  WIKI_SCHEME,
  type WikiLinkParts,
} from "../../lib/vault/remarkWikiLink";

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
  /** Render an embedded note body (depth-limited by the provider). */
  renderEmbed?: (parts: WikiLinkParts, resolvedPath: string | null) => React.ReactNode;
}

export const VaultLinkContext = createContext<VaultLinkContextValue | null>(null);

function WikiLinkAnchor({ href, children }: { href: string; children: React.ReactNode }) {
  const ctx = useContext(VaultLinkContext);
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
        href={`/vault?f=${encodeURIComponent(res.path)}`}
        className={`wiki-link ${res.ambiguous ? "wiki-link-ambiguous" : ""}`}
        title={res.ambiguous ? `${res.path} (ambiguous — multiple matches)` : res.path}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.button === 1) return; // browser/tab handling
          e.preventDefault();
          ctx.navigate(res.path!, parts.subpath, parts.subpathType);
        }}
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

function VaultLink({ href, children, node: _node, ...props }: any) {
  const ctx = useContext(VaultLinkContext);
  const url: string = href ?? "";
  if (url.startsWith(WIKI_SCHEME) || url.startsWith(WIKI_EMBED_SCHEME)) {
    return <WikiLinkAnchor href={url}>{children}</WikiLinkAnchor>;
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
        href={`/vault?f=${encodeURIComponent(clean)}`}
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
    <a href={url} {...props}>
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
    if (resolved) return <CollapsibleImage src={resolved} alt={alt} />;
  }
  return <CollapsibleImage src={src} alt={alt} />;
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
// else goes through react-markdown's standard sanitizer.
function vaultUrlTransform(url: string): string {
  if (url.startsWith(WIKI_SCHEME) || url.startsWith(WIKI_EMBED_SCHEME)) return url;
  return defaultUrlTransform(url);
}

const VAULT_REHYPE_PLUGINS = [rehypeHighlight];
const VAULT_COMPONENTS: Components = {
  ...MD_COMPONENTS,
  a: VaultLink,
  img: VaultImage,
  blockquote: VaultBlockquote,
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
