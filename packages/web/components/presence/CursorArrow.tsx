// The one arrow every drawn cursor wears: the agent's ghost over a browser
// stream and a teammate's pointer over a screen share. Same shape, same
// shadow, one colour per owner, so an arrow reads as "someone else's pointer"
// wherever it appears. The label is optional: a ghost carries a caption of
// typed text instead, a teammate carries their name.

export function CursorArrow({ color, label }: { color: string; label?: string }) {
  return (
    <>
      <svg width="28" height="36" viewBox="0 0 28 36" className="absolute left-0 top-0 drop-shadow-[0_1px_2px_rgba(0,0,0,0.35)]">
        <path
          d="M3 2 L3 27 L9 21 L13 31 L17 29 L13 20 L22 20 Z"
          fill={color}
          stroke="var(--sol-card)"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
      {label && (
        <span
          data-sv-cursor-label
          className="absolute left-5 top-7 max-w-[160px] truncate rounded-full px-2 py-px text-[11px] font-mono font-medium text-white whitespace-nowrap shadow-[0_1px_2px_rgba(0,0,0,0.35)]"
          style={{ backgroundColor: color }}
        >
          {label}
        </span>
      )}
    </>
  );
}
