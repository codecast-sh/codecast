import { useCallback, useMemo, useRef, useState } from "react";
import { ChevronRight, Headphones, LayoutGrid, List, MessageSquare, Pin, Volume2, VolumeX } from "lucide-react";
import { PeopleStrip } from "./PeopleStrip";
import { TeamPulseLine, useTeamPulse } from "./TeamPulseLine";
import { usePeopleDensity } from "./usePeopleDensity";
import type { PeopleDensity } from "./peopleDensity";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { useMountEffect } from "../../hooks/useMountEffect";
import { type LiveRoomRow } from "../../hooks/useLiveRooms";
import { useCallsAvailable } from "../../lib/teamFeatures";
import {
  canPin,
  desktopHeaderClass,
  getAlwaysOnTop,
  navigateMainWindow,
  setAlwaysOnTop,
} from "../../lib/desktop";
import { dmRoomKey } from "@codecast/shared/contracts";
import { ErrorBoundary } from "../ErrorBoundary";
import { CallDock } from "../calls/CallDock";
import { useHandCallToPanel } from "../../hooks/useHandCallToPanel";
import { ElsewhereCallPill } from "../calls/ElsewhereCallPill";
import { LiveNowRail } from "../calls/LiveNow";
import { WalkiePttButton } from "../calls/WalkiePtt";
import { MemberFace } from "../presence/MemberFace";
import { useMemberHuddle } from "../presence/useMemberHuddle";

import {
  PRESENCE_META,
  groupMembersByBand,
  memberDisplayName,
  memberPresenceVisual,
  presenceActivityLine,
  presenceLabel,
  type FleetSummary,
} from "../presence/memberPresence";
import { STRAY_WORKSPACE, rosterSig, unreadBadgeText, type DmBadge } from "./peopleRoster";
import { PeopleWall } from "./PeopleWall";
import { usePeopleRoster } from "./usePeopleRoster";
import { useWalkieDoor } from "../../hooks/useWalkie";
import "./people.css";

const STATUSES = ["available", "busy", "away"] as const;

/**
 * The buddy list: who is around, what they are doing, and every way to reach
 * them, in a window that floats beside the work instead of inside it.
 *
 * Two rules shape everything below.
 *
 * It NEVER navigates. A row click opens the DM in the main window and leaves
 * this one showing the roster — the panel is a place you stand, not a place you
 * browse, and a buddy list that walked away from the buddies would be useless
 * the moment you used it.
 *
 * It is ALWAYS mounted, in a window of its own, so no read here may ride a
 * churny collection. The roster wakes on `rosterSig`; the fleet counts, the
 * live rooms and the chat rail are each computed once at the list and handed
 * down; the clock is coarse. A room full of teammates heartbeating must cost
 * this window nothing.
 */
export function PeoplePanel() {
  const callsEnabled = useCallsAvailable();
  // A call that starts here moves to its own window (founder decision: the
  // buddy list and the call panel are separate things). Walkie bursts stay —
  // they are what this window is for.
  useHandCallToPanel();
  const view = usePeopleView();
  // THE WINDOW'S SIZE PICKS THE SHAPE. Dragged down to a sliver it becomes one
  // row of faces; narrowed, the header folds to a line; at its default size it
  // is the full buddy list. Nothing here is a setting — see peopleDensity.ts.
  const rootRef = useRef<HTMLElement | null>(null);
  const density = usePeopleDensity(rootRef);
  return (
    // `main`, not a div: this window's whole content is this panel, and axe
    // was right to say so — with no landmark, everything on the page sat
    // outside one and a screen reader had no way to skip to the roster.
    <main
      ref={rootRef}
      data-density={density}
      className="people-panel flex flex-col bg-sol-bg text-sol-text"
    >
      {density === "strip" ? (
        <ErrorBoundary name="People strip" level="inline" fallback={null}>
          <PeopleStrip callsEnabled={callsEnabled} pin={<PinButton />} />
        </ErrorBoundary>
      ) : (
        <>
          <PanelHeader density={density} />
          <div className="people-scroll min-h-0 flex-1 overflow-y-auto">
            {callsEnabled && (
              <ErrorBoundary name="Live now" level="inline" fallback={null}>
                <LiveNowRail isNarrow={false} />
              </ErrorBoundary>
            )}
            {view === "list" ? (
              <Roster callsEnabled={callsEnabled} compact={density === "compact"} />
            ) : (
              <PeopleWall callsEnabled={callsEnabled} />
            )}
          </div>
        </>
      )}
      {/* The phone's own ringer and strip live HERE, in the window that hosts
          the audio. CallDock portals to the body and decides for itself whether
          it is a call dock, the walkie strip, or nothing at all — and once a
          call panel exists it stands down entirely, so what is left of it in
          this window is the walkie. */}
      <ErrorBoundary name="Call window" level="inline" fallback={null}>
        <CallDock />
      </ErrorBoundary>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Header: who you are, what you are, and the window's own controls.
// ---------------------------------------------------------------------------

function PanelHeader({ density }: { density: PeopleDensity }) {
  const s = useTrackedStore([
    (st: any) => st.currentUser?._id,
    (st: any) => st.currentUser?.name,
    (st: any) => st.currentUser?.email,
    (st: any) => st.currentUser?.image,
    (st: any) => st.currentUser?.github_avatar_url,
    (st: any) => st.currentUser?.status,
    (st: any) => rosterSig(st.teamMembers),
  ]);
  const viewerId = String(s.currentUser?._id ?? "");
  // Your own face comes from the ROSTER row, not from the user doc.
  //
  // `currentUser` is the raw user document; the presence fields the badge reads
  // (presence_state, presence_input_at, in_room_key) are derived by
  // teams.getTeamMembers and exist only on the roster row. Reading the user doc
  // made the panel call its owner "Offline" while every teammate saw them
  // active. The row is also what setMyStatus patches, so this stays local-first.
  const me: any = useMemo(
    () =>
      (s.teamMembers ?? []).find((m: any) => String(m?._id) === viewerId) ??
      s.currentUser ??
      null,
    [s.teamMembers, viewerId, s.currentUser],
  );
  const callsEnabled = useCallsAvailable();
  const pulse = useTeamPulse();
  const status = (me?.status ?? "available") as (typeof STATUSES)[number];

  // The compact header folds the three status pills behind the status word;
  // they unfold for one choice and fold again.
  const [choosing, setChoosing] = useState(false);

  // The window's top row IS the titlebar. It always sits at the window's
  // top-left corner, so the traffic-light inset is DECLARED rather than
  // measured: `desktopHeaderClass` is the drag region plus the inset, and it is
  // empty off the desktop. (A measured inset once left "PEOPLE" drawn under
  // the lights for a whole session.)
  // Tailwind resolves two padding-left classes by stylesheet order, not by
  // which came last in the string, so the inset REPLACES the row's own left
  // padding rather than sitting beside it.
  const head = desktopHeaderClass() || "pl-3";

  if (density === "compact") {
    return (
      <div className="people-head shrink-0 border-b border-sol-border">
        <div className={`flex h-9 items-center gap-2 pr-2 ${head}`}>
          <MemberFace member={me ?? {}} size={22} title="" />
          <div className="min-w-0 flex-1 truncate text-[12px] font-medium text-sol-text">
            {me ? memberDisplayName(me) : "Signing in"}
          </div>
          <button
            type="button"
            onClick={() => setChoosing((v) => !v)}
            aria-expanded={choosing}
            title="Change your status"
            className={`people-status-word ${STATUS_TONE[status]}`}
          >
            {status}
          </button>
          <ViewSwitch compact />
          <PinButton />
        </div>
        {choosing && (
          <div className="flex gap-1 px-2 pb-2">
            {STATUSES.map((st) => (
              <StatusPill
                key={st}
                status={st}
                active={status === st}
                onPick={() => setChoosing(false)}
              />
            ))}
            {callsEnabled && <WalkieDoorToggle compact />}
          </div>
        )}
        <TeamPulseLine pulse={pulse} max={4} className="px-3 pb-2 text-[10.5px]" />
        <ElsewhereCallPill className="border-t border-sol-border/60 px-3 py-1.5" />
      </div>
    );
  }

  return (
    <div className="people-head shrink-0 border-b border-sol-border">
      <div
        className={`flex h-9 items-center justify-between gap-2 pr-3 text-[11px] font-medium uppercase tracking-wider text-sol-text-dim ${head}`}
      >
        {/* The window's only title, so it is its heading. */}
        <h1 className="text-[11px] font-medium uppercase tracking-wider">People</h1>
        <div className="flex items-center gap-1.5">
          <ViewSwitch />
          <PinButton />
        </div>
      </div>
      <div className="flex items-center gap-2 px-3 pb-2.5">
        <MemberFace member={me ?? {}} size={32} title="" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-sol-text">
            {me ? memberDisplayName(me) : "Signing in"}
          </div>
          <div className="truncate text-[11px] text-sol-text-dim">
            {me ? presenceLabel(memberPresenceVisual(me)) : ""}
          </div>
        </div>
        {callsEnabled && <WalkieDoorToggle />}
      </div>
      <div className="flex gap-1 px-3 pb-2">
        {STATUSES.map((st) => (
          <StatusPill key={st} status={st} active={status === st} />
        ))}
      </div>
      {/* The team in one line, under your own row: the reason to glance at a
          pinned window at all is to learn this without reading the list. */}
      <TeamPulseLine pulse={pulse} wrap className="px-3 pb-2.5 text-[11px]" />
      <ElsewhereCallPill className="border-t border-sol-border/60 px-3 py-1.5" />
    </div>
  );
}

/** The colour a status WORD takes, matching its pill. */
const STATUS_TONE: Record<(typeof STATUSES)[number], string> = {
  available: "text-sol-cyan",
  busy: "text-sol-red",
  away: "text-sol-text-muted",
};

/**
 * Which of the two views this window shows.
 *
 * The wall is the default and the list is the fallback, which is the right way
 * round: the wall is what the window is FOR, and the list is what you switch to
 * when you want to read every name at once in a narrow column.
 *
 * Stored unstamped in the ui bag, so it stays a per-device reading preference
 * like the sidebar and zen mode rather than following the person between
 * machines. The window is a different size on every one of them, and which view
 * fits is a fact about the window, not about the person.
 */
type PeopleView = "wall" | "list";

function usePeopleView(): PeopleView {
  return useInboxStore((s) => (s.clientState.ui?.people_view === "list" ? "list" : "wall"));
}

function ViewSwitch({ compact = false }: { compact?: boolean }) {
  const view = usePeopleView();
  if (compact) {
    // One button, showing the view you would GET: a narrow header has no
    // room for two words, and a toggle that names its other side is enough.
    const other = view === "wall" ? "list" : "wall";
    return (
      <button
        type="button"
        onClick={() => useInboxStore.getState().updateClientUI({ people_view: other })}
        title={other === "wall" ? "Show faces, sized by presence" : "Show one row per person"}
        aria-label={other === "wall" ? "Show the wall" : "Show the list"}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-sol-text-dim transition-colors hover:bg-sol-bg-highlight hover:text-sol-text"
      >
        {other === "wall" ? <LayoutGrid className="h-3.5 w-3.5" /> : <List className="h-3.5 w-3.5" />}
      </button>
    );
  }
  return (
    <div className="people-view-switch" role="group" aria-label="How to show the team">
      {(["wall", "list"] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          title={v === "wall" ? "Faces, sized by presence" : "One row per person"}
          onClick={() => useInboxStore.getState().updateClientUI({ people_view: v })}
        >
          {v}
        </button>
      ))}
    </div>
  );
}

function StatusPill({
  status,
  active,
  onPick,
}: {
  status: (typeof STATUSES)[number];
  active: boolean;
  onPick?: () => void;
}) {
  // Local-first: the store action flips the roster row in the same tick and
  // dispatches the authoritative profile write through the outbox. The pill
  // must not wait on a round trip to show what you just declared.
  const set = () => {
    useInboxStore.getState().setMyStatus(status);
    onPick?.();
  };
  return (
    <button
      type="button"
      onClick={set}
      aria-pressed={active}
      className={`flex-1 rounded px-1.5 py-1 text-[11px] capitalize transition-colors ${
        active
          ? status === "busy"
            ? "bg-sol-red/15 text-sol-red"
            : status === "away"
              ? "bg-sol-bg-highlight text-sol-text"
              : "bg-sol-cyan/15 text-sol-cyan"
          : "text-sol-text-dim hover:bg-sol-bg-highlight hover:text-sol-text"
      }`}
    >
      {status}
    </button>
  );
}

/** The walkie door. It gates LIVE playback on this machine and nothing else: a
 *  closed door mutes a speaker, it never silences them — so the words say what
 *  still happens, not only what stops. */
function WalkieDoorToggle({ compact = false }: { compact?: boolean }) {
  const { open, snoozed, setOpen } = useWalkieDoor();
  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      aria-pressed={open}
      title={
        // Parallel on purpose: same second sentence every way, because that is
        // the whole invariant — the door decides whether a voice PLAYS here,
        // never whether it reaches you. "Nobody plays out loud here" named the
        // wrong subject; it is the voice that does or does not play, not a
        // person who does or does not do it.
        open
          ? "A teammate's voice plays out loud here. Their words arrive as messages either way."
          : snoozed
            ? "Snoozed for the hour. Turn this on to open the door again — their words arrive as messages either way."
            : "No voice plays out loud here. Their words arrive as messages either way."
      }
      className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors ${
        open
          ? "bg-sol-orange/15 text-sol-orange hover:bg-sol-orange/25"
          : "bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text"
      }`}
    >
      {/* A speaker, not the huddle's headphones: this door decides whether a
          teammate's voice PLAYS here, and the two gestures must not share a
          glyph when they sit six pixels apart. */}
      {open ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
      {!compact && (open ? "Open" : "Shut")}
    </button>
  );
}

/**
 * The pin, driven off what the SHELL actually applied.
 *
 * `setAlwaysOnTop` resolves the state the shell really put the window in, and
 * it refuses every caller but the desktop people window. Rendering optimistic
 * state here would let the button claim a pin that never happened.
 */
function PinButton() {
  const [pinned, setPinned] = useState(false);
  const [ready, setReady] = useState(false);
  useMountEffect(() => {
    if (!canPin()) return;
    let alive = true;
    void getAlwaysOnTop().then((on) => {
      if (!alive) return;
      setPinned(on);
      setReady(true);
    });
    return () => {
      alive = false;
    };
  });
  if (!canPin()) return null;
  // Always the pin, never a crossed-out one: a slashed glyph reads as "this is
  // off" in the same breath as "click to turn it off", and half the people who
  // saw it guessed the wrong one. The state is in the colour and in the word.
  return (
    <button
      type="button"
      disabled={!ready}
      onClick={() => void setAlwaysOnTop(!pinned).then(setPinned)}
      aria-pressed={pinned}
      title={pinned ? "Floating above other apps" : "Float above other apps"}
      className={`rounded p-1 transition-colors ${
        pinned ? "text-sol-cyan" : "text-sol-text-dim hover:text-sol-text"
      }`}
    >
      <Pin className={`h-3.5 w-3.5 ${pinned ? "fill-current" : ""}`} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// The roster.
// ---------------------------------------------------------------------------

function Roster({ callsEnabled, compact }: { callsEnabled: boolean; compact: boolean }) {
  // Every read this list makes is the wall's too, so they share one hook. Two
  // views each doing their own signature-gating is two chances to get the wake
  // discipline wrong, in a window that never unmounts.
  const { now, viewerId, members, fleets, roomFor, dmFor, talkingId, strayWorkspace } =
    usePeopleRoster();

  const groups = useMemo(() => groupMembersByBand(members), [members]);

  const [showOffline, setShowOffline] = useState(false);

  if (members.length === 0) {
    // An empty roster has two very different causes, and saying the wrong one
    // is worse than saying nothing. teams.getTeamMembers returns [] rather than
    // an error when the viewer is not in the team it was asked about, so a
    // stale active_team_id — a pointer at a workspace they have left, which
    // survives in this origin's cache — produces exactly the same silence as a
    // team of one. Once the real team list has arrived we can tell them apart,
    // and until then we claim neither.
    return (
      <div className="px-3 py-6 text-[12px] text-sol-text-dim">
        {strayWorkspace
          ? `${STRAY_WORKSPACE} Switch workspace in the main window.`
          : "No teammates yet."}
      </div>
    );
  }

  return (
    <div className="pb-2">
      {groups.map((group) => {
        // Offline is a count, not a list: the people who are not there must not
        // outweigh the people who are in a 320px column. It opens on a click.
        const collapsed = group.band === "offline" && !showOffline;
        return (
          <section key={group.band}>
            {group.band === "offline" ? (
              <button
                type="button"
                onClick={() => setShowOffline((v) => !v)}
                aria-expanded={showOffline}
                className="flex w-full items-center gap-1 px-3 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wider text-sol-text-dim transition-colors hover:text-sol-text-muted"
              >
                <ChevronRight
                  className={`h-3 w-3 transition-transform ${showOffline ? "rotate-90" : ""}`}
                />
                {group.label}
                <span className="text-sol-text-dim/70">{group.members.length}</span>
              </button>
            ) : (
              <div className="flex items-center gap-1 px-3 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wider text-sol-text-dim">
                {group.label}
                <span className="text-sol-text-dim/70">{group.members.length}</span>
              </div>
            )}
            {!collapsed &&
              group.members.map((member: any) => {
                const id = String(member._id);
                return (
                  <RosterRow
                    key={id}
                    member={member}
                    viewerId={viewerId}
                    callsEnabled={callsEnabled}
                    now={now}
                    fleet={fleets.get(id) ?? null}
                    room={roomFor.get(id) ?? null}
                    dm={dmFor.get(id) ?? null}
                    talking={!!id && id === talkingId}
                    compact={compact}
                  />
                );
              })}
          </section>
        );
      })}
    </div>
  );
}

function RosterRow({
  member,
  viewerId,
  callsEnabled,
  now,
  fleet,
  room,
  dm,
  talking,
  compact,
}: {
  member: any;
  viewerId: string;
  callsEnabled: boolean;
  now: number;
  fleet: FleetSummary | null;
  room: LiveRoomRow | null;
  dm: DmBadge | null;
  talking: boolean;
  /** One line per person: the name and what they are doing side by side. */
  compact: boolean;
}) {
  const id = String(member._id);
  const name = memberDisplayName(member);
  const visual = memberPresenceVisual(member);
  const line = useMemo(
    () => presenceActivityLine(member, { now, fleet, room, talking, viewerId }),
    [member, now, fleet, room, talking, viewerId],
  );
  const huddle = useMemberHuddle(member, viewerId, room, name);

  // The message gesture, and the panel's whole navigation policy in one place:
  // open (or create, local-first) the DM and hand the path to the window that
  // holds the work. Only when there is no such window does this one move.
  const message = useCallback(() => {
    const channelId = useInboxStore.getState().openDmChannel([id]);
    const path = `/chat/${channelId}`;
    if (!navigateMainWindow(path)) window.location.href = path;
  }, [id]);

  const unread = dm?.unread ?? 0;
  const mentions = dm?.mentions ?? 0;

  return (
    // The row's click is a convenience for a pointer that lands anywhere on it;
    // the gestures themselves belong to the buttons inside, which is what a
    // keyboard reaches and a screen reader announces. A role="button" here
    // would nest interactive elements and promise a keyboard affordance the
    // div never had.
    <div
      className={`people-row group flex cursor-pointer items-center gap-2 transition-colors hover:bg-sol-bg-highlight/60 ${
        compact ? "px-2 py-[3px]" : "px-3 py-1.5"
      }`}
      onClick={message}
      title={compact ? `${name} · ${line}` : undefined}
    >
      <MemberFace member={member} size={compact ? 20 : 28} title="" />
      {compact ? (
        // One line: the name holds its ground, the activity takes what is
        // left and gives way first — a name is the thing you click.
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="max-w-full shrink-0 truncate text-[12px] leading-tight text-sol-text">
            {name}
          </span>
          <span className={`min-w-0 truncate text-[10.5px] leading-tight ${PRESENCE_META[visual].text}`}>
            {line}
          </span>
        </div>
      ) : (
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] leading-tight text-sol-text">{name}</div>
          <div className={`truncate text-[11px] leading-tight ${PRESENCE_META[visual].text}`}>
            {line}
          </div>
        </div>
      )}
      {/* One slot, three layers: the unread count at rest, the other gestures
          under a pointer or a focus ring, and the mic — which is never hidden,
          because it is the gesture this window exists for. They share the box
          so the name column never reflows as the pointer crosses the list. */}
      <div
        className="relative flex h-7 shrink-0 items-center justify-end gap-1"
        style={{ width: compact ? 34 : 92 }}
      >
        <div className="people-row-idle flex items-center transition-opacity">
          {unread > 0 && (
            <span
              className={`flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold ${
                mentions > 0
                  ? "bg-sol-orange text-sol-bg"
                  : dm?.muted
                    ? "bg-sol-bg-highlight text-sol-text-dim"
                    : "bg-sol-cyan/20 text-sol-cyan"
              }`}
              title={`${unread} unread`}
            >
              {unreadBadgeText(unread)}
            </span>
          )}
        </div>
        <div
          className="people-row-actions absolute inset-y-0 right-[30px] flex items-center gap-0.5"
          onClick={(e) => e.stopPropagation()}
        >
          {callsEnabled && !compact && (
            <button
              type="button"
              onClick={huddle.go}
              disabled={huddle.waiting}
              title={huddle.title}
              aria-label={`${huddle.label} — ${name}`}
              className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                huddle.waiting
                  ? "cursor-default text-sol-text-dim"
                  : "text-sol-text-muted hover:bg-sol-bg-highlight hover:text-sol-violet"
              }`}
            >
              <Headphones className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={message}
            title={`Message ${name} — opens in the main window`}
            aria-label={`Message ${name}`}
            className="flex h-7 w-7 items-center justify-center rounded-md text-sol-text-muted transition-colors hover:bg-sol-bg-highlight hover:text-sol-text"
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </button>
        </div>
        {callsEnabled && (
          <div className="people-row-key" onClick={(e) => e.stopPropagation()}>
            <WalkiePttButton
              roomKey={dmRoomKey(viewerId, id)}
              // Only at press time: this OPENS the DM when there is not one
              // yet, and pointing at a name must not create conversations.
              resolveChannelId={() => useInboxStore.getState().openDmChannel([id])}
              size="sm"
              title={`Hold to talk to ${name}`}
            />
          </div>
        )}
      </div>
    </div>
  );
}
