import { useInboxStore } from "../store/inboxStore";
import type { PendingComment } from "./quoteFormat";
import { getQuoteUnits } from "./quoteUnits";

function reviewRegion(scroll: HTMLElement, messageId: string) {
  return Array.from(scroll.querySelectorAll<HTMLElement>("[data-review-message]"))
    .find((el) => el.dataset.reviewMessage === messageId);
}

export function reviewSourceMessageId(messageId: string) {
  return messageId.replace(/#plan$/, "");
}

export function jumpToReviewComment(comment: PendingComment, scroll: HTMLElement | null, jumpToMessage: (id: string) => void, scrollToBlock?: (block: HTMLElement, align: "center" | "nearest") => void) {
  const state = useInboxStore.getState();
  state.setReviewEditingId(null);
  if (comment.image) {
    if (comment.messageId) jumpToMessage(comment.messageId);
    return;
  }
  // A quote the code editor made (Cmd-L) points at a file, not a message:
  // its source is the file at those lines.
  const filePath = comment.filePath;
  if (filePath && comment.messageId.startsWith("file:")) {
    const { blockIndex, fileLine } = comment;
    void import("./filesPane").then(({ openInEditor }) => openInEditor({ path: filePath, line: blockIndex, endLine: fileLine }));
    return;
  }
  state.setReviewTarget(comment.messageId, comment.blockIndex);
  const region = scroll && reviewRegion(scroll, comment.messageId);
  if (region) {
    const block = getQuoteUnits(region.querySelector(":scope > .cc-content"))[comment.blockIndex];
    if (scrollToBlock) scrollToBlock(block ?? region, "center");
    else (block ?? region).scrollIntoView({ block: "center", behavior: "auto" });
    region.focus({ preventScroll: true });
  } else {
    jumpToMessage(reviewSourceMessageId(comment.messageId));
  }
}

