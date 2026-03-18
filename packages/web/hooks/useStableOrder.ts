import { useRef, useState, useCallback, useMemo } from "react";
import { useMountEffect } from "./useMountEffect";

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

  latestItemsRef.current = items;

  const latestMap = useMemo(() => {
    const map = new Map<string, T>();
    for (const item of items) {
      map.set(getKey(item), item);
    }
    return map;
  }, [items, getKey]);

  const latestMapRef = useRef(latestMap);
  latestMapRef.current = latestMap;

  const commitOrder = useCallback((animate: boolean) => {
    if (animate) onBeforeReorder?.();
    const newOrder = latestItemsRef.current.map(getKey);
    setDisplayOrder(newOrder);
  }, [getKey, onBeforeReorder]);

  const commitOrderRef = useRef(commitOrder);
  commitOrderRef.current = commitOrder;
  const isHoveredRef = isHovered;

  useMountEffect(() => {
    const interval = setInterval(() => {
      if (!isHoveredRef.current) {
        commitOrderRef.current(true);
      }
    }, REORDER_INTERVAL_MS);
    return () => clearInterval(interval);
  });

  if (displayOrder.length === 0 && items.length > 0) {
    const newOrder = items.map(getKey);
    setDisplayOrder(newOrder);
  }

  const currentKeys = new Set(items.map(getKey));
  const orderKeys = new Set(displayOrder);

  let effectiveOrder = displayOrder.filter((key) => currentKeys.has(key));

  const newKeys = items.filter((item) => !orderKeys.has(getKey(item))).map(getKey);
  if (newKeys.length > 0) {
    effectiveOrder = [...newKeys, ...effectiveOrder];
  }

  return effectiveOrder
    .map((key) => latestMap.get(key))
    .filter((item): item is T => item !== undefined);
}
