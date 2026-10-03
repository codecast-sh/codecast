import { findAndReplace } from "mdast-util-find-and-replace";
import remarkGfm from "remark-gfm";
import type { Options as ReactMarkdownOptions } from "react-markdown";
import { isConvexId, isEntityId, bareEntityIdRegex, entityMentionRegex, entityTypeFromId, parseEntityUrl, parsePublishedPageUrl, parseClaudeArtifactUrl, parseLinkPreviewUrl, parseMessageRefUrl, messageRefPayload, contextualPrRefRegex, contextualPrRefPayload, splitContextualPrRefs } from "./entityLinks";
import { FILE_PATH_SCAN_RE, mentionFromMatch } from "./filePathLinks";
import { filesHref } from "./vault/vaultHref";

// Both shapes come from the shared mention vocabulary (@codecast/shared/
// entities), so registering a new object type there lights it up in prose
// everywhere at once. The bare 32-char alternative catches full Convex ids —
// the only handle docs have (no short id). EntityIdPill resolves their table
// server-side; ids that resolve to nothing render back as plain text.
const ENTITY_ID_RE = bareEntityIdRegex();
const MENTION_RE = entityMentionRegex();
// `#3263`, `PR 3263`, `pull request #12`: a pull request named by number
// alone. Runs after ENTITY_ID_RE so `owner/repo#12` is already a link and
// never reaches it. The words in front stay prose; the number becomes a
// `pr:#N|<as written>` payload (`pr:?#N|…` for a lone `#N`) that EntityAwareLink completes from the
// conversation's repository, or prints back verbatim where there is none.
const CONTEXTUAL_PR_RE = contextualPrRefRegex();
// Obsidian-style transclusion: ![[doc:<convex id>]]. Only docs are embeddable —
// they're the entity whose body IS markdown meant to be read in place.
const EMBED_RE = /!\[\[(doc:[a-z0-9]{32})\]\]/g;

function isEmbedLink(node: any): boolean {
  return node?.type === "link" && typeof node.url === "string" && node.url.startsWith("embed://");
}

function mdastText(node: any): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  if (Array.isArray(node.children)) return node.children.map(mdastText).join("");
  return "";
}

function isUrlLabel(text: string, href: string): boolean {
  const label = text.trim().replace(/^https?:\/\//i, "");
  const url = href.trim().replace(/^https?:\/\//i, "");
  if (label === url) return true;
  const prefix = label.replace(/(?:…|\.{3})$/, "");
  return prefix !== label && prefix.includes("/") && url.startsWith(prefix);
}

/**
 * A page URL standing alone on its own line becomes a block-level embed — the
 * page renders inline in the conversation, the way the decision queue frames
 * an attached report. Two kinds of page qualify: a published codecast page
 * (codecast.sh/a/<slug>, payload `artifact:<slug>`) and a public Claude
 * artifact (claude.ai/public/artifacts/<id>, payload `claude:<id>`). Link text
 * the author wrote (`[caption](url)`) rides along as the caption, image-style;
 * a bare autolink has none. Any other public web page (payload
 * `link:<encoded url>`) renders as a preview card drawn from its own meta
 * tags. Same text-node payload trick as doc embeds: react-markdown's url
 * sanitizer drops the embed:// href, so the text carries
 * `<kind>:<id>|<caption>`.
 */
function toPageEmbedLink(link: any): any | null {
  const href = link?.type === "link" ? link.url : null;
  const page = parsePublishedPageUrl(href);
  const claude = page ? null : parseClaudeArtifactUrl(href);
  const web = page || claude ? null : parseLinkPreviewUrl(href);
  if (!page && !claude && !web) return null;
  const text = mdastText(link).trim();
  const caption = text && !isUrlLabel(text, link.url) ? text : "";
  const ref = page ? `artifact:${page.slug}` : claude ? `claude:${claude.id}` : `link:${encodeURIComponent(web!)}`;
  const payload = `${ref}${caption ? `|${caption}` : ""}`;
  return {
    type: "link",
    url: `embed://${payload}`,
    children: [{ type: "text", value: `embed:${payload}` }],
  };
}

/** A web link previews only on a top-level line: a list of sources or a
 *  link quoted inside something else stays a list of links. */
function isWebPreview(embed: any): boolean {
  return mdastText(embed).startsWith("embed:link:");
}

/** A message imported from Slack carries Slack's own unfurl as a quote right
 *  under the link (slackAttachmentsToMarkdown); that quote already is the
 *  preview, so the link stays a link instead of drawing a second card. */
function quotesLink(node: any, url: string): boolean {
  if (node?.type !== "blockquote") return false;
  const has = (n: any): boolean => (n?.type === "link" && n.url === url) || (Array.isArray(n?.children) && n.children.some(has));
  return has(node);
}

/** A paragraph's children split at its line breaks (a hard break node, or a
 *  newline inside a text node), each line keeping the node that opened it so
 *  the prose around a hoisted line rejoins exactly as written. */
function paragraphLines(children: any[]): { sep: any | null; nodes: any[] }[] {
  const lines: { sep: any | null; nodes: any[] }[] = [{ sep: null, nodes: [] }];
  for (const c of children) {
    if (c.type === "break") {
      lines.push({ sep: c, nodes: [] });
    } else if (c.type === "text" && c.value?.includes("\n")) {
      c.value.split("\n").forEach((part: string, k: number) => {
        if (k) lines.push({ sep: { type: "text", value: "\n" }, nodes: [] });
        if (part) lines[lines.length - 1].nodes.push({ ...c, value: part });
      });
    } else {
      lines[lines.length - 1].nodes.push(c);
    }
  }
  return lines;
}

function isBlank(nodes: any[]): boolean {
  return nodes.every((c) => c.type === "text" && !c.value?.trim());
}

function demoteInlineEmbeds(paragraph: any): any {
  paragraph.children = paragraph.children.map((c: any) =>
    isEmbedLink(c)
      ? {
          ...c,
          url: c.url.replace("embed://", "entity://"),
          children: [{ type: "text", value: c.url.slice("embed://".length) }],
        }
      : c,
  );
  return paragraph;
}

/**
 * Post-pass over the tree after findAndReplace: a line consisting solely of
 * one embed link is lifted OUT of its paragraph, so the embed renders at block
 * level (a full doc card inside a <p> is invalid HTML and reads wrong) and the
 * prose above and below stays where it was. An embed mixed into surrounding
 * prose is demoted to an ordinary doc pill — transclusion is a block-level
 * act, same semantics as Obsidian.
 */
function hoistEmbeds(node: any, isRoot = true) {
  if (!Array.isArray(node.children)) return;
  node.children = node.children.flatMap((child: any, i: number) => {
    if (child.type === "paragraph" && Array.isArray(child.children)) {
      const lines = paragraphLines(child.children);
      const embeds = lines.map(({ nodes }) => {
        const meaningful = nodes.filter((c: any) => !(c.type === "text" && !c.value?.trim()));
        if (meaningful.length !== 1) return null;
        if (isEmbedLink(meaningful[0])) return meaningful[0];
        const pageEmbed = toPageEmbedLink(meaningful[0]);
        if (pageEmbed && isWebPreview(pageEmbed) && (!isRoot || quotesLink(node.children[i + 1], meaningful[0].url))) return null;
        return pageEmbed;
      });
      if (embeds.some(Boolean)) {
        const out: any[] = [];
        let prose: typeof lines = [];
        const flush = () => {
          while (prose.length && isBlank(prose[0].nodes)) prose.shift();
          while (prose.length && isBlank(prose[prose.length - 1].nodes)) prose.pop();
          if (prose.length) out.push(demoteInlineEmbeds({ ...child, children: prose.flatMap((l, k) => (k && l.sep ? [l.sep, ...l.nodes] : l.nodes)) }));
          prose = [];
        };
        lines.forEach((line, k) => {
          if (embeds[k]) {
            flush();
            out.push(embeds[k]);
          } else prose.push(line);
        });
        flush();
        return out;
      }
      return [demoteInlineEmbeds(child)];
    }
    hoistEmbeds(child, false);
    return [child];
  });
}

/**
 * A pasted message link — `/share/message/<token>` or
 * `/conversation/<id>#msg-<id>` — becomes a message reference: an entity://
 * link whose text carries `msg:<token or id>`, the same shape every other
 * object reference takes, so it renders as a pill in prose and remarkEntityCards
 * promotes it to a card when it stands alone. Only a BARE link (text is the
 * URL, the way a forwarded message arrives) converts: a link the author gave
 * their own words keeps them.
 */
function promoteMessageLinks(node: any) {
  if (!Array.isArray(node.children)) return;
  node.children = node.children.map((child: any) => {
    if (child.type === "link") {
      const ref = parseMessageRefUrl(child.url);
      if (ref && isUrlLabel(mdastText(child), child.url)) {
        const payload = messageRefPayload(ref);
        return { type: "link", url: `entity://${payload}`, children: [{ type: "text", value: payload }] };
      }
      return child;
    }
    promoteMessageLinks(child);
    return child;
  });
}

// ---------------------------------------------------------------------------
// First mention vs. repeat
//
// Prose that names the same object several times ("X flagged it, X's owner,
// routed back to X") renders every mention as a full-title pill, and the line
// stops reading as a sentence. A reader only needs the title ONCE; after that
// the object's short name is enough. The count is taken here, on the syntax
// tree, so it is deterministic per message body and independent of React's
// render order (a mount-time counter would double-claim under strict mode and
// drift on partial re-renders).
//
// Each reference link/code node gets `data-ref-nth` (1 = first mention). A
// mention the author wrote as `@[Title id]` is `data-ref-named`: they asked
// for the name in the sentence, so it always renders in full.
// ---------------------------------------------------------------------------

export const REF_NTH_ATTR = "data-ref-nth";
export const REF_NAMED_ATTR = "data-ref-named";
// A possessive glued to a reference ("jx7b7mx's owner") rides on the pill, so
// it renders against the label instead of a padding-width away from it.
export const REF_SUFFIX_ATTR = "data-ref-suffix";
const POSSESSIVE_RE = /^(['’]s)(?![\p{L}\p{N}])/u;

/** The identity a reference counts under, or null for a non-reference node. */
function referenceKey(node: any): string | null {
  if (node?.type === "link" && typeof node.url === "string") {
    if (node.url.startsWith("entity://")) {
      const ref = node.url.slice(9).toLowerCase();
      // Dates and message refs are not objects a reader needs introduced once.
      if (ref.startsWith("date:") || ref.startsWith("msg:")) return null;
      // A payload may carry the text as written after `|`; the object is the
      // part before it, so "PR 3263" and "#3263" count as one reference (the
      // bare marker on a lone `#N` is not part of the identity).
      return ref.split("|")[0].replace(/^pr:\?/, "pr:");
    }
    const parsed = parseEntityUrl(node.url);
    if (parsed) return parsed.id.toLowerCase();
    return null;
  }
  if (node?.type === "inlineCode" && typeof node.value === "string" && isEntityId(node.value)) {
    return node.value.trim().toLowerCase();
  }
  return null;
}

function stamp(node: any, props: Record<string, string>) {
  node.data = { ...node.data, hProperties: { ...node.data?.hProperties, ...props } };
}

function numberMentions(tree: any) {
  const seen = new Map<string, number>();
  const walk = (node: any) => {
    const key = referenceKey(node);
    if (key) {
      const nth = (seen.get(key) ?? 0) + 1;
      seen.set(key, nth);
      stamp(node, { [REF_NTH_ATTR]: String(nth) });
      return;
    }
    if (!Array.isArray(node?.children)) return;
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const next = node.children[i + 1];
      if (referenceKey(child) && next?.type === "text" && typeof next.value === "string") {
        const m = POSSESSIVE_RE.exec(next.value);
        if (m) {
          stamp(child, { [REF_SUFFIX_ATTR]: m[1] });
          next.value = next.value.slice(m[1].length);
        }
      }
      walk(child);
    }
  };
  walk(tree);
}

export function remarkEntityIds() {
  return (tree: any) => {
    promoteMessageLinks(tree);
    findAndReplace(tree, [
      [
        EMBED_RE,
        (_match: string, docRef: string) => ({
          type: "link",
          url: `embed://${docRef}`,
          // react-markdown's url sanitizer drops the embed:// href, so — as
          // with entity:// below — the text node is the real payload carrier.
          children: [{ type: "text", value: `embed:${docRef}` }],
        }),
      ],
      [
        MENTION_RE,
        (_match: string, name: string, entityId?: string) => {
          // A serialized date pill (`@[<label> date:<iso>]`, written by the doc
          // editor). The text node carries `date:<iso>|<label>` — as with
          // entity:// below, react-markdown strips the href, so the text is
          // the payload EntityAwareLink parses into a DatePill.
          if (entityId && /^date:\d{4}-\d{2}-\d{2}$/i.test(entityId)) {
            const payload = `${entityId.toLowerCase()}|${name.trim()}`;
            return {
              type: "link",
              url: `entity://${payload}`,
              children: [{ type: "text", value: payload }],
            };
          }
          if (entityId && !/^doc:/i.test(entityId) && (entityTypeFromId(entityId) || isConvexId(entityId))) {
            return {
              type: "link",
              url: `entity://${entityId.toLowerCase()}`,
              children: [{ type: "text", value: entityId.toLowerCase() }],
              data: { hProperties: { [REF_NAMED_ATTR]: "1" } },
            };
          }
          if (entityId && entityId.startsWith("doc:")) {
            // Docs have no short id, so the doc's convex id rides in the link
            // *text* — react-markdown drops the `entity://` href via its url
            // sanitizer, so the text node is the real carrier. EntityAwareLink
            // reads "doc:<id>" and renders a doc pill, same path as ct-/jx ids.
            return {
              type: "link",
              url: `entity://${entityId}`,
              children: [{ type: "text", value: entityId }],
              data: { hProperties: { [REF_NAMED_ATTR]: "1" } },
            };
          }
          return {
            type: "link",
            url: `mention://${name.trim()}`,
            children: [{ type: "text", value: `@${name.trim()}` }],
          };
        },
      ],
      [
        ENTITY_ID_RE,
        (match: string) => {
          // The bare-32-char alternative matched case-insensitively, but real
          // Convex ids are all-lowercase — leave an uppercase hash lookalike
          // as plain text rather than lowercasing (= altering) displayed text.
          if (/^[a-z0-9]{32}$/i.test(match) && !isConvexId(match)) return false;
          return {
            type: "link",
            url: `entity://${match.toLowerCase()}`,
            children: [{ type: "text", value: match.toLowerCase() }],
          };
        },
      ],
      [
        CONTEXTUAL_PR_RE,
        (_full: string, lead: string, digits: string, tail: string) => {
          // Each number is its own link and every other character stays a
          // text node, so the prose a reader sees never changes: "PRs 3263
          // (a), 3262 (b)" keeps its words and gains two references.
          return splitContextualPrRefs(lead, digits, tail ?? "").map((token) =>
            "text" in token
              ? { type: "text" as const, value: token.text }
              : {
                  type: "link" as const,
                  url: `entity://${contextualPrRefPayload(token.number, token.label, token.bare)}`,
                  children: [{ type: "text" as const, value: contextualPrRefPayload(token.number, token.label, token.bare) }],
                },
          );
        },
      ],
      [
        // Local file/directory mentions → the Files surface. The href carries
        // the path as written (`?path=`), which is a real in-app URL: it works
        // on surfaces that render links plainly, and EntityAwareLink upgrades
        // it with the session's working directory when it has one.
        FILE_PATH_SCAN_RE,
        (full: string, rawPath: string, line?: string) => {
          const mention = mentionFromMatch(full, rawPath, line);
          if (!mention) return false;
          const link = {
            type: "link" as const,
            url: filesHref({ localPath: mention.path, line: mention.line }),
            children: [{ type: "text" as const, value: mention.text }],
          };
          return mention.rest ? [link, { type: "text" as const, value: mention.rest }] : link;
        },
      ],
    ], { ignore: ['link', 'inlineCode'] });
    hoistEmbeds(tree);
    numberMentions(tree);
  };
}

/**
 * The remark plugin chain shared by every markdown surface in the app
 * (conversation prose, shared-message pages, comments, the activity digest,
 * tool views, and the generic file renderer).
 *
 * `singleTilde: false` is the important bit: remark-gfm defaults to treating a
 * lone "~" as a strikethrough delimiter, which is looser than GitHub itself.
 * Agents routinely use "~" as an "approximately" sign ("~$5/mo", "~5 items"),
 * so two of them on one line would otherwise pair up and strike through
 * everything between them. With this off, lone tildes render literally while
 * intentional "~~strikethrough~~" (double tilde) still works.
 */
export const entityRemarkPlugins: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = [
  [remarkGfm, { singleTilde: false }],
  remarkEntityIds,
];
