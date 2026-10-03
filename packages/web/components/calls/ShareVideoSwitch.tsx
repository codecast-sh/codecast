import { setCallVideoShared } from "../../hooks/useRoomRecording";
import { Switch } from "../ui/switch";

// Whether a call's public link shows its video too. Off unless somebody turns
// it on for this very link (convex callRecordings.shareIncludesVideo): a link
// made to share a transcript never starts handing out faces and screens
// because Record was pressed later, and a link turned off and on again starts
// without. Only the room's recording is shared, never a single person's
// screen file.
export function ShareVideoSwitch({ call, shared, linkOn }: { call: string; shared: boolean; linkOn: boolean }) {
  // `shared` is the store's (callRecordingCalls.video_shared): the switch
  // moves on the press, and a refusal puts it back and says why.
  const on = linkOn && shared;
  return (
    <label className="flex items-start gap-2.5 pt-1">
      <Switch
        checked={on}
        disabled={!linkOn}
        aria-label="Include the video recording"
        onCheckedChange={(next) => setCallVideoShared(call, next)}
        className="mt-px"
      />
      <span className="min-w-0 text-xs leading-snug">
        <span className="block font-medium text-sol-text-secondary">Includes the video recording</span>
        <span className="block text-sol-text-muted">
          {linkOn
            ? on
              ? "Anyone with the link can watch the room's video, faces and shared screens."
              : "The link shows the transcript and summary only."
            : "Open the link to anyone first."}
        </span>
      </span>
    </label>
  );
}
