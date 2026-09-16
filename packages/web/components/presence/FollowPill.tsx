"use client";

import { X } from "lucide-react";
import { CommentAvatar } from "../comments/CommentAvatar";
import { useInboxStore } from "../../store/inboxStore";
import { memberAvatarUrl } from "../../lib/liveEntities";
import { followersLabel, followersSig } from "../../lib/follow";
import { memberDisplayName } from "./memberPresence";

// The follow state, in the top bar beside the faces. Following someone:
// their face, "Following Ann", and a stop. Followed: the followers' faces and
// "Bob is following you". Both are quiet pills; the followed face in the bar
// wears the selected ring as well, so the state reads from the faces alone.

export function FollowPill() {
  // Primitive selectors only: a leader id, a flag, a signature, a name. The
  // roster row itself is read at render, never subscribed, so a heartbeat
  // push cannot wake this pill.
  const leaderId = useInboxStore((s) => s.followLeaderId);
  const blocked = useInboxStore((s) => s.followBlocked);
  const followersKey = useInboxStore((s) => followersSig(s.followedBy));
  const leaderName = useInboxStore((s) =>
    s.followLeaderId ? memberDisplayName(s.teamMembers.find((m: any) => String(m?._id) === s.followLeaderId)) : "",
  );
  const st = { setFollowLeader: useInboxStore.getState().setFollowLeader, followBlocked: blocked, followedBy: useInboxStore.getState().followedBy };
  void followersKey;
  if (leaderId) {
    const leader = useInboxStore.getState().teamMembers.find((m: any) => String(m?._id) === leaderId);
    const name = leaderName || memberDisplayName(leader);
    const first = name.split(/\s+/)[0] || name;
    return (
      <span
        data-sv-follow-pill="following"
        className="inline-flex items-center gap-1.5 rounded-full border border-sol-cyan/40 bg-sol-cyan/10 pl-1 pr-1 py-0.5 text-[11px] text-sol-text"
        role="status"
      >
        <CommentAvatar name={name} image={memberAvatarUrl(leader)} size={16} />
        <span className="truncate max-w-[220px]">
          {st.followBlocked ? `${first} is somewhere you can't open` : `Following ${first}`}
        </span>
        <button
          type="button"
          onClick={() => st.setFollowLeader(null)}
          title={`Stop following ${first}`}
          aria-label={`Stop following ${first}`}
          className="grid h-4 w-4 place-items-center rounded-full text-sol-text-muted hover:bg-sol-cyan/20 hover:text-sol-text"
        >
          <X className="h-3 w-3" />
        </button>
      </span>
    );
  }
  const followers = st.followedBy;
  if (followers.length === 0) return null;
  return (
    <span
      data-sv-follow-pill="followed"
      className="inline-flex items-center gap-1.5 rounded-full border border-sol-border bg-sol-bg-alt/60 pl-1 pr-2 py-0.5 text-[11px] text-sol-text-muted"
      role="status"
      title={followers.map((f) => f.name).join(", ")}
    >
      <span className="cc-viewers" style={{ ["--cc-viewers-overlap" as string]: "5px" }}>
        {followers.slice(0, 3).map((f) => (
          <CommentAvatar key={f.user_id} name={f.name} image={f.image} size={16} />
        ))}
      </span>
      <span className="truncate max-w-[280px]">{followersLabel(followers)}</span>
    </span>
  );
}
