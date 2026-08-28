import { useCallsAvailable } from "../lib/teamFeatures";
import { useQuery } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { UserRound, Filter, Link2, Headphones, MessageSquare } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useConvexSync } from "../hooks/useConvexSync";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { copyToClipboard, shareOrigin } from "../lib/utils";
import { ContextMenu, useContextMenu, CtxItem, CtxHeader } from "./ui/context-menu";
import {
  PRESENCE_META,
  compareMembersByPresence,
  localTimeLine,
  memberDisplayName,
  presenceLine,
  teamBarSig,
} from "./presence/memberPresence";
import { MemberFace } from "./presence/MemberFace";
import { TeamBarFace } from "./presence/TeamBarFace";
import { useWalkieFaces } from "./presence/useFaceKey";
import { useMemberActivity } from "./presence/useMemberActivity";
import { useMemberHuddle } from "./presence/useMemberHuddle";
import { PopOutPeopleButton } from "./people/PopOutPeopleButton";
import { useOpenDm } from "../hooks/useChatSync";
import { ErrorBoundary } from "./ErrorBoundary";
import "./calls/walkie.css";
import "./people/people.css";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

interface TeamAvatarBarProps {
  teamId?: Id<"teams">;
}

// Data pump, isolated so the live query's push rate never re-renders the
// visible bar: getTeamMembers re-emits every few seconds (teammates' presence
// heartbeats), and a useQuery in the display component re-rendered the whole
// avatar row on each push. The pump renders nothing; the bar below reads the
// store, whose teamMembers ref only changes when something displayable changed
// (the sync layer quantizes presence timestamps and bails on identical pushes).
export function TeamMembersPump({ teamId }: { teamId: Id<"teams"> | undefined }) {
  const teamMembersQuery = useQuery(
    api.teams.getTeamMembers,
    teamId ? { team_id: teamId } : "skip"
  );
  useConvexSync(teamMembersQuery, useCallback((d: any) => useInboxStore.getState().syncTable("teamMembers", d), []));
  return null;
}

export function TeamAvatarBar({ teamId: propTeamId }: TeamAvatarBarProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const memberFilter = searchParams.get("member");
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  // Only the viewer's id is rendered (the "self" ring) — never the whole user
  // doc, whose identity churns on daemon heartbeats.
  const viewerId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : ""));
  // Explicit prop, else the active workspace. No currentUser.team_id fallback:
  // an unset pointer IS the personal workspace, and falling back to the user's
  // default team would render that team's roster inside the personal space.
  const effectiveTeamId = propTeamId ?? activeTeamId;
  // The always-visible bar renders identity + coarse presence, so it wakes on a
  // signature of exactly those fields. The roster array itself re-pushes every
  // few seconds on teammates' heartbeat counters; riding that churned this bar
  // (and its avatar buttons) several times a minute forever.
  const barSig = useInboxStore((s) => teamBarSig(s.teamMembers));
  const teamMembers = useMemo(() => {
    const roster = useInboxStore.getState().teamMembers;
    return roster.length > 0 ? roster : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- barSig stands in for the churny array
  }, [barSig]);
  const callsEnabled = useCallsAvailable();
  // THE BAR SHOWS THE FLOW. Who is talking to me, which room my own key is open
  // into, and which room somebody stepped into on purpose — a signature of
  // exactly those three, so the engine's other six fields (a linger expiring,
  // the recognizer going down, an error clearing) wake this always-mounted
  // surface never.
  const faces = useWalkieFaces();
  // Opens (or creates, local-first) THIS member's DM room. A bare
  // router.push("/chat") landed on the chat page's fallback — the busiest
  // room, i.e. somebody else's DM.
  const openDm = useOpenDm();
  const ctxMenu = useContextMenu<{ id: string; username?: string | null; displayName: string }>();
  // Which member's hover card is open. State-driven (not pure CSS hover) so
  // the card — which subscribes to session data for its fleet line — is
  // MOUNTED only while pointed at; the always-visible bar itself never
  // subscribes to session churn. Two timers make the hover humane: a short
  // dwell before opening (drive-by pointers don't flash cards) and a grace
  // period before closing (crossing into the card, or between avatars, never
  // drops it — the bug where the tooltip vanished on approach).
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverEnter = (id: string) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    if (hoveredId === id) return;
    if (openTimer.current) clearTimeout(openTimer.current);
    // Instant switch when a card is already open; dwell when opening cold.
    if (hoveredId) setHoveredId(id);
    else openTimer.current = setTimeout(() => setHoveredId(id), 120);
  };
  const hoverLeave = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setHoveredId(null), 200);
  };

  if (!effectiveTeamId || !teamMembers || teamMembers.length === 0) {
    return <TeamMembersPump teamId={effectiveTeamId} />;
  }

  const sortedMembers = [...teamMembers]
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .sort(compareMembersByPresence);

  const handleMemberClick = (memberId: string) => {
    if (memberFilter === memberId) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("member");
      router.push(`/team/activity?${params.toString()}`);
    } else {
      router.push(`/team/activity?filter=team&member=${memberId}`);
    }
  };

  const handleClearFilter = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("member");
    router.push(`/team/activity?${params.toString()}`);
  };

  const selectedMember = memberFilter ? sortedMembers.find(m => m._id === memberFilter) : null;

  return (
    // While a key is down the rest of the bar steps back — one person is being
    // talked to and the bar should look like it. Written once per burst from a
    // signature the bar already subscribes to; nothing here moves at the frame
    // rate of a voice.
    <div className="people-bar flex items-center gap-1 px-2" data-holding={faces.sendingRoomKey ? "1" : undefined}>
      <TeamMembersPump teamId={effectiveTeamId} />
      {sortedMembers.slice(0, 6).map((member) => (
        <TeamBarFace
          key={member._id}
          member={member}
          viewerId={viewerId}
          callsEnabled={callsEnabled}
          selected={memberFilter === member._id}
          faces={faces}
          onHoverEnter={() => hoverEnter(String(member._id))}
          onHoverLeave={hoverLeave}
          onContextMenu={(e) =>
            ctxMenu.open(e, {
              id: member._id,
              username: member.github_username,
              displayName: memberDisplayName(member),
            })
          }
          card={
            hoveredId === member._id ? (
              // Its own boundary: a crash inside the card (or a join it starts)
              // must degrade to a chip that NAMES this surface, not take the App
              // boundary — and the whole shell — down with it.
              <ErrorBoundary name="member card" level="inline">
                <MemberHoverCard
                  member={member}
                  displayName={memberDisplayName(member)}
                  isSelf={String(member._id) === viewerId}
                  callsEnabled={callsEnabled}
                  currentUserId={viewerId}
                  onOpenProfile={() => router.push(`/team/${member.github_username || member._id}`)}
                  onOpenChat={() => openDm([String(member._id)])}
                />
              </ErrorBoundary>
            ) : null
          }
        />
      ))}
      {/* Group huddle: the strip is where the people are, so the "ring
          several of them" gesture starts here — the new-huddle field, which
          also reaches group threads and channels.

          A LABELLED BUTTON, not a dashed circle. The faces beside it are now
          the walkie, and a dashed ring with a headset in it read as a seventh
          person — the founder read it as the walkie's own control. It says the
          word instead. */}
      {callsEnabled && teamMembers.length > 1 && (
        <button
          onClick={() => useInboxStore.getState().openCreateModal("huddle")}
          className="ml-1 flex h-7 items-center gap-1.5 rounded-full border border-sol-border/60 px-2.5 text-[11px] text-sol-text-muted transition-colors hover:border-sol-violet/50 hover:text-sol-violet"
          title="Start a huddle with several teammates"
        >
          <Headphones className="h-3.5 w-3.5" />
          Huddle
        </button>
      )}
      {/* Pop the roster out into its own window — the buddy list, floating
          beside whatever you are doing. Hidden inside the people window
          itself, where the gesture has nowhere to go. */}
      <PopOutPeopleButton className="flex h-8 w-8 items-center justify-center rounded-full text-sol-text-dim transition-colors hover:bg-sol-bg-highlight hover:text-sol-text" />
      {teamMembers.length > 6 && (
        <button
          onClick={() => router.push("/team/activity?filter=team")}
          className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-sol-border/50 bg-sol-bg-highlight text-xs text-sol-text-muted transition-colors hover:border-sol-border"
          title={`${teamMembers.length - 6} more team members`}
        >
          +{teamMembers.length - 6}
        </button>
      )}
      {selectedMember && (
        <button
          onClick={handleClearFilter}
          className="ml-1 flex items-center gap-1.5 rounded-full border border-sol-cyan/40 bg-sol-cyan/20 px-2 py-1 text-xs text-sol-cyan transition-colors hover:bg-sol-cyan/30"
          title="Clear filter"
        >
          <span className="max-w-[80px] truncate">{memberDisplayName(selectedMember)}</span>
          <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
      <ContextMenu state={ctxMenu}>
        {(m) => (
          <>
            <CtxHeader title={m.displayName} />
            <CtxItem icon={UserRound} onSelect={() => router.push(`/team/${m.username || m.id}`)}>
              Open profile
            </CtxItem>
            <CtxItem icon={Filter} onSelect={() => handleMemberClick(m.id)}>
              Filter activity by member
            </CtxItem>
            <CtxItem
              icon={Link2}
              onSelect={() => {
                copyToClipboard(`${shareOrigin()}/team/${m.username || m.id}`);
                toast.success("Profile link copied");
              }}
            >
              Copy profile link
            </CtxItem>
          </>
        )}
      </ContextMenu>
    </div>
  );
}

// The rich hover card. Mounted only while its avatar (or the card itself) is
// hovered — the wrapper span owns one hover scope with a close-grace timer,
// so crossing from avatar into card never drops it. Session data is read only
// here (transient subscription), never by the always-mounted bar.
function MemberHoverCard({
  member,
  displayName,
  isSelf,
  callsEnabled,
  currentUserId,
  onOpenProfile,
  onOpenChat,
}: {
  member: any;
  displayName: string;
  isSelf: boolean;
  callsEnabled: boolean;
  currentUserId: string;
  onOpenProfile: () => void;
  onOpenChat: () => void;
}) {
  const now = useCoarseNow(15_000);
  // One source for the badge, the activity line and the fleet counts — the
  // people window reads the same hook, so the two surfaces cannot phrase the
  // same situation differently.
  const { visual, line, fleet, room: liveRoom } = useMemberActivity(member);
  const meta = PRESENCE_META[visual];

  const time = localTimeLine(member.timezone, now);
  const presence = presenceLine(member, now);
  const presenceEchoesLine = presence.toLowerCase() === line.toLowerCase();
  const avatar = member.image || member.github_avatar_url;
  // A quote is only worth quoting when it reads like a sentence the agent
  // wrote, not a bare status token.
  const quote =
    fleet?.topStatus && fleet.topStatus.trim().split(/\s+/).length >= 3
      ? fleet.topStatus.trim()
      : null;
  const cap = (n: number) => (n > 20 ? "20+" : String(n));

  // The huddle gesture is shared with the people window's roster rows
  // (components/presence/useMemberHuddle), so the two surfaces cannot drift
  // into two answers for the same door.
  const huddle = useMemberHuddle(member, currentUserId, liveRoom, displayName);

  // Local-first: the store action flips the roster row in the same tick (the
  // pill must not wait on a server round-trip) and dispatches the
  // authoritative updateProfile through the outbox.
  const setStatus = (status: "available" | "busy" | "away") => {
    useInboxStore.getState().setMyStatus(status);
  };

  // Edge-aware anchoring: a 280px card anchored right-of-avatar clips off
  // screen when the strip sits near the left edge (it did). Measure once on
  // mount and flip.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [alignLeft, setAlignLeft] = useState(false);
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.left < 8) setAlignLeft(true);
    else if (r.right > window.innerWidth - 8) setAlignLeft(false);
  }, []);

  return (
    // pt-2 bridge, not mt-2 gap: the pointer never leaves the hover scope on
    // the way from the avatar into the card.
    <div
      ref={cardRef}
      className={`absolute top-full z-[80] cursor-default pt-2 ${alignLeft ? "left-0" : "right-0"}`}
    >
      <div className="w-[280px] rounded-lg border border-sol-border bg-sol-bg-alt p-3 text-left shadow-xl motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-150">
        <div className="flex items-start gap-2.5">
          <MemberFace member={member} size={36} title="" />
          <div className="min-w-0 flex-1">
            <button
              onClick={onOpenProfile}
              className="block max-w-full truncate text-sm font-semibold text-sol-text transition-colors hover:text-sol-cyan"
              title="Open profile"
            >
              {displayName}
              {isSelf && <span className="ml-1.5 text-[10px] font-normal text-sol-text-dim">you</span>}
            </button>
            {/* What they are DOING leads; the presence fact and their clock
                follow it, smaller. That order is the whole complaint: status
                was legible only to someone who knew the color code, and the
                activity was not on the card at all.

                With nothing to report the activity line IS the presence line
                ("active now"), so the second row drops to the clock alone
                rather than saying it twice. */}
            <div className={`mt-0.5 line-clamp-2 text-[12px] leading-snug ${meta.text}`} title={line}>
              {line}
            </div>
            {(!presenceEchoesLine || time) && (
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-sol-text-dim">
                {!presenceEchoesLine && <span>{presence}</span>}
                {time && <span>{presenceEchoesLine ? time : `· ${time}`}</span>}
              </div>
            )}
          </div>
        </div>

        {fleet && (fleet.working > 0 || fleet.needsYou > 0) && (
          <div className="mt-2.5 border-t border-sol-border/60 pt-2">
            <div className="flex items-center gap-3 text-[11px]">
              {fleet.working > 0 && (
                <span className="flex items-center gap-1 text-sol-text-muted">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-sol-cyan" />
                  {cap(fleet.working)} working
                </span>
              )}
              {fleet.needsYou > 0 && (
                <span className="flex items-center gap-1 text-sol-yellow">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-sol-yellow" />
                  {cap(fleet.needsYou)} need{fleet.needsYou === 1 ? "s" : ""} input
                </span>
              )}
            </div>
            {quote && (
              <div className="mt-1 truncate text-[11px] italic text-sol-text-dim" title={quote}>
                “{quote}”
              </div>
            )}
          </div>
        )}

        <div className="mt-2.5 flex gap-1.5 border-t border-sol-border/60 pt-2">
          {isSelf ? (
            // Your own card is the status switch — the one action that makes
            // sense on yourself.
            (["available", "busy", "away"] as const).map((st) => (
              <button
                key={st}
                onClick={() => setStatus(st)}
                className={`flex-1 rounded px-1.5 py-1 text-[11px] capitalize transition-colors ${
                  (member.status ?? "available") === st
                    ? st === "busy"
                      ? "bg-sol-red/15 text-sol-red"
                      : st === "away"
                        ? "bg-sol-bg-highlight text-sol-text"
                        : "bg-sol-cyan/15 text-sol-cyan"
                    : "text-sol-text-dim hover:bg-sol-bg-highlight hover:text-sol-text"
                }`}
              >
                {st}
              </button>
            ))
          ) : (
            <>
              {callsEnabled && (
                <button
                  type="button"
                  onClick={huddle.go}
                  disabled={huddle.waiting}
                  title={huddle.title}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] font-medium transition-colors ${
                    huddle.waiting
                      ? "cursor-default border border-sol-border/50 text-sol-text-dim"
                      : "bg-sol-violet/15 text-sol-violet hover:bg-sol-violet/25"
                  }`}
                >
                  <Headphones className="h-3.5 w-3.5" />
                  {huddle.label}
                </button>
              )}
              <button
                onClick={onOpenChat}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-sol-bg-highlight px-2 py-1.5 text-[12px] text-sol-text-muted transition-colors hover:text-sol-text"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Message
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
