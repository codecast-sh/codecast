import { useState, type ReactNode } from "react";
import { Clock, DoorClosed, Hand, LogOut, MonitorX, PhoneOff, Unlink, UserX, WifiOff } from "lucide-react";
import { copyToClipboard } from "../../../lib/utils";
import { GUEST_LINK_REFUSAL_PARTS, type CallGuestView, type GuestLinkRefusal } from "@codecast/shared/contracts";
import { useCoarseNow } from "../../../hooks/useCoarseNow";

// Every way a guest's visit can stop short of the call or end after it, in
// plain words: what happened, whether it was anything they did, and the one
// thing they can do next (often nothing, and then the page says so rather
// than offering a button that would only fail).

const REFUSAL_TITLE: Record<GuestLinkRefusal, string> = {
  not_found: "This link doesn't open anything",
  revoked: "This link was turned off",
  expired: "This link has expired",
  unavailable: "This meeting isn't taking guests",
  inviter_gone: "This link no longer works",
};

/** The words under a refusal's heading: what to do next, plus why when the
 *  heading alone does not say it (a link that "no longer works" because its
 *  sender lost the standing to invite). Never the heading again. */
function refusalBody(reason: GuestLinkRefusal): string {
  const { what, next } = GUEST_LINK_REFUSAL_PARTS[reason];
  return reason === "inviter_gone" ? `${what} ${next}` : next;
}

export type Outcome =
  | { kind: "refused"; reason: GuestLinkRefusal }
  | {
      kind: "view";
      view: Exclude<CallGuestView, "waiting" | "admitted">;
      leftReason: string | null;
      retryAt: number | null;
      canAskAgain: boolean;
      /** The place was let go without anybody deciding it, and is still theirs
       *  to walk back into: the action rejoins, no knock. */
      resumable?: boolean;
      reason?: GuestLinkRefusal;
      /** The page is still telling the server about the guest's own Leave:
       *  the way back in waits for that, or it would be undone by it. */
      pending?: boolean;
    }
  | { kind: "unreachable" }
  /** This browser cannot hold a call (an app's built-in browser with no
   *  WebRTC or no way to open a device): the link is fine, the place to open
   *  it is not. */
  | { kind: "unsupported" };

/** `onAskAgain` is the one action an outcome offers: back to the lobby to
 *  ask again (the notice and the camera are seen again first), straight back
 *  into a place still held (`resumable`), or another try for a page that
 *  could not reach the call. A browser that cannot join gets the link to
 *  carry to one that can, which is this component's own to copy. */
export function GuestOutcome({ outcome, onAskAgain, busy, error }: { outcome: Outcome; onAskAgain: () => void; busy: boolean; error: string | null }) {
  const now = useCoarseNow(1000);
  let icon: ReactNode;
  let title: string;
  let text: string;
  let action: { label: string; disabled?: boolean; busy?: string } | null = null;
  const [copied, setCopied] = useState<null | "copied" | "failed">(null);

  if (outcome.kind === "unreachable") {
    icon = <WifiOff />;
    title = "Couldn't reach the call";
    text = "The page could not load this meeting. Check your connection, then try again. It also tries by itself when the connection is back.";
    action = { label: "Try again" };
  } else if (outcome.kind === "unsupported") {
    icon = <MonitorX />;
    title = "This browser can't join calls";
    text =
      "Links opened inside a mail or chat app often land in a small built-in browser with no camera, microphone or call support. Open this link in Safari, Chrome, Firefox or Edge and you can join from there.";
  } else if (outcome.kind === "refused") {
    icon = <Unlink />;
    title = REFUSAL_TITLE[outcome.reason];
    text = refusalBody(outcome.reason);
  } else {
    const { view, leftReason, retryAt, canAskAgain, resumable } = outcome;
    if (view === "denied") {
      const wait = retryAt ? Math.max(0, retryAt - now) : 0;
      icon = <Hand />;
      title = "Not this time";
      text =
        wait > 0
          ? `The people in the call didn't let you in. You can ask again in ${Math.ceil(wait / 1000)}s.`
          : "The people in the call didn't let you in. You can ask again now.";
      if (canAskAgain) action = { label: "Ask again", disabled: wait > 0 };
    } else if (view === "removed") {
      icon = <UserX />;
      title = "You were removed from the call";
      // Only what the server enforces: this visit is over, and the link is
      // closed only when somebody closed it.
      text = canAskAgain ? "Someone in the call removed you." : "Someone in the call removed you. This link no longer works.";
    } else if (view === "ended") {
      icon = <PhoneOff />;
      title = "The call has ended";
      text = canAskAgain
        ? "Everyone from the team has left. If they start again, you can ask to join from this same link."
        : "Everyone from the team has left. Thanks for joining.";
      if (canAskAgain) action = { label: "Ask to join again" };
    } else if (view === "left") {
      if (leftReason === "lapsed") {
        icon = <WifiOff />;
        title = "You were disconnected";
        text = resumable
          ? "Your page lost touch with the call for a while. Your place is still held, so you can go straight back in."
          : "Your page lost touch with the call for too long, so your place in it was let go.";
        if (resumable) action = { label: "Rejoin", busy: "Joining…" };
        else if (canAskAgain) action = { label: "Ask to join again" };
      } else if (leftReason === "not_joined") {
        icon = <Clock />;
        title = "You didn't join in time";
        text = resumable
          ? "You were let in, but the call didn't hear from you for a few minutes, so your place was let go. It's still held for a little while."
          : "You were let in, but didn't join, so your place was let go.";
        if (resumable) action = { label: "Join now", busy: "Joining…" };
        else if (canAskAgain) action = { label: "Ask to join again" };
      } else {
        icon = <LogOut />;
        title = "You left the call";
        text = canAskAgain ? "Changed your mind? You can ask to join again; someone inside lets you back in." : "Thanks for joining.";
        if (canAskAgain) action = { label: "Rejoin", disabled: outcome.pending };
      }
    } else {
      // closed: the link stopped working while they waited at the door.
      icon = <DoorClosed />;
      title = outcome.reason ? REFUSAL_TITLE[outcome.reason] : "This link was closed";
      text = refusalBody(outcome.reason ?? "revoked");
    }
  }

  return (
    <div className="meet-rise mx-auto flex w-full max-w-[460px] flex-1 flex-col items-center justify-center gap-4 px-6 pb-16 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/[0.04] text-sol-text-muted ring-1 ring-white/[0.07] [&>svg]:h-6 [&>svg]:w-6">
        {icon}
      </span>
      <h1 className="meet-title text-balance text-[28px] leading-tight text-sol-text">{title}</h1>
      <p className="text-pretty text-[13px] leading-relaxed text-sol-text-muted">{text}</p>
      {action && (
        <button
          type="button"
          disabled={busy || action.disabled}
          onClick={onAskAgain}
          className="mt-2 rounded-xl bg-sol-cyan px-5 py-2.5 text-[13.5px] font-semibold text-sol-base03 transition-[transform,opacity] hover:bg-[#33b3a9] active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-45"
        >
          {busy ? (action.busy ?? "Asking…") : action.label}
        </button>
      )}
      {outcome.kind === "unsupported" && (
        <div className="mt-2 flex w-full flex-col items-center gap-2">
          {/* Selectable as well as copyable: the browsers this screen is for
              are the ones most likely to refuse the clipboard too. */}
          <input
            readOnly
            value={typeof location === "undefined" ? "" : location.href}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="This meeting's link"
            className="w-full rounded-lg bg-white/[0.04] px-3 py-2 text-center font-mono text-[11.5px] text-sol-text-secondary outline-none ring-1 ring-white/10 focus:ring-sol-cyan/60"
            style={{ fontVariantLigatures: "none" }}
          />
          <button
            type="button"
            onClick={() =>
              void copyToClipboard(location.href)
                .then(() => setCopied("copied"))
                .catch(() => setCopied("failed"))
            }
            className="rounded-xl bg-sol-cyan px-5 py-2.5 text-[13.5px] font-semibold text-sol-base03 transition-[transform,opacity] hover:bg-[#33b3a9] active:scale-[0.985]"
          >
            {copied === "copied" ? "Link copied" : "Copy link"}
          </button>
          {copied === "failed" && (
            <p role="status" className="text-[12px] text-sol-orange">
              Couldn't copy here. Press and hold the link above to copy it.
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-[12px] text-sol-orange">
          {error}
        </p>
      )}
    </div>
  );
}
