import { LivePulseDot } from "../SessionActivityLine";

/** The switch drawn from props: whether the room is transcribing, and what pressing it does. */
export function TranscribeSwitchView({ on, onToggle, className = "" }: { on: boolean; onToggle: () => void; className?: string }) {
  return (
    <button
      onClick={onToggle}
      role="switch"
      aria-checked={on}
      className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10.5px] transition-colors ${
        on
          ? "bg-sol-green/10 text-sol-green hover:bg-sol-red/10 hover:text-sol-red"
          : "bg-white/[0.06] text-sol-text-muted hover:bg-sol-green/10 hover:text-sol-green"
      } ${className}`}
      title={
        on
          ? "Transcribing. Click to stop for the whole huddle; the words so far stay in this thread."
          : "Not transcribing. Click to start; every word lands in this thread."
      }
    >
      {on ? <LivePulseDot className="h-1.5 w-1.5" /> : <span className="h-1.5 w-1.5 rounded-full bg-sol-text-dim" />}
      <span>
        <span className="ts-switch-word">transcribing · </span>
        {on ? "on" : "off"}
      </span>
    </button>
  );
}
