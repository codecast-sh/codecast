// The board's shortcut sheet (?): every key the canvas answers to, grouped by
// what a person is doing. Opens over the canvas's corner; Escape or ? closes it.
import { memo } from "react";
import { X } from "lucide-react";
import { KeyCap } from "../KeyCap";
import { isMac } from "../../shortcuts/registry";

const MOD = isMac ? "⌘" : "Ctrl";
const SHIFT = isMac ? "⇧" : "Shift";

const GROUPS: { title: string; rows: [string, string[]][] }[] = [
  { title: "Tools", rows: [["Select", ["V"]], ["Hand", ["H"]], ["Sticky", ["S"]], ["Text", ["T"]], ["Shape", ["R"]], ["Arrow", ["L"]], ["Frame", ["F"]], ["Pen", ["P"]], ["Stamp", ["E"]], ["Comment", ["C"]], ["Codecast object", ["O"]], ["Keep tool on", ["Q"]], ["Ask agent", ["A"]]] },
  { title: "Selection", rows: [["Next / previous element", ["Tab", `${SHIFT} Tab`]], ["Edit", ["Enter"]], ["Nudge", ["←↑→↓"]], ["Nudge 10", [SHIFT, "←↑→↓"]], ["Select all", [MOD, "A"]], ["Duplicate", [MOD, "D"]], ["Group / ungroup", [MOD, "G"]], ["Front / back", ["]", "["]], ["Delete", ["⌫"]], ["Deselect", ["Esc"]]] },
  { title: "While typing", rows: [["Bold / italic", [MOD, "B / I"]], ["Link", [MOD, "K"]], ["Next sticky right / below", ["Tab", `${SHIFT} Tab`]], ["Done", ["Esc"]]] },
  { title: "View", rows: [["Zoom in / out", [MOD, "+ / −"]], ["100%", [MOD, "0"]], ["Fit everything", [SHIFT, "1"]], ["Zoom to selection", [SHIFT, "2"]], ["Pan", ["Space", "drag"]], ["Undo / redo", [`${MOD} Z`, `${SHIFT}${MOD} Z`]]] },
];

export const BoardShortcuts = memo(function BoardShortcuts({ onClose }: { onClose(): void }) {
  return (
    <div
      data-board-ui
      role="dialog"
      aria-label="Board shortcuts"
      style={{ position: "absolute", right: 12, bottom: 72, zIndex: 30, width: 560, maxWidth: "calc(100% - 24px)", maxHeight: "calc(100% - 140px)", overflow: "auto", padding: "12px 14px", background: "var(--sol-card)", border: "1px solid var(--sol-border)", borderRadius: 12, boxShadow: "var(--board-chrome-shadow)" }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span className="text-sm font-medium text-sol-text">Shortcuts</span>
        <button type="button" className="board-bar-btn" aria-label="Close" onClick={onClose}><X size={14} strokeWidth={1.75} /></button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "10px 24px" }}>
        {GROUPS.map((g) => (
          <section key={g.title}>
            <div className="text-xs text-sol-text-dim" style={{ marginBottom: 4 }}>{g.title}</div>
            {g.rows.map(([label, keys]) => (
              <div key={label} className="text-xs text-sol-text-muted" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "3px 0" }}>
                <span>{label}</span>
                <span style={{ display: "flex", gap: 3 }}>{keys.map((k) => <KeyCap key={k}>{k}</KeyCap>)}</span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
});
