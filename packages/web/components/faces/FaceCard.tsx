// THE ONE CARD UNDER A FACE (pl-756 F8).
//
// A face on the row is the picture; this card is everything else about the
// person, in one place: who they are, what they are doing, where they are,
// and the three things you can do to them. It is the only thing that opens
// under a face. Hovering opens it after a dwell, clicking pins the same card,
// so two popups never stack, and it never repeats the photo the pointer is
// already on.
//
// Reads by member id and subscribes only while mounted: the row itself never
// subscribes to session churn for the sake of a card nobody is looking at.
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, ChevronRight } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useOpenSession } from "../../hooks/useOpenSession";
import { useMissingSessionRow } from "../../hooks/useMissingSessionRow";
import { useOpenDm } from "../../hooks/useChatSync";
import { cleanTitle } from "../../lib/conversationProcessor";
import { PRESENCE_META, localTimeLine, memberDisplayName, presenceLine, teammateWhereabouts } from "../presence/memberPresence";
import { useMemberActivity } from "../presence/useMemberActivity";
import { useMemberHuddle } from "../presence/useMemberHuddle";
import { FaceActions } from "../presence/FaceActions";
import type { FaceKey } from "../presence/useFaceKey";
import { ErrorBoundary } from "../ErrorBoundary";

/** The card's width: five words of activity and three buttons in a row. */
export const FACE_CARD_WIDTH = 320;

/** The card's edge gutter: it never touches the viewport. */
const EDGE = 8;

export function FaceCard({
  memberId,
  viewerId,
  callsEnabled,
  faceKey,
  anchor,
  density,
  onOpenProfile,
  onClose,
}: {
  memberId: string;
  viewerId: string;
  callsEnabled: boolean;
  /** The face's own key (Talk), so the card's button and the face agree. */
  faceKey: FaceKey | null;
  /** The face's centre, in the row's coordinates: where the notch points. */
  anchor: number;
  /** In the bar the card hangs from the header, centred on the face and
   *  pushed in from the viewport's edges; in the float it sits in the band
   *  under the row, which the window is sized from. */
  density: "bar" | "float";
  onOpenProfile?: (member: any) => void;
  onClose: () => void;
}) {
  const member = useInboxStore((s) => s.teamMembers.find((m: any) => String(m?._id) === memberId) ?? null);
  if (!member) return null;
  return (
    <ErrorBoundary name="member card" level="inline">
      <FaceCardBody
        member={member}
        viewerId={viewerId}
        callsEnabled={callsEnabled}
        faceKey={faceKey}
        anchor={anchor}
        density={density}
        onOpenProfile={onOpenProfile}
        onClose={onClose}
      />
    </ErrorBoundary>
  );
}

function FaceCardBody({
  member,
  viewerId,
  callsEnabled,
  faceKey,
  anchor,
  density,
  onOpenProfile,
  onClose,
}: {
  member: any;
  viewerId: string;
  callsEnabled: boolean;
  faceKey: FaceKey | null;
  anchor: number;
  density: "bar" | "float";
  onOpenProfile?: (member: any) => void;
  onClose: () => void;
}) {
  const memberId = String(member._id);
  const isSelf = memberId === viewerId;
  const displayName = memberDisplayName(member);
  const now = useCoarseNow(15_000);
  // One source for the badge, the activity line and the fleet counts: the
  // people window reads the same hook, so no two surfaces phrase one
  // situation two ways.
  const { visual, line, fleet, room: liveRoom } = useMemberActivity(member);
  const meta = PRESENCE_META[visual];
  const time = localTimeLine(member.timezone, now);
  const presence = presenceLine(member, now);
  const presenceEchoesLine = presence.toLowerCase() === line.toLowerCase();
  const quote =
    fleet?.topStatus && fleet.topStatus.trim().split(/\s+/).length >= 3 ? fleet.topStatus.trim() : null;
  const cap = (n: number) => (n > 20 ? "20+" : String(n));

  const huddle = useMemberHuddle(member, viewerId, liveRoom, displayName);
  const openDm = useOpenDm();

  // Where they are: the session they have open, by the palette's own rule
  // (teammateWhereabouts). Only the title is subscribed, never the row.
  const where = useMemo(() => teammateWhereabouts([member], viewerId, "")[0]?.conversationId ?? null, [member, viewerId]);
  const openSession = useOpenSession();
  const storedWhereTitle = useInboxStore((s) => (where ? s.sessions[where]?.title : undefined));
  const whereInStore = useInboxStore((s) => !!(where && s.sessions[where]));
  const fetchedWhere = useMissingSessionRow(where && !whereInStore ? where : null);
  const whereTitle = storedWhereTitle ?? fetchedWhere?.title;
  const followingThem = useInboxStore((s) => s.followLeaderId === memberId);

  // Centred on the face, then pushed in from a viewport edge if it would
  // clip; the notch stays on the face either way.
  const ref = useRef<HTMLDivElement | null>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (density !== "bar" || !el || typeof window === "undefined") return;
    const r = el.getBoundingClientRect();
    if (r.width === 0) return;
    let next = 0;
    if (r.left < EDGE) next = EDGE - r.left;
    else if (r.right > window.innerWidth - EDGE) next = window.innerWidth - EDGE - r.right;
    if (next !== shift) setShift(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measured once per anchor
  }, [anchor, density]);

  const setStatus = (status: "available" | "busy" | "away") => {
    useInboxStore.getState().setMyStatus(status);
  };

  return (
    <div
      ref={ref}
      className="face-card"
      data-member-card
      role="dialog"
      aria-label={displayName}
      data-density={density}
      style={{ ["--anchor" as string]: `${anchor}px`, ["--shift" as string]: `${shift}px` }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {/* The identity block is the door to the profile: one large target. */}
      <Who door={!!onOpenProfile} onClick={() => onOpenProfile?.(member)}>
        {/* No presence dot before the name: the face the pointer is on
            wears the badge, and the activity line under the name carries the
            presence in its colour. A dot here indented the name by one glyph
            while every line under it sat on the card's edge. */}
        <span className="face-card-name">
          <span className="truncate">{displayName}</span>
          {isSelf && <span className="face-card-you">you</span>}
          {onOpenProfile && <ChevronRight className="face-card-chev" />}
        </span>
        {/* What they are DOING leads; the presence fact and their clock
            follow, smaller. With nothing to report the activity line is the
            presence line, so the second row drops to the clock alone. */}
        <span className={`face-card-line ${meta.text}`}>{line}</span>
        {(!presenceEchoesLine || time) && (
          <span className="face-card-sub">
            {!presenceEchoesLine && <span className="face-card-presence">{presence}</span>}
            {time && <span>{presenceEchoesLine ? time : `· ${time}`}</span>}
          </span>
        )}
      </Who>

      {/* Where they are, and the one gesture that goes there with them. */}
      {!isSelf && (where || followingThem) && (
        <button
          type="button"
          data-sv-follow-button={followingThem ? "unfollow" : "follow"}
          className="face-card-where"
          data-on={followingThem ? "1" : undefined}
          onClick={() => {
            const st = useInboxStore.getState();
            if (followingThem) {
              st.setFollowLeader(null);
              return;
            }
            st.setFollowLeader(memberId);
            if (where) openSession(where);
          }}
        >
          <ArrowRight className="face-card-where-arrow" />
          <span className="min-w-0 flex-1">
            <span className="face-card-where-verb">{followingThem ? "Stop following" : "Follow"}</span>
            <span className="face-card-where-title">
              {where ? (whereTitle ? cleanTitle(whereTitle) : fetchedWhere === null ? "a session that no longer opens" : "a session") : "around, not in a session"}
            </span>
          </span>
        </button>
      )}

      {fleet && (fleet.working > 0 || fleet.needsYou > 0) && (
        <div className="face-card-fleet">
          <span className="face-card-fleet-row">
            {fleet.working > 0 && (
              <span className="face-card-fleet-item text-sol-text-muted">
                <span className="face-card-fleet-dot bg-sol-cyan" />
                {cap(fleet.working)} working
              </span>
            )}
            {fleet.needsYou > 0 && (
              <span className="face-card-fleet-item text-sol-yellow">
                <span className="face-card-fleet-dot bg-sol-yellow" />
                {cap(fleet.needsYou)} need{fleet.needsYou === 1 ? "s" : ""} input
              </span>
            )}
          </span>
          {quote && <span className="face-card-quote">“{quote}”</span>}
        </div>
      )}

      <div className="face-card-actions" data-switch={isSelf ? "1" : undefined}>
        {isSelf ? (
          // Your own card is the status switch: the one action that makes
          // sense on yourself.
          (["available", "busy", "away"] as const).map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => setStatus(st)}
              className="face-card-status"
              data-on={(member.status ?? "available") === st ? st : undefined}
            >
              <span className="face-card-status-dot" data-status={st} aria-hidden="true" />
              {st}
            </button>
          ))
        ) : (
          <FaceActions
            ptt={faceKey?.ptt ?? IDLE_PTT}
            blocked={faceKey?.blocked ?? (callsEnabled ? null : "Calls are off for this team")}
            roomKey={faceKey?.roomKey ?? ""}
            ringIds={[memberId]}
            huddle={callsEnabled ? huddle : undefined}
            show={callsEnabled ? ["talk", "ring", "message"] : ["message"]}
            onMessage={() => {
              onClose();
              openDm([memberId]);
            }}
            size="sm"
            className="face-actions-fill"
          />
        )}
      </div>
    </div>
  );
}

/** The identity block: a button when there is a profile to open, else words. */
function Who({ door, onClick, children }: { door: boolean; onClick: () => void; children: ReactNode }) {
  return door ? (
    <button type="button" className="face-card-who" data-door onClick={onClick}>
      {children}
    </button>
  ) : (
    <div className="face-card-who">{children}</div>
  );
}

/** A key with no room: the Talk button is drawn disabled, never absent. */
const IDLE_PTT = {
  holding: false,
  locked: false,
  live: false,
  dropped: false,
  capturing: false,
  reason: null,
  press: () => {},
  release: () => {},
};
