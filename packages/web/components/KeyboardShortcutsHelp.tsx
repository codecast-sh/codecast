"use client";

import { X } from "lucide-react";
import { Button } from "./ui/button";

interface KeyboardShortcutsHelpProps {
  isOpen: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsHelp({ isOpen, onClose }: KeyboardShortcutsHelpProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-background border border-border rounded-lg shadow-lg p-6 max-w-md w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Keyboard Shortcuts</h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-6 w-6"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-3">
          <ShortcutRow keys={["j", "]"]} description="Next file/change" />
          <ShortcutRow keys={["k", "["]} description="Previous file/change" />
          <ShortcutRow keys={["v"]} description="Toggle unified/split view" />
          <ShortcutRow keys={["b"]} description="Toggle sidebar" />
          <ShortcutRow keys={["c"]} description="Toggle cumulative/single mode" />
          <ShortcutRow keys={["f"]} description="Toggle file tree" />
          <ShortcutRow keys={["Escape"]} description="Clear selection" />
          <ShortcutRow keys={["?"]} description="Show this help" />
        </div>

        <div className="mt-4 pt-4 border-t border-border">
          <p className="text-sm text-muted-foreground">
            Shortcuts are disabled when typing in input fields.
          </p>
        </div>
      </div>
    </div>
  );
}

function ShortcutRow({ keys, description }: { keys: string[]; description: string }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        {keys.map((key, i) => (
          <kbd
            key={i}
            className="px-2 py-1 text-xs font-mono bg-muted border border-border rounded"
          >
            {key}
          </kbd>
        ))}
      </div>
      <span className="text-sm text-muted-foreground">{description}</span>
    </div>
  );
}
