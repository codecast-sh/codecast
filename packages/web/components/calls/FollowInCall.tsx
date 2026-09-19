"use client";

import { ArrowRight, X } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { getRoom } from "../../lib/calls/callManager";
import { firstName } from "./speakers";

// Follow mode on a call. A call is where following earns its keep: someone
// shares their screen and says "look at this", and the others can either
// watch pixels or follow them in the app, where the session, the doc, the
// decision are live and theirs to act on. So every remote person on the
// stage carries one small control, Follow or Stop following, and a shared
// screen carries it always, not only on hover. The state itself is drawn the
// same way everywhere else in the app: the followed person wears the cyan
// ring, and the presenter sees how many follow them.

/** This window's follow relation to one participant. */
function useCallFollow(identity: string): {
  isSelf: boolean;
  following: boolean;
  followers: number;
  toggle: () => void;
} {
  const following = useInboxStore((s) => s.followLeaderId === identity);
  const me = useInboxStore((s) => s.currentUser?._id?.toString?.() ?? null) ?? getRoom()?.localParticipant.identity ?? null;
  const isSelf = me === identity;
  const followers = useInboxStore((s) => (isSelf ? s.followedBy.length : 0));
  const toggle = () => {
    const st = useInboxStore.getState();
    if (st.followLeaderId === identity) st.setFollowLeader(null);
    else st.setFollowLeader(identity);
  };
  return { isSelf, following, followers, toggle };
}

/**
 * The control. `tile` sits in a video tile's chrome (black on white, like the
 * name chip beside it); `row` sits at the end of a roster row. On your own
 * tile it is not a control but a count: "2 following you".
 */
export function FollowChip({
  identity,
  name,
  variant,
  always = false,
}: {
  identity: string;
  name: string;
  variant: "tile" | "row";
  /** Shown at rest, not only on hover (a shared screen). */
  always?: boolean;
}) {
  const { isSelf, following, followers, toggle } = useCallFollow(identity);
  const base =
    variant === "tile"
      ? "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] backdrop-blur transition-all"
      : "inline-flex items-center gap-1 rounded-full px-1.5 py-px font-mono text-[10px] transition-all";
  const reveal = always || following ? "" : " opacity-0 group-hover:opacity-100 focus-visible:opacity-100";
  if (isSelf) {
    if (followers === 0) return null;
    return (
      <span
        data-sv-call-follow="followers"
        className={`${base} ${variant === "tile" ? "bg-black/45 text-white/90" : "bg-sol-bg-highlight text-sol-text-muted"}`}
        title={followers === 1 ? "One person is following you" : `${followers} people are following you`}
      >
        {followers} following you
      </span>
    );
  }
  return (
    <button
      type="button"
      data-sv-call-follow={following ? "following" : "follow"}
      onClick={(e) => {
        e.stopPropagation();
        toggle();
      }}
      aria-pressed={following}
      title={following ? `Stop following ${firstName(name)}` : `Follow ${firstName(name)}: your app mirrors theirs until you move`}
      className={`${base}${reveal} ${
        following
          ? variant === "tile"
            ? "bg-sol-cyan/90 text-white"
            : "bg-sol-cyan/20 text-sol-cyan"
          : variant === "tile"
            ? "bg-black/45 text-white/90 hover:bg-black/65"
            : "text-sol-text-muted hover:bg-sol-bg-highlight hover:text-sol-text"
      }`}
    >
      {following ? (
        <>
          Following
          <X className="h-3 w-3" />
        </>
      ) : (
        <>
          <ArrowRight className="h-3 w-3" />
          Follow
        </>
      )}
    </button>
  );
}
