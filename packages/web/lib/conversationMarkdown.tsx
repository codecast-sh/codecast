import { CollapsibleImage, ImageRowParagraph } from "../components/tools/MarkdownImages";
import { EntityAwareCode, EntityAwareLink } from "../components/EntityIdPill";
import { MESSAGE_MD_COMPONENTS, renderMarkdownPre } from "../components/messageMarkdown";

// Stable variants for non-message-body call sites (tool results, sent-message
// cards, command markdown, summaries). Same identity rule as above: the memo'd
// ReactMarkdown wrapper only bails out of a re-parse when these are module consts.
export const MD_COMPONENTS_CODE_LINK = { code: MESSAGE_MD_COMPONENTS.code, a: MESSAGE_MD_COMPONENTS.a };

// "No images" must be enforced, not implied: with no `img` override react-markdown
// emits a raw <img>, which auto-fetches — full-bleed layout AND the third-party
// beacon channel CollapsibleImage's click gate exists to close.
export const MD_COMPONENTS_NO_IMG = { ...MD_COMPONENTS_CODE_LINK, pre: MESSAGE_MD_COMPONENTS.pre, img: () => null };

export const MD_COMPONENTS_NO_PRE = { ...MD_COMPONENTS_CODE_LINK, img: MESSAGE_MD_COMPONENTS.img };

export function hasRichMarkdown(text: string): boolean {
  if (/\b(ct|pl)-[a-z0-9]+\b/i.test(text)) return true;
  const markers = [
    /^#{1,3}\s+\S/m,           // headers
    /\|.+\|.+\|/,              // tables
    /^```\w*/m,                 // fenced code blocks
    /^\d+\.\s+\*\*[^*]+\*\*/m, // numbered list with bold
    /^-\s+\[[ x]\]/im,         // task lists
  ];
  let hits = 0;
  for (const m of markers) {
    if (m.test(text)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

export const CMD_MD_COMPONENTS = {
  code: EntityAwareCode,
  a: EntityAwareLink,
  img: ({ src, alt }: { src?: string; alt?: string }) => <CollapsibleImage src={src} alt={alt} />,
  p: ImageRowParagraph,
  pre: ({ node, children, ...props }: any) => renderMarkdownPre(node, children, props),
};

export function linkifyMentions(text: string, map: Record<string, string>): string {
  if (!text || Object.keys(map).length === 0) return text;
  const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (i % 2 === 1) return part;
    return part.replace(/@([\w][\w-]*)/g, (match, name) => {
      const childId = map[name];
      if (childId) return `[@${name}](/conversation/${childId})`;
      return match;
    });
  }).join('');
}
