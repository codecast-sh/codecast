import { KeyCap } from "./KeyboardShortcutsHelp";

export function SelectionModeBar({ onExit }: { onExit: () => void }) {
  return (
    <div className="sticky bottom-0 z-50 flex justify-center pb-2 pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-3 px-4 py-2 rounded-lg bg-sol-cyan/10 border border-sol-cyan/30 text-sol-cyan text-xs shadow-lg backdrop-blur-sm">
        <span className="font-medium">Selection Mode</span>
        <span className="text-sol-text-dim">|</span>
        <span className="flex items-center gap-1"><span className="flex items-center gap-[2px]"><KeyCap size="xs">J</KeyCap><span className="text-sol-text-dim/40">/</span><KeyCap size="xs">K</KeyCap></span> navigate</span>
        <span className="flex items-center gap-1"><KeyCap size="xs">F</KeyCap> fork</span>
        <span className="flex items-center gap-1"><KeyCap size="xs">W</KeyCap> wipe & resend</span>
        <span className="flex items-center gap-1"><KeyCap size="xs">Enter</KeyCap> switch branch</span>
        <span className="flex items-center gap-1"><KeyCap size="xs">T</KeyCap> tree</span>
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
