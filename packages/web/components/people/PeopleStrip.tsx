// The window at its smallest: one row of faces you can hold, and the team in
// a few words. This is what a buddy list pinned above other apps should cost.
import { useMemo, useState, type ReactNode } from "react";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { desktopHeaderClass } from "../../lib/desktop";
import { MemberFace } from "../presence/MemberFace";
import {
  memberDisplayName,
  memberPresenceVisual,
  presenceActivityLine,
  PRESENCE_META,
} from "../presence/memberPresence";
import { STRAY_WORKSPACE } from "./peopleRoster";
import { STRIP_FACE_PX, type StripTier } from "./peopleDensity";
import { buildWall } from "./peopleWallLayout";
import { WallFaceButton } from "./PeopleWall";
import { TeamPulseLine, usePulseFrom } from "./TeamPulseLine";
import { usePeopleRoster } from "./usePeopleRoster";
import "./people.css";

/**
 * THE SAME FACES AS THE WALL, in a row.
 *
 * Every face here is the wall's own button — hold to talk, tap to open the
 * DM, the rings, the refusal — at the strip's sizes instead of the wall's
 * (peopleDensity.ts). Presence still sets the size, so the biggest circle is
 * still the person most worth a word; it is only the scale that changes.
 *
 * There is no room under a face for its label in a 56px window, so the name
 * and the activity line of the face under the pointer take over the text
 * slot from the team pulse, and give it back when the pointer leaves. The
 * offline fold into one dim count: absentees must not cost a strip its row.
 *
 * The whole row is the titlebar. The faces and the pin are buttons, which
 * the drag region rule already exempts, so a press on a face is a hold and
 * a press on the gap beside it moves the window.
 */
export function PeopleStrip({
  callsEnabled,
  pin,
}: {
  callsEnabled: boolean;
  /** The window's pin, rendered by the panel that owns the window state. */
  pin?: ReactNode;
}) {
  const data = usePeopleRoster();
  const pulse = usePulseFrom(data);
  const { members, fleets, viewerId, now, roomFor, talkingId } = data;
  const me = useTrackedStore([
    (st: any) => st.currentUser?._id,
    (st: any) => st.currentUser?.status,
    (st: any) => st.currentUser?.image,
  ]).currentUser;
  const meRow = useMemo(
    () =>
      (useInboxStore.getState().teamMembers ?? []).find((m: any) => String(m?._id) === viewerId) ??
      me ??
      {},
    // eslint-disable-next-line react-hooks/exhaustive-deps -- members stands in for the roster array
    [members, viewerId, me],
  );

  const wall = useMemo(
    () =>
      buildWall(
        members,
        (m: any) => memberPresenceVisual(m),
        (m: any) => fleets.get(String(m._id)) ?? null,
        (m: any) => String(m._id ?? ""),
        (m: any) => m?.name || m?.email || "",
      ),
    [members, fleets],
  );

  const [hoverId, setHoverId] = useState<string | null>(null);
  const hovered = hoverId ? wall.present.find((f) => f.id === hoverId) ?? null : null;
  const hoverLine = hovered
    ? presenceActivityLine(hovered.member, {
        now,
        fleet: fleets.get(hovered.id) ?? null,
        room: roomFor.get(hovered.id) ?? null,
        talking: hovered.id === talkingId,
        viewerId,
      })
    : "";

  const goneNames = wall.gone.map((f) => memberDisplayName(f.member)).join(", ");

  return (
    <div
      className={`people-strip flex min-h-0 min-w-0 flex-1 items-center gap-2 pr-2 ${desktopHeaderClass() || "pl-3"}`}
      data-holding={data.sendingRoomKey ? "1" : undefined}
    >
      <MemberFace member={meRow} size={22} title="You" className="shrink-0" />
      <span className="people-strip-rule" aria-hidden="true" />
      <div
        className="people-strip-faces people-scroll flex min-w-0 shrink items-center gap-2"
        onPointerLeave={() => setHoverId(null)}
      >
        {members.length === 0 ? (
          <span className="truncate text-[11px] text-sol-text-dim">
            {data.strayWorkspace ? STRAY_WORKSPACE : "No teammates yet."}
          </span>
        ) : (
          wall.present.map((face) => (
            <span
              key={face.id}
              className="flex shrink-0"
              onPointerEnter={() => setHoverId(face.id)}
              onFocus={() => setHoverId(face.id)}
              onBlur={() => setHoverId((cur) => (cur === face.id ? null : cur))}
            >
              <WallFaceButton
                face={{ ...face, px: STRIP_FACE_PX[face.tier as StripTier] ?? STRIP_FACE_PX.away }}
                data={data}
                callsEnabled={callsEnabled}
              />
            </span>
          ))
        )}
        {wall.gone.length > 0 && (
          <span className="people-strip-gone" title={`Offline: ${goneNames}`}>
            +{wall.gone.length}
          </span>
        )}
      </div>
      {/* The words keep a floor of their own, so a big team scrolls its faces
          before it eats the sentence that says what the team is doing. */}
      <div className="min-w-[120px] flex-1 overflow-hidden text-[11px]">
        {hovered ? (
          <div className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap leading-none">
            <span className="shrink-0 font-medium text-sol-text">{memberDisplayName(hovered.member)}</span>
            <span className={`truncate ${PRESENCE_META[memberPresenceVisual(hovered.member)].text}`}>
              {hoverLine}
            </span>
          </div>
        ) : (
          <TeamPulseLine pulse={pulse} max={3} />
        )}
      </div>
      {pin}
    </div>
  );
}
