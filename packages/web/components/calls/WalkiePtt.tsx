// The mic button. The gesture it carries lives in hooks/useWalkie; this is only
// what a hold looks like, so the composer, a hover card and the receiver banner
// can each dress the same press differently.
import { Mic } from "lucide-react";
import { pttPointerProps, usePushToTalk } from "../../hooks/useWalkie";
import "./walkie.css";

export function WalkiePttButton({
  roomKey,
  resolveChannelId,
  label,
  className,
  title,
}: {
  roomKey: string | undefined;
  /** Called at press time, not at render: for a hover card the answer is "open
   *  the DM with this person", which must not happen merely on hover. */
  resolveChannelId: () => string | null;
  /** Absent = icon only, the composer's shape. */
  label?: string;
  className?: string;
  /** Overrides the idle tooltip; a blocked reason always wins over it. */
  title?: string;
}) {
  const ptt = usePushToTalk(roomKey, resolveChannelId);
  return (
    <button
      type="button"
      className={`${className ?? "ch-composer-attach"} walkie-ptt ${ptt.holding ? "walkie-ptt-on" : ""}`}
      disabled={!!ptt.reason}
      data-walkie-ptt={roomKey ?? ""}
      aria-pressed={ptt.holding}
      title={ptt.reason ?? title ?? "Hold to talk"}
      {...pttPointerProps(ptt)}
    >
      <Mic className="w-3.5 h-3.5" />
      {label && <span>{ptt.holding ? "Talking…" : label}</span>}
    </button>
  );
}
