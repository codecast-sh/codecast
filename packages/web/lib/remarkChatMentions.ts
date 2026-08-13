import { findAndReplace } from "mdast-util-find-and-replace";

// Highlight @mentions inside chat message bodies.
//
// This is a remark plugin rather than a string replace over the raw markdown for
// one reason that matters here: findAndReplace only rewrites `text` nodes. A
// mention-shaped string inside a fenced block, an inline code span, a link href
// or an autolink is a different mdast node, so it is never touched. A regex over
// the source cannot tell those apart and would corrupt pasted code — which, in
// this product, is most of what people paste.
//
// The character class MUST equal the server's mention vocabulary
// (@codecast/shared/chat/handles): no dots, 39 chars max. A wider class here
// once made "@maya.x" notify maya on the server (its regex stops at the dot)
// while the web showed no highlight at all — this capture included the dot,
// failed the known-handle lookup, and the two halves of the feature disagreed
// about the same three characters.
//
// Pairs with .ch-mention / .ch-mention-self in components/chat/chat.css.

// Just the handle. The character before it is checked against the match's own
// input rather than captured, because a leading capture group would have to
// re-emit that character as a sibling text node, and splicing text back around
// a replacement is exactly where findAndReplace's tree walk goes wrong.
const MENTION_RE = /@([A-Za-z0-9][A-Za-z0-9_-]{0,38})/g;

// "@" glued to the end of a word is an email address, and "/@" is a path
// segment — the same boundary the server draws ([^\w/]).
const BOUNDARY_RE = /[\s(<[{,:;"'*~]/;

export type ChatMentionOptions = {
  /** Handles that resolve to a real member. Anything else stays plain text, so
   *  a stray "@" in prose never renders as a mention. Omit to accept any. */
  known?: Set<string>;
  /** The viewer's own handles, which get the louder treatment. */
  self?: Set<string>;
};

export function remarkChatMentions(options: ChatMentionOptions = {}) {
  const { known, self } = options;
  const has = (set: Set<string> | undefined, handle: string) =>
    !!set && (set.has(handle) || set.has(handle.toLowerCase()));

  return (tree: any) => {
    findAndReplace(
      tree,
      [
        [
          MENTION_RE,
          (match: string, handle: string, meta: { index: number; input: string }) => {
            const before = meta && meta.index > 0 ? meta.input[meta.index - 1] : "";
            // Returning false leaves the original text exactly as written, which
            // is what an unknown handle or a mid-word "@" must do.
            if (before && !BOUNDARY_RE.test(before)) return false;
            if (known && !has(known, handle)) return false;
            return {
              type: "emphasis",
              // data.hName/hProperties is how mdast hands a node to rehype under
              // a tag of our choosing — the same trick remarkEntityIds uses for
              // entity pills. emphasis is used as the carrier because it is a
              // real inline node type the tree walk already understands.
              data: {
                hName: "span",
                hProperties: {
                  className: has(self, handle) ? "ch-mention ch-mention-self" : "ch-mention",
                  "data-mention": handle,
                },
              },
              children: [{ type: "text", value: match }],
            };
          },
        ],
      ],
      // Never rewrite the visible text of a link: the anchor already owns it,
      // and a mention-styled span inside it would navigate somewhere unrelated.
      { ignore: ["link", "linkReference"] },
    );
  };
}
