import { parseCodeThreadRootKey, parseCommentThreadRootKey } from "@codecast/shared/comments";
import { useInboxStore } from "../store/inboxStore";
import type { ThreadInboxRow } from "../store/threadTypes";
import type { ThreadCardModel } from "./threadCards";
import { webThreadKeyFromAnchor } from "./commentThread";

// The React-free readings of a Threads row that the kind renderers, the
// preview hooks and the page share: which server row a card carries, which
// object it names, and where its thread hangs. Lives in lib/ so a component
// module exports only components (the Fast Refresh guard).

export function rowOf(card: ThreadCardModel): ThreadInboxRow {
  return card.source as ThreadInboxRow;
}

export function taskIdOf(card: ThreadCardModel): string {
  const row = rowOf(card);
  return String(row.task_id ?? row.root_key);
}

/** Where a session comment thread lives and which anchor it hangs on. */
export function commentAnchorOf(row: ThreadInboxRow): { conversationId: string; webKey: string; messageId?: string; filePath?: string; lineNumber?: number } {
  const parsed = parseCommentThreadRootKey(row.root_key);
  return {
    conversationId: String(row.conversation_id ?? parsed.conversationId),
    webKey: webThreadKeyFromAnchor(parsed.anchorKey),
    messageId: row.message_id ? String(row.message_id) : undefined,
    filePath: row.file_path,
    lineNumber: row.line_number,
  };
}

/** Where a code thread hangs, from the row's typed refs or, failing those, its key. */
export function codeAnchorOf(row: ThreadInboxRow): { repository: string; ref: string; filePath?: string; lineNumber?: number } {
  const parsed = parseCodeThreadRootKey(row.root_key);
  return {
    repository: row.repository ?? parsed.repository,
    ref: row.ref ?? parsed.ref,
    filePath: row.file_path ?? parsed.filePath,
    lineNumber: row.line_number ?? parsed.lineNumber,
  };
}

/** Open the card's object in place: the task page, the room, the published
 *  page. A comment thread opens ON its message — the conversation view
 *  honors scrollToMessageId and pages it in (the same path the rail's jump
 *  uses). Shared by the row's tool and the page's `o` key. */
export function openCardIn(card: ThreadCardModel, router: { push: (href: string) => void }): void {
  if (card.kind === "comment") {
    const { conversationId, messageId } = commentAnchorOf(rowOf(card));
    const st = useInboxStore.getState();
    st.requestNavigate(conversationId, { scrollToMessageId: messageId, source: "gesture" });
    if (messageId) st.openCommentThread(messageId);
  }
  router.push(card.href);
}
