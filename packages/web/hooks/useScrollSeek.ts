import { useRef, useState } from "react";
import { useMountEffect } from "./useMountEffect";
import { attachScrollSeek, makeSeekKeep } from "../lib/virtualList/scrollSeek";
import type { VirtualKey } from "../lib/virtualList/attributeByKey";
import { VLIST_NO_SEEK } from "../lib/virtualList/legacyFlags";

/**
 * Fast-scroll placeholders for a virtualized list (lib/virtualList/scrollSeek).
 * `placeholder(key)` is true for a row that came into view during a fast
 * reader scroll; render it as a stand-in of its believed height, stamped
 * data-seek so its measurement is not persisted.
 *
 * `wrote(top)` takes every scrollTop the list sets itself (the virtualizer's
 * scrollToFn), so its own corrections never read as the reader's speed.
 * `reader()` says whether the reader is scrolling right now. Both are stable
 * across renders.
 */
export function useScrollSeek(
  containerRef: React.RefObject<HTMLElement | null>,
  renderedKeys: () => Iterable<VirtualKey>,
) {
  const [seeking, setSeeking] = useState(false);
  const keepRef = useRef(makeSeekKeep());
  const keysRef = useRef(renderedKeys);
  keysRef.current = renderedKeys;
  const attachedRef = useRef<ReturnType<typeof attachScrollSeek> | null>(null);
  const handleRef = useRef({
    wrote: (top: number) => attachedRef.current?.wrote(top),
    reader: () => attachedRef.current?.reader() ?? false,
  });
  useMountEffect(() => {
    const sc = containerRef.current;
    if (!sc || VLIST_NO_SEEK) return;
    const attached = attachScrollSeek(sc, (next) => {
      if (next) keepRef.current.begin(keysRef.current());
      else keepRef.current.end();
      setSeeking(next);
    });
    attachedRef.current = attached;
    return () => { attachedRef.current = null; attached.detach(); };
  });
  return {
    seeking,
    placeholder: (key: VirtualKey) => seeking && keepRef.current.placeholder(key),
    wrote: handleRef.current.wrote,
    reader: handleRef.current.reader,
  };
}
