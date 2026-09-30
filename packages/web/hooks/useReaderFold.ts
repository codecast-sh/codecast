import { useMemo, useState } from "react";
import { readerFold } from "../lib/threadCards";

// Every Threads body shows enough to read without scrolling inside the page:
// what is new since the reader's last visit and one earlier item for context,
// or the newest few when nothing is new. The rest waits behind one button
// above the body (components/threads/readerFold EarlierButton; lib/threadCards
// readerFold owns the arithmetic).

/** Fold `items` (oldest first). `newSince` is the visit's frozen unread
 *  boundary; 0 folds to the newest few with no divider; undefined shows all. */
export function useReaderFold<T>(items: T[], timeOf: (item: T) => number, newSince: number | undefined) {
  const [showAll, setShowAll] = useState(false);
  // timeOf is read with the items; callers pass an inline accessor.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fold = useMemo(() => readerFold(items.map(timeOf), newSince), [items, newSince]);
  const hidden = showAll ? 0 : fold.hidden;
  const visible = useMemo(() => (hidden > 0 ? items.slice(hidden) : items), [items, hidden]);
  return {
    visible,
    hidden,
    /** Index of the first new item within `items`, -1 for none. */
    firstNew: fold.firstNew,
    showAll: () => setShowAll(true),
  };
}
