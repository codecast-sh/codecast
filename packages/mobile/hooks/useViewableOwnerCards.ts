import { useEffect, useId, useRef } from 'react';
import type { ViewToken } from 'react-native';
import { setViewableOwnerCards } from '@codecast/web/lib/visibleOwnerCards';
import { viewableOwnerIds } from '@/lib/viewableOwners';

/** A FlatList's onViewableItemsChanged that reports its rows on screen, in
 *  list order, as the ones whose owners the window reads
 *  (lib/visibleOwnerCards): a FlatList keeps screens of rows mounted past the
 *  viewport, so a row does not hold its own id. Clears them on unmount. */
export function useViewableOwnerCards<T extends Parameters<typeof viewableOwnerIds>[0][number]['item']>() {
  const listKey = useId();
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken<T>[] }) => {
    setViewableOwnerCards(listKey, viewableOwnerIds(viewableItems));
  }).current;
  useEffect(() => () => setViewableOwnerCards(listKey, []), [listKey]);
  return onViewableItemsChanged;
}
