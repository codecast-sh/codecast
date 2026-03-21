import { useMemo } from "react";
import { X } from "lucide-react";
import { Button } from "./ui/button";
import { SHORTCUTS, formatShortcut, getShortcutsByContext } from "../shortcuts";
import type { ShortcutDef } from "../shortcuts";

interface KeyboardShortcutsHelpProps {
  isOpen: boolean;
  onClose: () => void;
  context?: string;
}

const SECTION_ORDER: { when: string | undefined; label: string }[] = [
  { when: undefined, label: "Global" },
  { when: "conversation", label: "Conversation" },
  { when: "inbox", label: "Inbox" },
  { when: "review", label: "Review" },
  { when: "desktop", label: "Desktop" },
];

export function KeyboardShortcutsHelp({ isOpen, onClose, context }: KeyboardShortcutsHelpProps) {
  const sections = useMemo(() => {
    const seen = new Set<string>();
    const result: { label: string; shortcuts: ShortcutDef[] }[] = [];
    for (const { when, label } of SECTION_ORDER) {
      if (context && when !== undefined && when !== context) continue;
      const defs = getShortcutsByContext(when).filter(d => {
        const key = `${d.action}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (defs.length > 0) result.push({ label, shortcuts: defs });
    }
    return result;
  }, [context]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-[200] flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-background border border-border rounded-lg shadow-lg p-6 max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto"
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

        <div className="space-y-4">
          {sections.map(({ label, shortcuts }) => (
            <div key={label}>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">{label}</h3>
              <div className="space-y-2">
                {shortcuts.map((def) => (
                  <ShortcutRow key={def.action} keys={[formatShortcut(def)]} description={def.description} />
                ))}
              </div>
            </div>
          ))}
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
