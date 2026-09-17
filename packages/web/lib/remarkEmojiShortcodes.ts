import { replaceShortcodes } from "@codecast/shared/chat";

// Slack (and GitHub) write emoji as :names:. Inbound conversion turns the ones
// we know into unicode at ingest, but history imported against a thinner table
// still stores the shortcode, and a name we do not know stays text. This walk
// is the display half: it only rewrites mdast `text` nodes, so a shortcode
// inside a fence or an inline code span is left alone.

export function remarkEmojiShortcodes() {
  return (tree: any) => {
    const walk = (node: any) => {
      if (!node) return;
      if (node.type === "text" && typeof node.value === "string" && node.value.includes(":")) {
        node.value = replaceShortcodes(node.value);
      }
      if (Array.isArray(node.children)) node.children.forEach(walk);
    };
    walk(tree);
  };
}
