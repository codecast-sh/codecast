import { useRef, useState, useEffect, useCallback } from "react";

const REORDER_INTERVAL_MS = 5000;

interface StableOrderOptions<T> {
  items: T[];
  getKey: (item: T) => string;
  isHovered: React.MutableRefObject<boolean>;
  onBeforeReorder?: () => void;
}

export function useStableOrder<T>({ items, getKey, isHovered, onBeforeReorder }: StableOrderOptions<T>): T[] {
  const [displayOrder, setDisplayOrder] = useState<string[]>([]);
  const latestItemsRef = useRef<T[]>(items);
  const latestMapRef = useRef<Map<string, T>>(new Map());

  latestItemsRef.current = items;

  useEffect(() => {
    const map = new Map<string, T>();
    for (const item of items) {
      map.set(getKey(item), item);
    }
    latestMapRef.current = map;
  }, [items, getKey]);

  const commitOrder = useCallback((animate: boolean) => {
    if (animate) onBeforeReorder?.();
    const newOrder = latestItemsRef.current.map(getKey);
    setDisplayOrder(newOrder);
  }, [getKey, onBeforeReorder]);

  // Initial population: set order immediately (no animation)
  useEffect(() => {
    if (displayOrder.length === 0 && items.length > 0) {
      commitOrder(false);
    }
  }, [items.length, displayOrder.length, commitOrder]);

  // Periodic reorder on interval, skipped while hovered
  useEffect(() => {
    const interval = setInterval(() => {
      if (!isHovered.current) {
        commitOrder(true);
      }
    }, REORDER_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [commitOrder, isHovered]);

  // Immediately add new items that aren't in displayOrder yet (so they appear without waiting)
  // and remove items that no longer exist
  const currentKeys = new Set(items.map(getKey));
  const orderKeys = new Set(displayOrder);

  let effectiveOrder = displayOrder.filter((key) => currentKeys.has(key));

  const newKeys = items.filter((item) => !orderKeys.has(getKey(item))).map(getKey);
  if (newKeys.length > 0) {
    effectiveOrder = [...newKeys, ...effectiveOrder];
  }

  const map = latestMapRef.current;
  return effectiveOrder
    .map((key) => map.get(key))
    .filter((item): item is T => item !== undefined);
}
