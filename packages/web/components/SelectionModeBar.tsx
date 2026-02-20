"use client";

export function SelectionModeBar({ onExit }: { onExit: () => void }) {
  return (
    <div className="sticky bottom-0 z-50 flex justify-center pb-2 pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-3 px-4 py-2 rounded-lg bg-sol-cyan/10 border border-sol-cyan/30 text-sol-cyan text-xs shadow-lg backdrop-blur-sm">
        <span className="font-medium">Selection Mode</span>
        <span className="text-sol-text-dim">|</span>
        <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border text-[10px]">j</kbd>/<kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border text-[10px]">k</kbd> navigate</span>
        <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border text-[10px]">f</kbd> fork</span>
        <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border text-[10px]">w</kbd> wipe &amp; resend</span>
        <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border text-[10px]">Enter</kbd> switch branch</span>
        <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border text-[10px]">t</kbd> tree</span>
        <button
          onClick={onExit}
          className="ml-1 px-2 py-0.5 rounded bg-sol-bg-alt border border-sol-border text-sol-text-dim hover:text-sol-text hover:border-sol-cyan/50 transition-colors text-[10px]"
        >
          Esc to exit
        </button>
      </div>
    </div>
  );
}
