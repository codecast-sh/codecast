// Every height a row reports is filed under that row's own key.
//
// virtual-core resolves a measured element to an index by reading its
// data-index attribute, then files the height under getItemKey(index) from the
// CURRENT options. data-index is written at commit, while the options change
// during render. Between the two (a deferred or discarded render, a prepend
// that has not committed yet) the attribute names a stale index, and the height
// lands under a neighbour's key, where it stays: the ResizeObserver only reports
// changes, so nothing ever corrects it.
//
// Each row stamps its own key as data-vkey. Resolving the index from that stamp
// against the current list makes a misfiled height impossible: the row either
// still exists, at whatever index it holds now, or it is gone and is skipped.
// This is how react-virtuoso measures, by asking each rendered element who it
// is at the moment of measuring.

import type { VirtualItem } from "@tanstack/react-virtual";

export type VirtualKey = VirtualItem["key"];

type KeyedVirtualizer = {
  options: { count: number; getItemKey: (index: number) => VirtualKey };
  indexFromElement: (node: any) => number;
};

/** Index of the row whose key is `key` in the list as it stands, or -1. */
export function makeKeyIndex(count: number, getItemKey: (index: number) => VirtualKey) {
  let map: Map<string, number> | null = null;
  return (key: string): number => {
    if (!map) {
      map = new Map();
      for (let i = 0; i < count; i++) map.set(String(getItemKey(i)), i);
    }
    return map.get(key) ?? -1;
  };
}

/**
 * Point the virtualizer's element-to-index lookup at the row's data-vkey stamp.
 * Call on every render: the lookup closes over the current count and key
 * function, built lazily so a render that measures nothing pays nothing.
 * An element with no stamp keeps the library's data-index reading.
 */
export function attributeMeasurementsByKey(virtualizer: KeyedVirtualizer) {
  const { count, getItemKey } = virtualizer.options;
  const lib = (virtualizer as { __libIndexFromElement?: (node: any) => number }).__libIndexFromElement
    ?? virtualizer.indexFromElement;
  (virtualizer as { __libIndexFromElement?: (node: any) => number }).__libIndexFromElement = lib;
  const indexOf = makeKeyIndex(count, getItemKey);
  virtualizer.indexFromElement = (node: HTMLElement) => {
    const stamp = node.dataset?.vkey;
    return stamp === undefined ? lib(node) : indexOf(stamp);
  };
}
