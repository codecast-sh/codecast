import { useState, useCallback } from "react";
import { useEventListener } from "../../../hooks/useEventListener";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { isElectron } from "../../../lib/desktop";

const SHORTCUT_LABELS: Record<string, string> = {
  toggleWindow: "Toggle Main Window",
  togglePalette: "Quick Command Palette",
  toggleEnv: "Switch Local / Prod",
};

const SHORTCUT_DESCRIPTIONS: Record<string, string> = {
  toggleWindow: "Show or hide the main Codecast window",
  togglePalette: "Open the floating command palette from anywhere",
  toggleEnv: "Switch between local dev and production",
};

function formatAccelerator(acc: string): string {
  return acc
    .replace("CommandOrControl", "\u2318")
    .replace("Control", "\u2303")
    .replace("Alt", "\u2325")
    .replace("Shift", "\u21E7")
    .replace("Space", "Space")
    .replace(/\+/g, " ");
}

function ShortcutRecorder({
  value,
  onChange,
}: {
  value: string;
  onChange: (accelerator: string) => void;
}) {
  const [recording, setRecording] = useState(false);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!recording) return;
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        setRecording(false);
        return;
      }

      if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;

      let key: string;
      if (e.code === "Space") {
        key = "Space";
      } else if (e.key.length === 1 || e.key === "\u00A0") {
        key = e.code.replace(/^Key/, "").replace(/^Digit/, "");
      } else {
        key = e.key;
      }

      const parts: string[] = [];
      if (e.ctrlKey && !e.metaKey) parts.push("Control");
      if (e.metaKey) parts.push("CommandOrControl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      parts.push(key);

      if (parts.length < 2) return;

      setRecording(false);
      onChange(parts.join("+"));
    },
    [recording, onChange]
  );

  useEventListener("keydown", handleKeyDown, recording ? document : null, { capture: true });

  return (
    <button
      onClick={() => setRecording(!recording)}
      className={`px-3 py-1.5 rounded-md border text-sm font-mono transition-colors min-w-[140px] text-center ${
        recording
          ? "border-sol-cyan bg-sol-cyan/10 text-sol-cyan animate-pulse"
          : "border-sol-border bg-sol-bg-alt text-sol-text hover:border-sol-text-dim"
      }`}
    >
      {recording ? "Press shortcut..." : formatAccelerator(value)}
    </button>
  );
}

export default function DesktopSettingsPage() {
  const [shortcuts, setShortcuts] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useMountEffect(() => {
    if (!isElectron()) return;
    window.__CODECAST_ELECTRON__!.getShortcuts().then(setShortcuts);
  });

  const updateShortcut = useCallback(async (key: string, accelerator: string) => {
    if (!isElectron()) return;
    setSaving(key);
    const updated = await window.__CODECAST_ELECTRON__!.setShortcut(key, accelerator);
    setShortcuts(updated);
    setSaving(null);
  }, []);

  if (!isElectron()) {
    return (
      <div className="text-sol-text-dim text-sm py-8 text-center">
        Desktop settings are only available in the Codecast desktop app.
      </div>
    );
  }

  if (!shortcuts) {
    return <div className="text-sol-text-dim text-sm py-4">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-sol-text mb-1">Keyboard Shortcuts</h2>
        <p className="text-sm text-sol-text-dim">
          Global shortcuts work from anywhere on your system, even when Codecast is in the background.
        </p>
      </div>

      <div className="space-y-3">
        {Object.entries(SHORTCUT_LABELS).map(([key, label]) => (
          <div
            key={key}
            className="flex items-center justify-between py-3 px-4 rounded-lg border border-sol-border/60 bg-sol-bg-alt/30"
          >
            <div>
              <div className="text-sm font-medium text-sol-text">{label}</div>
              <div className="text-xs text-sol-text-dim mt-0.5">
                {SHORTCUT_DESCRIPTIONS[key]}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <ShortcutRecorder
                value={shortcuts[key] || ""}
                onChange={(acc) => updateShortcut(key, acc)}
              />
              {saving === key && (
                <span className="text-xs text-sol-cyan">Saved</span>
              )}
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-sol-text-dim">
        Click a shortcut to re-record it. Press Escape to cancel.
      </p>
    </div>
  );
}
