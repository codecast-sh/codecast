import { useCallback, useMemo, useRef, useState } from "react";
import { ChevronRight, Headphones, LayoutGrid, List, MessageSquare, PictureInPicture2, Pin, Volume2, VolumeX } from "lucide-react";
import { PeopleStrip } from "./PeopleStrip";
import { PeopleLegend } from "./PeopleLegend";
import { TeamPulseLine } from "./TeamPulseLine";
import { usePulseFrom } from "./usePulseFrom";
import { type TeamPulse } from "./teamPulse";
import { peopleHeadClass, usePeopleDensity } from "./usePeopleDensity";
import type { PeopleDensity } from "./peopleDensity";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { useMountEffect } from "../../hooks/useMountEffect";
import { type LiveRoomRow } from "../../hooks/useLiveRooms";
import { useCallsAvailable } from "../../lib/teamFeatures";
import {
  canOpenFacesOverlay,
  canPin,
  closeFacesWindow,
  getAlwaysOnTop,
  navigateMainWindow,
  openFacesWindow,
  setAlwaysOnTop,
} from "../../lib/desktop";
import { useDesktopWindowRole } from "../../hooks/useDesktopWindowRole";
import { dmRoomKey } from "@codecast/shared/contracts";
import { ErrorBoundary } from "../ErrorBoundary";
import { CallDock } from "../calls/CallDock";
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
import { emptyRosterText, unreadBadgeText, type DmBadge } from "./peopleRoster";
import { PeopleWallView } from "./PeopleWall";
import { usePeopleRoster, type PeopleRosterData } from "./usePeopleRoster";
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
  // A call that starts here moves to its own window. CallDock hosts that
  // handoff (useHandCallToPanel) so the buddy list and the main window share
  // one rule: a huddle is a real OS window, a walkie burst stays on the strip.
  const view = usePeopleView();
  // THE WINDOW'S SIZE PICKS THE SHAPE. Dragged down to a sliver it becomes one
  // row of faces; narrowed, the header folds to a line; at its default size it
  // is the full buddy list. Nothing here is a setting — see peopleDensity.ts.
  const rootRef = useRef<HTMLElement | null>(null);
  const density = usePeopleDensity(rootRef);
  // THE ONE ROSTER READ. Every shape draws from this object — a second call
  // site is a second full set of store subscriptions and timers in a window
  // that never unmounts, which is exactly the bug class this window documents.
  const data = usePeopleRoster();
  const pulse = usePulseFrom(data);
  return (
    // `main`, not a div: this window's whole content is this panel, and axe
    // was right to say so — with no landmark, everything on the page sat
    // outside one and a screen reader had no way to skip to the roster.
    <main
      ref={rootRef}
      data-density={density}
      aria-labelledby="people-heading"
      className="people-panel flex flex-col bg-sol-bg text-sol-text"
    >
      {/* The heading lives HERE, above the density branch, so dragging the
          window into a shape whose header has no room for the word does not
          strip the window of its name. The full header shows it visibly. */}
      <h1 id="people-heading" className="sr-only">
        People
      </h1>
      {density === "strip" ? (
        <ErrorBoundary name="People strip" level="inline" fallback={null}>
          <PeopleStrip callsEnabled={callsEnabled} data={data} pulse={pulse} pin={<><FacesOverlayButton /><PinButton /></>} />
        </ErrorBoundary>
      ) : (
        <>
          <PanelHeader density={density} me={data.me} pulse={pulse} />
          <div className="people-scroll min-h-0 flex-1 overflow-y-auto">
            {callsEnabled && (
              <ErrorBoundary name="Live now" level="inline" fallback={null}>
                <LiveNowRail isNarrow={false} />
              </ErrorBoundary>
            )}
            {view === "list" ? (
              <Roster callsEnabled={callsEnabled} compact={density === "compact"} data={data} />
            ) : (
              <PeopleWallView callsEnabled={callsEnabled} data={data} />
            )}
          </div>
          {callsEnabled && <PeopleLegend />}
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

function PanelHeader({
  density,
  me,
  pulse,
}: {
  density: PeopleDensity;
  /** Your roster row (or the user doc until it lands) — resolved once by
   *  usePeopleRoster, never looked up here. */
  me: any;
  pulse: TeamPulse;
}) {
  const callsEnabled = useCallsAvailable();
  const status = (me?.status ?? "available") as (typeof STATUSES)[number];

  // The compact header folds the three status pills behind the status word;
  // they unfold for one choice and fold again, handing focus back to the word
  // so a keyboard is not dropped at the top of the window.
  const [choosing, setChoosing] = useState(false);
  const wordRef = useRef<HTMLButtonElement | null>(null);
  const closeChooser = useCallback(() => {
    setChoosing(false);
    wordRef.current?.focus();
  }, []);

  const head = peopleHeadClass();

  if (density === "compact") {
    return (
      <div className="people-head shrink-0 border-b border-sol-border/60">
        {/* No name in this row: your own name is the least informative text in
            the window, and at these widths it was an ellipsis fighting the
            controls. The face carries it as a tooltip. */}
        <div className={`flex h-9 items-center gap-2 pr-2 ${head}`}>
          <MemberFace member={me ?? {}} size={22} title={me ? `${memberDisplayName(me)} · ${presenceLabel(memberPresenceVisual(me))}` : ""} />
          <button
            ref={wordRef}
            type="button"
            onClick={() => (choosing ? closeChooser() : setChoosing(true))}
            aria-expanded={choosing}
            aria-controls="people-status-picker"
            aria-label={`Your status: ${status}. Change it`}
            className={`people-status-word mr-auto truncate ${STATUS_STYLE[status].text}`}
          >
            {status}
          </button>
          <ViewSwitch compact />
          <FacesOverlayButton />
          <PinButton />
        </div>
        {choosing && (
          <div
            id="people-status-picker"
            role="group"
            aria-label="Your status"
            className="flex gap-1 px-2 pb-2"
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.stopPropagation();
              closeChooser();
            }}
          >
            {STATUSES.map((st) => (
              <StatusPill key={st} status={st} active={status === st} onPick={closeChooser} />
            ))}
            {callsEnabled && <WalkieDoorToggle compact />}
          </div>
        )}
        <TeamPulseLine pulse={pulse} className="px-3 pb-2 text-[10.5px]" />
        <ElsewhereCallPill className="border-t border-sol-border/60 px-3 py-1.5" />
      </div>
    );
  }

  return (
    <div className="people-head shrink-0 border-b border-sol-border/60">
      <div
        className={`flex h-9 items-center justify-between gap-2 pr-3 text-[11px] font-medium uppercase tracking-wider text-sol-text-dim ${head}`}
      >
        {/* The visible title. The document's h1 is the always-present hidden
            one on the panel, so this is presentation only. */}
        <div aria-hidden="true" className="text-[11px] font-medium uppercase tracking-wider">
          People
        </div>
        <div className="flex items-center gap-1.5">
          <ViewSwitch />
          <FacesOverlayButton />
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

/** One table for the three statuses, so the compact header's word and the
 *  pills can never colour the same status two ways. */
const STATUS_STYLE: Record<(typeof STATUSES)[number], { text: string; activeBg: string }> = {
  available: { text: "text-sol-cyan", activeBg: "bg-sol-cyan/15" },
  busy: { text: "text-sol-red", activeBg: "bg-sol-red/15" },
  away: { text: "text-sol-text-muted", activeBg: "bg-sol-bg-highlight" },
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
    // One button, modelled as STATE — fixed name, aria-pressed, the icon of
    // the view you are in — because an action-named toggle renames itself
    // under a focused screen reader, which announces nothing.
    const other = view === "wall" ? "list" : "wall";
    return (
      <button
        type="button"
        onClick={() => useInboxStore.getState().updateClientUI({ people_view: other })}
        title={other === "wall" ? "Show faces, sized by presence" : "Show one row per person"}
        aria-label="List view"
        aria-pressed={view === "list"}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-sol-text-dim transition-colors hover:bg-sol-bg-highlight hover:text-sol-text"
      >
        {view === "wall" ? <LayoutGrid className="h-3.5 w-3.5" /> : <List className="h-3.5 w-3.5" />}
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
          ? `${STATUS_STYLE[status].activeBg} ${status === "away" ? "text-sol-text" : STATUS_STYLE[status].text}`
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
/**
 * The floating faces, from the window that owns keeping the team on screen.
 *
 * A toggle, not a launcher: the overlay is a standing arrangement ("keep the
 * team over my work") and the button reads its current answer — from the
 * shell's window-role push, never a one-shot read, because the overlay closes
 * without this button (its own chrome, a crash) and a lit toggle for a window
 * that is gone is a button that needs two clicks. Desktop only — a
 * see-through click-through window is the shell's to make, so on an older
 * build or in a browser the button simply is not there.
 */
function FacesOverlayButton() {
  const open = useDesktopWindowRole().facesOverlay;
  if (!canOpenFacesOverlay()) return null;
  return (
    <button
      type="button"
      onClick={() => void (open ? closeFacesWindow() : openFacesWindow())}
      aria-pressed={open}
      title={open ? "Floating faces are on your screen" : "Float the team's faces over your work"}
      className={`rounded p-1 transition-colors ${
        open ? "text-sol-cyan" : "text-sol-text-dim hover:text-sol-text"
      }`}
    >
      <PictureInPicture2 className="h-3.5 w-3.5" />
    </button>
  );
}

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

function Roster({
  callsEnabled,
  compact,
  data,
}: {
  callsEnabled: boolean;
  compact: boolean;
  data: PeopleRosterData;
}) {
  const { now, viewerId, members, fleets, roomFor, dmFor, talkingId, strayWorkspace } = data;

  const groups = useMemo(() => groupMembersByBand(members), [members]);

  const [showOffline, setShowOffline] = useState(false);

  if (members.length === 0) {
    // An empty roster has two very different causes, and saying the wrong one
    // is worse than saying nothing — emptyRosterText tells them apart once the
    // real team list has arrived, and claims neither before.
    return (
      <div className="px-3 py-6 text-[12px] text-sol-text-dim">
        {emptyRosterText(strayWorkspace)}
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
      <MemberFace member={member} size={compact ? 24 : 28} title="" showHuddle={!compact} />
      {compact ? (
        // One line. The activity keeps a floor of a few characters and the
        // name yields past it: a one-letter activity line reads as a glitch,
        // and the row's title already carries both in full.
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="min-w-0 shrink truncate text-[12px] leading-tight text-sol-text">
            {name}
          </span>
          <span
            className={`min-w-[6ch] max-w-[50%] shrink-0 truncate text-[10.5px] leading-tight ${PRESENCE_META[visual].text}`}
          >
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
