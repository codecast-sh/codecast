"use client";

import { useEffect, useCallback } from "react";
import { X } from "lucide-react";

interface SlideOutPanelProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  width?: string;
  children: React.ReactNode;
}

export function SlideOutPanel({
  open,
  onClose,
  title,
  width = "w-[420px]",
  children,
}: SlideOutPanelProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (open) {
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
  }, [open, handleKeyDown]);

  return (
    <>
      <div
        className={`fixed inset-0 z-[190] bg-black/40 transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={onClose}
      />

      <div
        className={`fixed inset-y-0 right-0 z-[200] ${width} max-w-[90vw] bg-sol-bg border-l border-sol-border shadow-2xl transition-transform duration-250 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-sol-border/30">
          {title && (
            <h2 className="text-sm font-semibold text-sol-text truncate pr-4">
              {title}
            </h2>
          )}
          <button
            onClick={onClose}
            className="ml-auto p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="h-[calc(100%-49px)] overflow-y-auto overflow-x-hidden">
          {children}
        </div>
      </div>
    </>
  );
}
