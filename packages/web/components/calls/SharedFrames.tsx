import { useState } from "react";
import { ExternalLink, MonitorUp, Trash2 } from "lucide-react";
import { recordingSubject } from "@codecast/shared/contracts";
import { formatCallTime } from "@codecast/shared/entities";
import { takeDownFrameShare, useCallFrameShares, type CallFrameShare } from "../../hooks/useRoomRecording";
import { ParticipantTag } from "./GuestTag";
import { firstName } from "./speakers";

// The pictures of a call on public links (`cast call snap --share`), under
// the call's share control: what anyone outside codecast can open of it
// besides the link itself. A picture of a face or a screen reaches as far as
// the video on the link does, so the people who can read the call see each
// one (the moment, whose screen or the room, who shared it), open it as the
// public sees it, and take it down. Taking one down is anyone's who can read
// the call, as taking the video off the link is: it only makes the call less
// public. The room's thread has a line for each picture shared.
export function SharedFrames({ call }: { call: string }) {
  const shares = useCallFrameShares(call);
  if (shares.length === 0) return null;
  return (
    <div className="space-y-1.5 pt-2" role="group" aria-label="Pictures shared by link">
      <p className="text-xs font-medium text-sol-text-secondary">
        {shares.length === 1 ? "1 picture" : `${shares.length} pictures`} shared by link
      </p>
      <p className="text-xs leading-snug text-sol-text-muted">Anyone with a picture's link can open it, with or without the call's link.</p>
      <ul className="space-y-1">
        {shares.map((s) => (
          <SharedFrameRow key={s._id} share={s} />
        ))}
      </ul>
    </div>
  );
}

function SharedFrameRow({ share }: { share: CallFrameShare }) {
  const [confirming, setConfirming] = useState(false);
  const time = share.at_ms != null ? formatCallTime(share.at_ms) : null;
  const subject = share.kind ? recordingSubject({ kind: share.kind, participant_name: share.participant_name, participant_identity: share.participant_identity }, "label") : null;
  const when = new Date(share.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <li className="flex items-center gap-2 rounded-md bg-sol-bg-alt/40 p-1 pr-1.5" data-frame-share={share._id}>
      {share.url ? (
        <img src={share.url} alt={time ? `The call at ${time}` : "A picture of the call"} className="h-9 w-16 shrink-0 rounded-sm bg-black object-cover" loading="lazy" draggable={false} />
      ) : (
        <span className="h-9 w-16 shrink-0 rounded-sm bg-black/60" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 text-xs leading-tight">
        <span className="flex items-center gap-1 text-sol-text-secondary">
          {time && <span className="font-mono tabular-nums">{time}</span>}
          {subject && (
            <span className="flex min-w-0 items-center gap-1 truncate text-sol-text-muted">
              {share.kind === "screen" && <MonitorUp className="h-3 w-3 shrink-0" />}
              <span className="truncate">{subject}</span>
              {share.kind === "screen" && <ParticipantTag identity={share.participant_identity} name={share.participant_name} />}
            </span>
          )}
        </span>
        <span className="block truncate text-sol-text-dim">
          by {firstName(share.shared_by_name)} · {when}
        </span>
      </span>
      {confirming ? (
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => takeDownFrameShare(share._id)}
            className="rounded px-1.5 py-0.5 text-[11px] font-medium text-sol-red transition-colors hover:bg-sol-red/10"
          >
            Take down
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded px-1.5 py-0.5 text-[11px] text-sol-text-muted transition-colors hover:bg-sol-text-muted/10 hover:text-sol-text"
          >
            Keep
          </button>
        </span>
      ) : (
        <span className="flex shrink-0 items-center">
          {share.url && (
            <a
              href={share.url}
              target="_blank"
              rel="noreferrer"
              className="rounded p-1 text-sol-text-dim transition-colors hover:bg-sol-text-muted/10 hover:text-sol-text"
              title="Open the picture as anyone with its link sees it"
              aria-label="Open the picture"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded p-1 text-sol-text-dim transition-colors hover:bg-sol-red/10 hover:text-sol-red"
            title="Take this picture off its link"
            aria-label="Take this picture off its link"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </span>
      )}
    </li>
  );
}
