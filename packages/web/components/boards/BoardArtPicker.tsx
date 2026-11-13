// The illustration picker: the painted set first, then the emoji stamps. The
// Stamp tool places what is picked as a sticker; a sticky's bar sets it as
// the sticky's illustration.
import { memo, useMemo, useState } from "react";
import { BOARD_ART } from "@codecast/shared/artifacts/board";
import { BOARD_ART_URLS } from "./boardArtUrls";
import { STAMPS } from "./boardColors";

export const BoardArtPicker = memo(function BoardArtPicker({ value, onPick, onClear, onClose, emoji = true }: {
  value?: string;
  /** Escape in the search field: the picker closes and the board has the keys again. */
  onClose(): void;
  onPick(name: string): void;
  /** Shown as the first cell when the target can go without one (a sticky's illustration). */
  onClear?: () => void;
  emoji?: boolean;
}) {
  const [q, setQ] = useState("");
  const art = useMemo(() => BOARD_ART.filter((a) => a.includes(q.trim().toLowerCase())), [q]);
  return (
    <div className="board-art-picker" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()} data-board-scroll>
      <input
        className="board-bar-link"
        placeholder="Search illustrations"
        aria-label="Search illustrations"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        // Opens ready for a search, as FigJam's sticker picker does.
        autoFocus
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && art[0]) onPick(art[0]);
          if (e.key === "Escape") { e.preventDefault(); onClose(); (e.currentTarget.closest("[data-board]") as HTMLElement | null)?.focus({ preventScroll: true }); }
        }}
      />
      <div className="board-art-grid">
        {onClear && !q && (
          <button type="button" className={`board-art-cell${!value ? " is-active" : ""}`} aria-label="No illustration" onClick={onClear}>
            <span className="board-art-none" aria-hidden />
          </button>
        )}
        {art.map((a) => (
          <button key={a} type="button" className={`board-art-cell${value === a ? " is-active" : ""}`} aria-label={a} title={a} onClick={() => onPick(a)}>
            <img src={BOARD_ART_URLS[a]} alt="" draggable={false} loading="lazy" />
          </button>
        ))}
        {emoji && !q && STAMPS.map((s) => (
          <button key={s} type="button" className={`board-art-cell is-emoji${value === s ? " is-active" : ""}`} aria-label={s} onClick={() => onPick(s)}>{s}</button>
        ))}
      </div>
    </div>
  );
});
