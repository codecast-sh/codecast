import { useRef, type ReactNode } from "react";
import { Command, useCommandState } from "cmdk";
import { useWatchEffect } from "../hooks/useWatchEffect";

export function CommandPaletteList({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const search = useCommandState((state) => state.search);

  useWatchEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
  }, [search]);

  return (
    <Command.List ref={ref} className="max-h-[min(60vh,480px)] overflow-y-auto overscroll-contain py-1.5" style={{ overflowAnchor: "none" }}>
      {children}
    </Command.List>
  );
}
