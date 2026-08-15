import { KeyCap } from "../KeyboardShortcutsHelp";

// The key legend under a chat dialog. The same three gestures the command
// palette teaches, in the same glyphs, so a reader who learned one surface has
// learned them all.
export function ChatModalLegend({ enterLabel }: { enterLabel: string }) {
  return (
    <div className="ch-modal-legend" aria-hidden="true">
      <span>
        <KeyCap size="xs">{"↑"}</KeyCap>
        <KeyCap size="xs">{"↓"}</KeyCap>
        navigate
      </span>
      <span>
        <KeyCap size="xs">{"↩"}</KeyCap>
        {enterLabel}
      </span>
      <span>
        <KeyCap size="xs">Esc</KeyCap>
        close
      </span>
    </div>
  );
}
