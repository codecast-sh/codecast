"use client";

import { Eye, EyeOff, UserRound, X } from "lucide-react";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { CommentAvatar } from "../comments/CommentAvatar";
import { useInboxStore } from "../../store/inboxStore";
import { memberAvatarUrl } from "../../lib/liveEntities";
import { followersLabel, followersSig, type FollowerRow } from "../../lib/follow";
import { memberDisplayName } from "./memberPresence";
import { firstName } from "../calls/speakers";

// The follow state, in the top bar beside the faces. Following someone:
// their face, "Following Ann", and a stop. Followed: only the followers'
// faces, ringed in the follow cyan with a live dot, because the faces say who
// and the ring says what; names live in the tooltip. A click opens what a
// person does about a follower: stop sharing their view with them (first,
// the reason anyone reaches for it), follow them back, open their profile.

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
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-sol-cyan/40 bg-sol-cyan/10 pl-1 pr-1 text-[11px] text-sol-text"
        role="status"
      >
        <CommentAvatar name={name} image={memberAvatarUrl(leader)} size={20} />
        <span className="truncate max-w-[220px]">
          {st.followBlocked ? `${first} is somewhere you can't open` : `Following ${first}`}
        </span>
        <button
          type="button"
          onClick={() => st.setFollowLeader(null)}
          title={`Stop following ${first}`}
          aria-label={`Stop following ${first}`}
          className="grid h-5 w-5 place-items-center rounded-full text-sol-text-muted hover:bg-sol-cyan/20 hover:text-sol-text"
        >
          <X className="h-3 w-3" />
        </button>
      </span>
    );
  }
  const followers = st.followedBy;
  if (followers.length === 0) return null;
  return <FollowersPill followers={followers} />;
}

const MAX_FACES = 3;

function FollowersPill({ followers }: { followers: FollowerRow[] }) {
  const shown = followers.slice(0, MAX_FACES);
  const more = followers.length - shown.length;
  const label = followersLabel(followers);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-sv-follow-pill="followed"
          aria-label={`${label}: manage`}
          title={followers.map((f) => f.name).join(", ")}
          className="group relative inline-flex h-7 shrink-0 items-center rounded-full px-0.5 outline-none transition-transform duration-150 hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-sol-cyan/60 data-[state=open]:-translate-y-px"
        >
          <span className="flex items-center">
            {shown.map((f, i) => (
              <span
                key={f.user_id}
                className="relative rounded-full ring-2 ring-sol-cyan/70 ring-offset-1 ring-offset-sol-bg transition-[margin] duration-150 group-hover:ml-0.5 first:ml-0"
                style={{ marginLeft: i === 0 ? 0 : -6, zIndex: shown.length - i }}
              >
                <CommentAvatar name={f.name} image={f.image} size={20} />
              </span>
            ))}
            {more > 0 && (
              <span className="-ml-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-sol-cyan/15 px-1 font-mono text-[10px] text-sol-cyan ring-2 ring-sol-bg">
                +{more}
              </span>
            )}
          </span>
          {/* Live: your view is going out right now. */}
          <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-2 w-2" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sol-cyan/60 motion-reduce:hidden" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-sol-cyan ring-2 ring-sol-bg" />
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-64 p-1.5">
        <FollowersMenu followers={followers} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Mounted only while open: the router and mutations it needs are the menu's. */
function FollowersMenu({ followers }: { followers: FollowerRow[] }) {
  const router = useRouter();
  const drop = useMutation(api.follow.dropFollower);
  const stopSharing = (ids: string[]) => {
    const st = useInboxStore.getState();
    st.setFollowedBy(st.followedBy.filter((f) => !ids.includes(f.user_id)));
    for (const id of ids) drop({ follower_id: id as Id<"users"> }).catch(() => {});
  };
  return (
    <div data-sv-follow-menu>
      <div className="px-2 pb-1.5 pt-1 text-[11px] text-sol-text-muted">
        <Eye className="mr-1 inline h-3 w-3 -translate-y-px text-sol-cyan" />
        {followersLabel(followers)}
      </div>
      {followers.map((f, i) => {
        const first = firstName(f.name);
        const member = useInboxStore.getState().teamMembers.find((m: any) => String(m?._id) === f.user_id) as any;
        return (
          <div key={f.user_id}>
            {i > 0 && <DropdownMenuSeparator />}
            <div className="flex items-center gap-2 px-2 py-1.5">
              <CommentAvatar name={f.name} image={f.image} size={22} />
              <span className="truncate text-xs font-medium text-sol-text">{f.name}</span>
            </div>
            <DropdownMenuItem
              data-sv-follow-action="stop"
              onSelect={() => stopSharing([f.user_id])}
              className="gap-2 rounded-md bg-sol-cyan/10 text-xs text-sol-cyan focus:bg-sol-cyan/20 focus:text-sol-cyan"
            >
              <EyeOff className="h-3.5 w-3.5" />
              Stop sharing my view
            </DropdownMenuItem>
            <DropdownMenuItem
              data-sv-follow-action="follow-back"
              onSelect={() => useInboxStore.getState().setFollowLeader(f.user_id)}
              className="gap-2 text-xs"
            >
              <Eye className="h-3.5 w-3.5 text-sol-text-muted" />
              <span className="truncate">Follow {first} back</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              data-sv-follow-action="profile"
              onSelect={() => router.push(`/team/${member?.github_username || f.user_id}`)}
              className="gap-2 text-xs"
            >
              <UserRound className="h-3.5 w-3.5 text-sol-text-muted" />
              Open profile
            </DropdownMenuItem>
          </div>
        );
      })}
      {followers.length > 1 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => stopSharing(followers.map((f) => f.user_id))} className="gap-2 text-xs text-sol-text-muted">
            <EyeOff className="h-3.5 w-3.5" />
            Stop sharing with everyone
          </DropdownMenuItem>
        </>
      )}
    </div>
  );
}
