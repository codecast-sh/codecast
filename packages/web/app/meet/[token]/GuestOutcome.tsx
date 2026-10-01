import type { ReactNode } from "react";
import { DoorClosed, Hand, LogOut, PhoneOff, Unlink, UserX, WifiOff } from "lucide-react";
import { GUEST_LINK_REFUSAL_TEXT, type CallGuestView, type GuestLinkRefusal } from "@codecast/shared/contracts";
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

export type Outcome =
  | { kind: "refused"; reason: GuestLinkRefusal }
  | { kind: "view"; view: Exclude<CallGuestView, "waiting" | "admitted">; leftReason: string | null; retryAt: number | null; canAskAgain: boolean; reason?: GuestLinkRefusal }
  | { kind: "unreachable" };

export function GuestOutcome({ outcome, onAskAgain, busy, error }: { outcome: Outcome; onAskAgain: () => void; busy: boolean; error: string | null }) {
  const now = useCoarseNow(1000);
  let icon: ReactNode;
  let title: string;
  let text: string;
  let action: { label: string; disabled?: boolean } | null = null;

  if (outcome.kind === "unreachable") {
    icon = <WifiOff />;
    title = "Couldn't reach the call";
    text = "The page could not load this meeting. Check your connection and reload.";
  } else if (outcome.kind === "refused") {
    icon = <Unlink />;
    title = REFUSAL_TITLE[outcome.reason];
    text = GUEST_LINK_REFUSAL_TEXT[outcome.reason];
  } else {
    const { view, leftReason, retryAt, canAskAgain } = outcome;
    if (view === "denied") {
      const wait = retryAt ? Math.max(0, retryAt - now) : 0;
      icon = <Hand />;
      title = "Not this time";
      text =
        wait > 0
          ? `The people in the call didn't let you in. You can ask again in ${Math.ceil(wait / 1000)}s.`
          : "The people in the call didn't let you in. You can ask once more.";
      if (canAskAgain) action = { label: "Ask again", disabled: wait > 0 };
    } else if (view === "removed") {
      icon = <UserX />;
      title = "You were removed from the call";
      text = "Someone in the call removed you, and this link won't let you back in.";
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
        text = "Your page lost touch with the call for too long, so your place in it was let go.";
        if (canAskAgain) action = { label: "Ask to join again" };
      } else {
        icon = <LogOut />;
        title = "You left the call";
        text = canAskAgain ? "Changed your mind? You can ask to join again; someone inside lets you back in." : "Thanks for joining.";
        if (canAskAgain) action = { label: "Rejoin" };
      }
    } else {
      // closed: the link stopped working while they waited at the door.
      icon = <DoorClosed />;
      title = outcome.reason ? REFUSAL_TITLE[outcome.reason] : "This link was closed";
      text = outcome.reason ? GUEST_LINK_REFUSAL_TEXT[outcome.reason] : GUEST_LINK_REFUSAL_TEXT.revoked;
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
          {busy ? "Asking…" : action.label}
        </button>
      )}
      {error && (
        <p role="alert" className="text-[12px] text-sol-orange">
          {error}
        </p>
      )}
    </div>
  );
}
