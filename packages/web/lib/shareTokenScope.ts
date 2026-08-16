// Share tokens the viewer has PRESENTED this tab, keyed by conversation id.
//
// Access via a share link requires presenting the token on every server read —
// the server no longer grants "shared" because a token merely exists on the
// conversation (issue #27). The /share/<token> page redirects to
// /conversation/<id>?share=<token>; the conversation page records the pair
// here so id-keyed queries deep in the tree (transcript, galleries, file
// changes, comments) can re-present the token without threading a prop through
// every layer. Signed-in viewers additionally redeem the token server-side
// (redeemShareToken), which makes the inbox surface work with no token at all;
// this registry is what keeps anonymous guests — and the window before a
// redemption lands — working.
const tokensByConversation = new Map<string, string>();

export function setShareTokenScope(conversationId: string, token: string): void {
  tokensByConversation.set(conversationId, token);
}

export function getShareTokenScope(conversationId: string | null | undefined): string | undefined {
  if (!conversationId) return undefined;
  return tokensByConversation.get(conversationId);
}

/** Spread into query args: `{...shareTokenArg(id)}` adds share_token only when one was presented. */
export function shareTokenArg(conversationId: string | null | undefined): { share_token?: string } {
  const token = getShareTokenScope(conversationId);
  return token ? { share_token: token } : {};
}
