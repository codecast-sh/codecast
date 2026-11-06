import { useRef, useState } from "react";
import { useMountEffect } from "./useMountEffect";
import { attachScrollSeek, makeSeekKeep } from "../lib/virtualList/scrollSeek";
import type { VirtualKey } from "../lib/virtualList/attributeByKey";
import { VLIST_NO_SEEK } from "../lib/virtualList/legacyFlags";

/**
 * Fast-scroll placeholders for a virtualized list (lib/virtualList/scrollSeek).
 * `placeholder(key)` is true for a row that came into view during a fast
 * reader scroll; render it as an empty box of its believed height, stamped
 * data-seek so its measurement is not persisted.
 */
export function useScrollSeek(
  containerRef: React.RefObject<HTMLElement | null>,
  renderedKeys: () => Iterable<VirtualKey>,
) {
  const [seeking, setSeeking] = useState(false);
  const keepRef = useRef(makeSeekKeep());
  const keysRef = useRef(renderedKeys);
  keysRef.current = renderedKeys;
  useMountEffect(() => {
    const sc = containerRef.current;
    if (!sc || VLIST_NO_SEEK) return;
    return attachScrollSeek(sc, (next) => {
      if (next) keepRef.current.begin(keysRef.current());
      else keepRef.current.end();
      setSeeking(next);
    });
  });
  return {
    seeking,
    placeholder: (key: VirtualKey) => seeking && keepRef.current.placeholder(key),
  };
}
