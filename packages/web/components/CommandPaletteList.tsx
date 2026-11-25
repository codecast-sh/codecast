import { useRef, type ReactNode } from "react";
import { Command, useCommandState } from "cmdk";
import { useWatchEffect } from "../hooks/useWatchEffect";

// A new search puts the list back at the top, where its first row (the one
// cmdk selects) is in view. Each typed character must touch no geometry
// (ct-101383): a scrollTop write makes the browser lay out the page to clamp
// it, so the list remembers from its own scroll events whether it has left
// the top and writes only then. data-cmdk-scrolls-top-on-search tells cmdk
// (patches/cmdk@1.1.1.patch) to skip its scrollIntoView of that first row,
// which here would always be a no-op that still forces a layout.
export function CommandPaletteList({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  const search = useCommandState((state) => state.search);

  useWatchEffect(() => {
    if (ref.current && scrolled.current) {
      ref.current.scrollTop = 0;
      scrolled.current = false;
    }
  }, [search]);

  return (
    <Command.List
      ref={ref}
      data-cmdk-scrolls-top-on-search=""
      onScroll={(e) => { scrolled.current = e.currentTarget.scrollTop > 0; }}
      className="max-h-[min(60vh,480px)] overflow-y-auto overscroll-contain py-1.5"
      style={{ overflowAnchor: "none" }}
    >
      {children}
    </Command.List>
  );
}
