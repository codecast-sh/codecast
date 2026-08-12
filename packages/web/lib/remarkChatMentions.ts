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
// Same character class as artifacts.ts:1080 rather than the narrower /@(\w+)/ in
// comments.ts:341, so dotted and hyphenated handles resolve. Keep the two in
// step: a handle the server notifies must be a handle the client highlights.
//
// Pairs with .ch-mention / .ch-mention-self in components/chat/chat.css.

const MENTION_RE = /(^|[\s(<[{,:;"'])@([A-Za-z0-9][A-Za-z0-9_.-]*)/g;

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
          (_match: string, lead: string, handle: string) => {
            // Unknown handle: hand back the original text so the sentence is
            // unchanged. Returning false tells findAndReplace to skip it.
            if (known && !has(known, handle)) return false;
            const className = has(self, handle)
              ? "ch-mention ch-mention-self"
              : "ch-mention";
            const mention = {
              type: "chatMention",
              // data.hName/hProperties is how mdast hands a custom node to
              // rehype — the same trick remarkEntityIds uses for entity pills.
              data: { hName: "span", hProperties: { className } },
              children: [{ type: "text", value: `@${handle}` }],
            };
            // The leading character is part of the match so "@" glued to the end
            // of a word (an email address, a file path) cannot match. Give it
            // back untouched alongside the mention.
            return lead ? [{ type: "text", value: lead }, mention] : [mention];
          },
        ],
      ],
      // Never rewrite the visible text of a link: the anchor already owns it,
      // and a mention-styled span inside it would navigate somewhere unrelated.
      { ignore: ["link", "linkReference"] },
    );
  };
}
