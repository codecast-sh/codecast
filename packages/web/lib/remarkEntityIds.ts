import { findAndReplace } from "mdast-util-find-and-replace";
import remarkGfm from "remark-gfm";
import type { Options as ReactMarkdownOptions } from "react-markdown";
import { isConvexId, bareEntityIdRegex, entityMentionRegex, entityTypeFromId, parsePublishedPageUrl } from "./entityLinks";
import { FILE_PATH_SCAN_RE, mentionFromMatch } from "./filePathLinks";
import { filesHref } from "./vault/vaultHref";

// Both shapes come from the shared mention vocabulary (@codecast/shared/
// entities), so registering a new object type there lights it up in prose
// everywhere at once. The bare 32-char alternative catches full Convex ids —
// the only handle docs have (no short id). EntityIdPill resolves their table
// server-side; ids that resolve to nothing render back as plain text.
const ENTITY_ID_RE = bareEntityIdRegex();
const MENTION_RE = entityMentionRegex();
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

/**
 * A publish URL (codecast.sh/a/<slug>) standing alone on its own line becomes
 * a block-level page embed — the page renders inline in the conversation, the
 * way the decision queue frames an attached report. Link text the author wrote
 * (`[caption](url)`) rides along as the caption, image-style; a bare autolink
 * has none. Same text-node payload trick as doc embeds: react-markdown's url
 * sanitizer drops the embed:// href, so the text carries `artifact:<slug>|<caption>`.
 */
function toPageEmbedLink(link: any): any | null {
  const page = parsePublishedPageUrl(link?.type === "link" ? link.url : null);
  if (!page) return null;
  const text = mdastText(link).trim();
  const caption = text && text !== link.url ? text : "";
  const payload = `artifact:${page.slug}${caption ? `|${caption}` : ""}`;
  return {
    type: "link",
    url: `embed://${payload}`,
    children: [{ type: "text", value: `embed:${payload}` }],
  };
}

/**
 * Post-pass over the tree after findAndReplace: a paragraph consisting solely
 * of one embed link gets REPLACED by that link, so the embed renders at block
 * level (a full doc card inside a <p> is invalid HTML and reads wrong). An
 * embed mixed into surrounding prose is demoted to an ordinary doc pill —
 * transclusion is a block-level act, same semantics as Obsidian.
 */
function hoistEmbeds(node: any) {
  if (!Array.isArray(node.children)) return;
  node.children = node.children.map((child: any) => {
    if (child.type === "paragraph" && Array.isArray(child.children)) {
      const meaningful = child.children.filter(
        (c: any) => !(c.type === "text" && !c.value?.trim()),
      );
      if (meaningful.length === 1 && isEmbedLink(meaningful[0])) return meaningful[0];
      if (meaningful.length === 1) {
        const pageEmbed = toPageEmbedLink(meaningful[0]);
        if (pageEmbed) return pageEmbed;
      }
      child.children = child.children.map((c: any) =>
        isEmbedLink(c)
          ? {
              ...c,
              url: c.url.replace("embed://", "entity://"),
              children: [{ type: "text", value: c.url.slice("embed://".length) }],
            }
          : c,
      );
      return child;
    }
    hoistEmbeds(child);
    return child;
  });
}

export function remarkEntityIds() {
  return (tree: any) => {
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
