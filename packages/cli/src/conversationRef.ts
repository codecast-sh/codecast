// Accept a bare conversation id, a full share URL, or an id with a `#msg-<id>`
// fragment, and split it into the conversation id plus an optional anchor message
// id. The message id is the message's Convex _id, matching the web's `#msg-<id>`
// anchors — so pasting a share link to `cast read` can read a window around that
// exact message.

export interface ConversationRef {
  conversationId: string;
  messageId?: string;
}

export function parseConversationRef(input: string): ConversationRef {
  let s = (input || "").trim();
  let messageId: string | undefined;

  const hashIdx = s.indexOf("#");
  if (hashIdx >= 0) {
    const frag = s.slice(hashIdx + 1).trim();
    s = s.slice(0, hashIdx);
    if (frag) messageId = frag.startsWith("msg-") ? frag.slice(4) : frag;
  }

  // Full URL → take the segment after /conversation/
  const m = s.match(/\/conversation\/([^/?#]+)/);
  if (m) {
    s = m[1];
  } else {
    // Strip any stray query string from a partial URL paste
    s = s.replace(/\?.*$/, "");
  }

  return { conversationId: s.trim(), messageId };
}

// The inverse of `parseConversationRef`: assemble a canonical deep link from a
// conversation id and an optional anchor message id. Round-trips with the parser
// — `parseConversationRef(buildConversationUrl(ref))` returns `ref` back. The
// conversation id should be the full Convex `_id` (not the 8-char short id) and
// the message id the message's Convex `_id`, so the link resolves on the web and
// in `cast read`.
export function buildConversationUrl(ref: ConversationRef, base = "https://codecast.sh"): string {
  const url = `${base.replace(/\/+$/, "")}/conversation/${ref.conversationId}`;
  return ref.messageId ? `${url}#msg-${ref.messageId}` : url;
}
