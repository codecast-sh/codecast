import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import { humanizeConvexError } from "@codecast/shared/contracts";
import { Switch } from "../ui/switch";

// Whether a call's public link shows its video too. Off unless somebody turns
// it on for this very link (convex callRecordings.shareIncludesVideo): a link
// made to share a transcript never starts handing out faces and screens
// because Record was pressed later, and a link turned off and on again starts
// without. Only the room's recording is shared, never a single person's
// screen file.
export function ShareVideoSwitch({ call, shared, linkOn }: { call: string; shared: boolean; linkOn: boolean }) {
  const setShareVideo = useMutation(api.callRecordings.setCallShareVideo);
  // The switch moves on the press; the query's echo settles it, and a refusal
  // puts it back and says why.
  const [pending, setPending] = useState<boolean | null>(null);
  const on = linkOn && (pending ?? shared);
  if (pending !== null && pending === shared) setPending(null);
  return (
    <label className="flex items-start gap-2.5 pt-1">
      <Switch
        checked={on}
        disabled={!linkOn}
        aria-label="Include the video recording"
        onCheckedChange={(next) => {
          setPending(next);
          void setShareVideo({ call, include: next }).catch((err) => {
            setPending(null);
            toast.error(humanizeConvexError(err));
          });
        }}
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
