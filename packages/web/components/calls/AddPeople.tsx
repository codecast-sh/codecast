import { UserPlus } from "lucide-react";
import { useAddToCall } from "./useCallFeed";

/** The call controls' add button: the same list as the thread's header. */
export function AddPeopleButton({
  roomKey,
  live,
  className = "",
  iconClassName = "h-4 w-4",
}: {
  roomKey: string;
  live: { transcript_id: string; routes?: Array<{ kind: string; target: string }> } | null;
  className?: string;
  iconClassName?: string;
}) {
  const { open, adding } = useAddToCall({ roomKey, liveTranscriptId: live?.transcript_id ?? null, routes: live?.routes ?? [] });
  return (
    <button
      className={className || "rounded-md p-1.5 text-sol-text-muted transition-colors hover:bg-sol-base02"}
      onClick={open}
      disabled={!!adding}
      title={adding ? "An agent is joining the call" : "Add to the call: ring a teammate, or bring in a role or an agent"}
    >
      <UserPlus className={iconClassName} />
    </button>
  );
}
