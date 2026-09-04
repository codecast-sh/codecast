import rehypeHighlight from "rehype-highlight";
import { entityRemarkPlugins } from "./remarkEntityIds";

// ---------------------------------------------------------------------------
// Security control: neutralize invisible Unicode in rendered transcript text.
//
// Transcripts echo attacker-influenceable text verbatim (anything the agent
// read from a repo, the web, an issue, or an MCP tool). Zero-width and
// Private-Use-Area codepoints carry no visible glyph, so an attacker uses them
// to smuggle instructions a human reviewer literally cannot see (the
// invisible-Unicode / "IDEsaster" injection class). Bidirectional overrides go
// further: they reorder the *visual* run so reviewed text reads differently
// than the underlying bytes (the "trojan source" trick).
//
// Zero-width joiners/spaces (U+200B-U+200D), the BOM (U+FEFF), and every
// Private Use Area codepoint get stripped outright — they have no legitimate
// role in prose. Bidi controls (U+202A-U+202E, U+2066-U+2069) are NOT dropped
// (that would silently hide the tampering); each is surfaced as its visible
// codepoint so a reviewer sees that reordering was attempted.
const INVISIBLE_STRIP_RE =
  /[\u200B-\u200D\uFEFF\uE000-\uF8FF]|[\u{F0000}-\u{FFFFD}]|[\u{100000}-\u{10FFFD}]/gu;
const BIDI_CONTROL_RE = /[\u202A-\u202E\u2066-\u2069]/g;

function sanitizeInvisibleUnicode(value: string): string {
  if (!value) return value;
  return value
    .replace(INVISIBLE_STRIP_RE, '')
    .replace(BIDI_CONTROL_RE, (ch) =>
      `[U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`,
    );
}

// Remark transform that cleans invisible Unicode from prose `text` nodes only.
// Fenced/inline code lives in `code`/`inlineCode` mdast nodes (a different node
// type that never reaches this walk), so verbatim code stays byte-exact —
// rewriting bytes inside a code block could corrupt legitimate source, and
// flagging there is deliberately out of scope.
export function remarkSanitizeInvisibleUnicode() {
  return (tree: any) => {
    const walk = (node: any) => {
      if (!node) return;
      if (node.type === 'text' && typeof node.value === 'string') {
        node.value = sanitizeInvisibleUnicode(node.value);
      }
      if (Array.isArray(node.children)) node.children.forEach(walk);
    };
    walk(tree);
  };
}

// Hoisted to module scope so ReactMarkdown receives stable plugin/component
// identities on every render. Inline literals here meant react-markdown re-ran
// the full parse + rehype-highlight syntax pass on EVERY parent re-render — the
// single largest hot path during a session switch (measured: ~4.2s of self time,
// 775 renders). None of these component overrides close over props, so they're
// genuinely static.
export const MD_REHYPE_PLUGINS = [rehypeHighlight];
// Runs after entity-id/mention rewriting so it cleans every prose text node,
// including those inside generated pills. Module scope keeps the identity
// stable, matching the perf note above.
// Exported so a surface that adds a plugin of its own (chat's mentions) BUILDS
// FROM this list instead of from entityRemarkPlugins — the sanitizer is a
// security control, and a surface that assembles its own list silently drops it.
export const MD_REMARK_PLUGINS = [...entityRemarkPlugins, remarkSanitizeInvisibleUnicode];
