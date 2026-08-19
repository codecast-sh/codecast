import { useSyncExternalStore } from "react";
import { Mic, MicOff, Phone } from "lucide-react";
import { getMicLevel, leaveCall, setMuted, subscribeMicLevel } from "../../lib/calls/callManager";

// The two controls every call surface shares — pill, mini window and stage —
// so mute and hang up read the same everywhere.
//
//   MicButton: the mic glyph IS the meter. A thin green line along the button's
//   foot scales with the live level; muted turns the button red. One control,
//   no separate bar to decode.
//   HangUpButton: a solid red button with a plain handset turned to the
//   hang-up angle — the phone gesture everyone knows, no strikethrough.
//
// The level reads through useSyncExternalStore so its ~20fps ticks re-render
// only the button, never the surface around it.

const SIZES = {
  compact: { pad: "p-1.5", icon: "h-4 w-4", radius: "rounded-md" },
  regular: { pad: "p-2", icon: "h-[18px] w-[18px]", radius: "rounded-full" },
} as const;

export function MicButton({ muted, size = "regular" }: { muted: boolean; size?: keyof typeof SIZES }) {
  const level = useSyncExternalStore(subscribeMicLevel, getMicLevel, () => 0);
  const sz = SIZES[size];
  return (
    <button
      onClick={() => void setMuted(!muted)}
      className={`relative ${sz.radius} ${sz.pad} transition-colors ${
        muted ? "bg-sol-red/15 text-sol-red hover:bg-sol-red/25" : "text-sol-text-muted hover:bg-sol-bg-highlight hover:text-sol-text"
      }`}
      title={muted ? "Unmute" : "Mute"}
    >
      {muted ? <MicOff className={sz.icon} /> : <Mic className={sz.icon} />}
      {!muted && (
        <span
          className="absolute bottom-1 left-1 right-1 h-0.5 origin-left rounded-full bg-sol-green transition-transform duration-75"
          style={{ transform: `scaleX(${Math.min(1, level)})` }}
        />
      )}
    </button>
  );
}

export function HangUpButton({ size = "regular" }: { size?: keyof typeof SIZES }) {
  const sz = SIZES[size];
  return (
    <button
      onClick={() => void leaveCall()}
      className={`${sz.radius} ${sz.pad} ${size === "regular" ? "px-3.5" : ""} bg-sol-red text-white transition-colors hover:bg-sol-red/85`}
      title="End call"
    >
      <Phone className={`${sz.icon} rotate-[135deg]`} />
    </button>
  );
}
