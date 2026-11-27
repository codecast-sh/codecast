import { UserPlus } from "lucide-react";
import { useAddToCall } from "./useCallFeed";
import { useScribe, type ScribeLive } from "./useScribe";

/** The call controls' add button: the same list as the thread's header. */
export function AddPeopleButton({
  roomKey,
  live,
  className = "",
  iconClassName = "h-4 w-4",
}: {
  roomKey: string;
  live: NonNullable<ScribeLive> | null;
  className?: string;
  iconClassName?: string;
}) {
  const scribe = useScribe(roomKey, live);
  const { open, adding } = useAddToCall({ roomKey, liveTranscriptId: live?.transcript_id ?? null, routes: live?.routes ?? [], teamId: live?.team_id, scribe });
  return (
    <button
      className={className || "rounded-md p-1.5 text-sol-text-muted transition-colors hover:bg-sol-bg-alt"}
      onClick={open}
      disabled={!!adding}
      title={adding ? "An agent is joining the call" : "Add to the call: ring a teammate, or bring in a role or an agent"}
    >
      <UserPlus className={iconClassName} />
    </button>
  );
}
