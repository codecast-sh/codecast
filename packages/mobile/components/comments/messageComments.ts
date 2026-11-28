// The session screen's two touch points with comments: the menu row that
// starts one on a pressed block, and the send that carries the batch.
import { useInboxStore, type OptimisticImage } from '@codecast/web/store/inboxStore';
import { attachReviewToMessage, genCommentId, quotedImages } from '@codecast/web/lib/reviewActions';
import type { SheetItem } from '@/lib/popups';
import { commentLabel, quotesWholeUnit, type CommentUnit } from '@/lib/messageComments';
import { openCommentEditor } from './CommentEditor';

/**
 * The long-press menu's first row on a block of an agent's message: start a
 * comment on it, or, when the block is already commented on whole, open that
 * comment to read or add to it.
 */
export function unitCommentItem(conversationId: string, messageId: string, unit: CommentUnit): SheetItem {
  const mine = (useInboxStore.getState().reviewComments[conversationId] ?? [])
    .find((c) => c.messageId === messageId && !c.image && !c.page && !c.proposal && quotesWholeUnit(c.quote, unit.text));
  return {
    label: mine ? 'Edit your comment' : commentLabel(unit.kind),
    icon: 'message-square',
    onPress: () => {
      // The menu is still animating away; the editor opens once it has gone.
      if (mine) return openCommentEditor({ conversationId, id: mine.id, isNew: false }, 350);
      const id = genCommentId();
      useInboxStore.getState().addReviewComment(conversationId, {
        id, messageId, blockIndex: unit.index, quote: unit.text, body: '', createdAt: Date.now(),
      });
      openCommentEditor({ conversationId, id, isNew: true }, 350);
    },
  };
}

/**
 * The typed words with the batch's comments before them, and the pictures to
 * send: the composer's own, then each picture a comment is pinned on, which
 * its comments name by that attachment number. Takes the batch.
 */
export function withComments(conversationId: string, typed: string, images: OptimisticImage[]): { text: string; images: OptimisticImage[] } {
  const quoted = quotedImages(conversationId);
  const text = attachReviewToMessage(conversationId, typed, {
    firstQuoted: quoted.length ? images.length + 1 : undefined,
    unmarked: true,
  });
  return { text, images: [...images, ...quoted.map((q) => ({ media_type: 'image/png', storage_id: q.storageId }))] };
}
