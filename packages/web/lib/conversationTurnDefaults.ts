import type { ReceiptEntry } from "../components/conversation/types";

// Compact feed: a collapsed assistant turn shows the BOTTOM ~500px of its final
// reply (the conclusion) with the top faded out behind a "Show full turn"
// control. The clipped column is anchored to its bottom so the end stays in
// view; expanding renders the whole turn at full density.
export const COMPACT_TAIL_HEIGHT = 500;

export const EMPTY_RECEIPT_ENTRIES: ReceiptEntry[] = [];

export const EMPTY_CHILD_CONVERSATIONS: any[] = [];
