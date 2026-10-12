"use client";
// A popover hung under a header control (the Notebook's run picker and
// changes, the workspace's start switch): open until a press outside or Esc.
import { useRef, useState } from "react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";

export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useWatchEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", down);
    window.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", down); window.removeEventListener("keydown", key, true); };
  }, [open]);
  return { open, setOpen, ref };
}
