import { useQuery } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { UserRound, Filter, Link2, Headphones, MessageSquare } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { sessionsWithPendingSend } from "../store/inboxStore";
import { useConvexSync } from "../hooks/useConvexSync";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { copyToClipboard, shareOrigin } from "../lib/utils";
import { ContextMenu, useContextMenu, CtxItem, CtxHeader } from "./ui/context-menu";
import {
  PRESENCE_META,
  compareMembersByPresence,
  fleetLine,
  localTimeLine,
  memberFleetSummary,
  memberPresenceState,
  presenceLine,
} from "./presence/memberPresence";
import { startHuddle } from "../lib/calls/callManager";
import { dmRoomKey } from "@codecast/shared/contracts";
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
function TeamMembersPump({ teamId }: { teamId: Id<"teams"> | undefined }) {
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
  const currentUser = useMemo(() => (viewerId ? ({ _id: viewerId } as any) : null), [viewerId]);
  // Explicit prop, else the active workspace. No currentUser.team_id fallback:
  // an unset pointer IS the personal workspace, and falling back to the user's
  // default team would render that team's roster inside the personal space.
  const effectiveTeamId = propTeamId ?? activeTeamId;
  // The always-visible bar renders identity + coarse presence, so it wakes on a
  // signature of exactly those fields. The roster array itself re-pushes every
  // few seconds on teammates' heartbeat counters; riding that churned this bar
  // (and its avatar buttons) several times a minute forever.
  const barSig = useInboxStore((s) => {
    let sig = "";
    for (const m of s.teamMembers) {
      if (!m?._id) continue;
      sig += `${m._id}|${memberPresenceState(m)}|${m.status === "busy" ? 1 : 0}|${m.image ?? ""}|${m.github_avatar_url ?? ""}|${m.name ?? ""}|${m.email ?? ""}|${m.github_username ?? ""}|${m.in_room_key ?? ""}\n`;
    }
    return sig;
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- barSig stands in for the churny array
  const teamMembers = useMemo(() => {
    const roster = useInboxStore.getState().teamMembers;
    return roster.length > 0 ? roster : null;
  }, [barSig]);
  const callsEnabled = useInboxStore((s) => !!s.callConfig?.enabled);
  const ctxMenu = useContextMenu<{ id: string; username?: string | null; displayName: string }>();
  // Which member's hover card is open. State-driven (not pure CSS hover) so
  // the card — which subscribes to session data for its fleet line — is
  // MOUNTED only while pointed at; the always-visible bar itself never
  // subscribes to session churn.
  const [hoveredId, setHoveredId] = useState<string | null>(null);

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
    <div className="flex items-center gap-1 px-2">
      <TeamMembersPump teamId={effectiveTeamId} />
      {sortedMembers.slice(0, 6).map((member) => {
        const state = memberPresenceState(member);
        const meta = PRESENCE_META[state];
        const busy = member.status === "busy";
        const avatar = member.image || member.github_avatar_url;
        const initial = (member.name || member.email || "?").charAt(0).toUpperCase();
        const displayName = member.name || member.email?.split("@")[0] || "Unknown";
        const isSelected = memberFilter === member._id;
        const isSelf = String(member._id) === String((currentUser as any)?._id ?? "");
        return (
          <button
            key={member._id}
            onClick={() => router.push(`/team/${member.github_username || member._id}`)}
            onContextMenu={(e) => ctxMenu.open(e, { id: member._id, username: member.github_username, displayName })}
            onMouseEnter={() => setHoveredId(member._id)}
            onMouseLeave={() => setHoveredId((h) => (h === member._id ? null : h))}
            className="relative"
          >
            <div
              className={`h-8 w-8 overflow-hidden rounded-full transition-all duration-200 ${
                isSelected
                  ? "ring-2 ring-sol-cyan ring-offset-1 ring-offset-sol-bg"
                  : meta.ring
              } ${meta.dim && !isSelected ? "opacity-50 hover:opacity-80" : ""}`}
            >
              {avatar ? (
                <img src={avatar} alt={displayName} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-sol-base02">
                  <span className="text-xs font-medium text-sol-text-muted">{initial}</span>
                </div>
              )}
            </div>
            {busy && (
              <span
                className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-sol-bg bg-sol-red"
                title="Busy"
              />
            )}
            {(member.in_huddle || member.in_room_key) && (
              <span
                className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-sol-bg bg-sol-violet"
                title="In a huddle"
              >
                <Headphones className="h-2 w-2 text-sol-bg" />
              </span>
            )}
            {hoveredId === member._id && (
              <MemberHoverCard
                member={member}
                displayName={displayName}
                isSelf={isSelf}
                callsEnabled={callsEnabled}
                currentUserId={String((currentUser as any)?._id ?? "")}
                onOpenProfile={() => router.push(`/team/${member.github_username || member._id}`)}
                onOpenChat={() => router.push("/chat")}
              />
            )}
          </button>
        );
      })}
      {teamMembers.length > 6 && (
        <button
          onClick={() => router.push("/team/activity?filter=team")}
          className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-sol-border/50 bg-sol-base02 text-xs text-sol-text-muted transition-colors hover:border-sol-border"
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
          <span className="max-w-[80px] truncate">{selectedMember.name || selectedMember.email?.split("@")[0]}</span>
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

// The rich hover card. Mounted only while its avatar is hovered, so its
// session-data subscription (fleet line) is transient by construction — the
// whole-collection read that is forbidden for always-mounted components is
// fine for a card that lives for the duration of a pointer dwell.
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
  const state = memberPresenceState(member);
  const meta = PRESENCE_META[state];
  const s = useTrackedStore([
    (st: any) => st.sessions,
    (st: any) => st.sessionsWithQueuedMessages,
    (st: any) => st.pendingMessages,
  ]);
  const fleet = useMemo(() => {
    const sessions = Object.values(s.sessions ?? {}) as any[];
    return memberFleetSummary(sessions, String(member._id), {
      queued: s.sessionsWithQueuedMessages ?? new Set(),
      pendingSendIds: sessionsWithPendingSend(s.pendingMessages),
      now,
    });
  }, [s.sessions, s.sessionsWithQueuedMessages, s.pendingMessages, member._id, now]);

  const time = localTimeLine(member.timezone, now);
  const huddle = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    void startHuddle({
      roomKey: dmRoomKey(currentUserId, String(member._id)),
      toUserId: String(member._id),
    });
  };

  return (
    <div className="absolute top-full right-0 z-50 mt-2 w-[280px] cursor-default rounded-lg border border-sol-border bg-sol-bg-alt p-3 text-left shadow-xl">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <a
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onOpenProfile();
            }}
            className="block cursor-pointer truncate text-sm font-medium text-sol-text transition-colors hover:text-sol-cyan"
          >
            {displayName}
          </a>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${meta.dot || "bg-sol-base01"}`} />
            <span className={state === "active" ? "text-emerald-400" : "text-sol-text-muted"}>
              {presenceLine(member, now)}
            </span>
            {time && <span className="text-sol-text-dim">· {time} local</span>}
          </div>
          {member.status && member.status !== "available" && (
            <div className="mt-0.5 text-xs capitalize text-sol-orange">{member.status}</div>
          )}
        </div>
      </div>

      {fleet && (fleet.working > 0 || fleet.needsYou > 0) && (
        <div className="mt-2 border-t border-sol-border/60 pt-2">
          <div className="text-xs text-sol-text-muted">{fleetLine(fleet)}</div>
          {fleet.topStatus && (
            <div className="mt-0.5 truncate text-xs italic text-sol-text-dim" title={fleet.topStatus}>
              "{fleet.topStatus}"
            </div>
          )}
        </div>
      )}
      {!fleet && member.recent_session_title && (
        <div className="mt-2 border-t border-sol-border/60 pt-2">
          <div className="truncate text-xs text-sol-text-muted" title={member.recent_session_title}>
            {member.recent_session_title}
          </div>
        </div>
      )}

      {!isSelf && (
        <div className="mt-2 flex gap-1.5 border-t border-sol-border/60 pt-2">
          {callsEnabled && (
            <span
              role="button"
              onClick={huddle}
              className="flex items-center gap-1 rounded bg-sol-violet/15 px-2 py-1 text-xs font-medium text-sol-violet transition-colors hover:bg-sol-violet/25"
            >
              <Headphones className="h-3 w-3" />
              Huddle
            </span>
          )}
          <span
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              // Chat has no DMs yet: land in team chat, where an @mention
              // reaches them. (A prefilled mention is a chat-side follow-up.)
              onOpenChat();
            }}
            className="flex items-center gap-1 rounded bg-sol-base02 px-2 py-1 text-xs text-sol-text-muted transition-colors hover:text-sol-text"
          >
            <MessageSquare className="h-3 w-3" />
            Message
          </span>
        </div>
      )}
    </div>
  );
}
