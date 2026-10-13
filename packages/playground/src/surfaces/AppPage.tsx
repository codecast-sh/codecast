// An app's page: /<slug> (live), /<slug>?room (room open), /<slug>/v/<n>
// (viewing the past). The app fills the viewport; the shell adds the capsule,
// and when asked, the room and the timeline (DESIGN 6.2 to 6.7).
//
// The app starts loading on first paint, from the link alone (Stage): nothing
// about the app or the visitor has to arrive first. The room takes the stage
// over once both are known. Until the room or the timeline opens (or someone
// reaches for it), the page reads only a small slice of what is going on:
// the newest messages and builds in flight (messages.latest) and the live
// version's own entry, so a quiet look at an app stays a light one.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, usePaginatedQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { AppView } from "../../convex/apps";
import type { MessageView } from "../../convex/messages";
import type { TimelineEntry } from "../../convex/versions";
import type { ElementRef } from "../../convex/validators";
import { useHere, usePresenceBeat } from "../data/presence";
import { errorData } from "../lib/errors";
import { useIdentity, useMaybeIdentity, useRetryIdentity, useVisitorMutation, useVisitorQuery } from "../lib/identity";
import { lazyPart } from "../lib/lazyPart";
import { appUrl, navigate, versionUrl } from "../lib/router";
import { focusLost } from "../lib/focus";
import { load, save } from "../lib/storage";
import { useDesktop } from "../lib/useMedia";
import { useToast } from "../ui/Toast";
import type { AppFrameEvents, AppFrameHandle, FailedFrame, FrameSession } from "./AppFrame";
import {
  AppStateContext,
  ComposerContext,
  createDraft,
  freshFocus,
  HereContext,
  StreamContext,
  type AppState,
  type ComposerState,
  type Mode,
  type StreamState,
} from "./appState";
import { Capsule } from "./Capsule";
import { useCharacterPicker } from "./CharacterPicker";
import { FrameFailed } from "./FrameFailed";
import { NotFound } from "./pages";
import { PickBanner, ViewingPill } from "./ViewingPill";
import { PreviewFrame } from "./PreviewFrame";
import { Stage, useStage, type StageControl } from "./Stage";
import { useOpenGraph } from "./openGraph";
import { ROOM_DEFAULT, clampWidth } from "./roomSize";
import s from "./AppPage.module.css";

const RoomPanel = lazyPart(() => import("./Room").then((m) => m.RoomPanel));
const RoomSheet = lazyPart(() => import("./Room").then((m) => m.RoomSheet));
const TimelineDock = lazyPart(() => import("./Timeline").then((m) => m.TimelineDock));
const ForkModal = lazyPart(() => import("./ForkModal").then((m) => m.ForkModal));
const FirstBuild = lazyPart(() => import("./FirstBuild").then((m) => m.FirstBuild));

export function AppPage({ slug, version, room }: { slug: string; version: number | null; room: boolean }) {
  const { app, fromCache } = useAppView(slug);
  const identity = useMaybeIdentity();
  const retry = useRetryIdentity();
  if (app === null) return <NotFound />;
  return (
    <Stage key={slug} slug={slug} version={version ?? app?.live_version ?? null} onStuck={identity ? null : retry}>
      {app && identity && <AppRoom key={fromCache ? `${app.id}:kept` : app.id} app={app} version={version} room={room} />}
    </Stage>
  );
}

/** The app, rendered from the last copy this device saw while the backend
 *  answers. The first answer decides once: the same live version keeps the
 *  page as it is; a different one starts the room over from the answer, so
 *  a cached page never celebrates a version that went live while nobody here
 *  looked. */
function useAppView(slug: string): { app: AppView | null | undefined; fromCache: boolean } {
  const key = `clayground.app.${slug}`;
  const asked = useQuery(api.apps.get, { slug });
  const [kept] = useState(() => load<AppView | null>(key, null));
  const keep = useRef<boolean | null>(null);
  if (asked !== undefined && keep.current === null) keep.current = !!kept && kept.id === asked?.id && kept.live_version === asked.live_version;
  useEffect(() => {
    if (asked !== undefined) save(key, asked);
  }, [asked, key]);
  if (asked === undefined) return { app: kept ?? undefined, fromCache: true };
  return { app: asked, fromCache: keep.current === true };
}

/** True from the first time `on` is. */
function useSticky(on: boolean): boolean {
  const [was, setWas] = useState(on);
  if (on && !was) setWas(true);
  return on || was;
}

/** Once the app is on screen, the parts it opens load while nothing else is
 *  happening, so the first open never waits for them. */
function preloadParts() {
  const idle = window.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 1500));
  idle(() => {
    void RoomPanel.preload();
    void TimelineDock.preload();
  });
}

const STREAM_PAGE = 40;
const FIRST_BUILD_FADE_MS = 340;
const DOCK_HEIGHT = 68;
/** The past bar, docked on top of the timeline while you view a version. */
const PAST_BAR_HEIGHT = 48;
const NO_MESSAGES: MessageView[] = [];

function AppRoom({ app, version, room }: { app: AppView; version: number | null; room: boolean }) {
  const { creds, me } = useIdentity();
  const toast = useToast();
  const desktop = useDesktop();
  const openPicker = useCharacterPicker();
  useOpenGraph(app);

  const viewing = version !== null && version !== app.live_version && version <= app.version_count ? version : null;
  usePresenceBeat(app.id, viewing);
  const here = useHere(app.id);
  const hereNow = useRef(here);
  hereNow.current = here;

  // A version link is a visit to the history: it lands with the timeline open.
  const [timelineOnly, setTimelineOnly] = useState(() => version !== null);
  const dock = desktop && (room || timelineOnly);

  // What the page reads: the room's stream and the timeline once they open,
  // or as soon as someone reaches for them, and from then on.
  const [reached, setReached] = useState<{ room: boolean; timeline: boolean }>({ room: false, timeline: false });
  const prepare = useCallback((part: "room" | "timeline") => {
    void (part === "room" ? RoomPanel : TimelineDock).preload();
    setReached((r) => (r[part] ? r : { ...r, [part]: true }));
  }, []);
  const roomSeen = useSticky(room);
  const streamOn = useSticky(room || reached.room);
  const timelineOn = useSticky(room || dock || viewing !== null || reached.room || reached.timeline);

  const page = usePaginatedQuery(api.messages.list, streamOn ? { app_id: app.id, ...creds } : "skip", { initialNumItems: STREAM_PAGE });
  const paged = streamOn && page.status !== "LoadingFirstPage";
  const latest = useVisitorQuery(api.messages.latest, paged ? "skip" : { app_id: app.id });
  const results = paged ? page.results : (latest ?? NO_MESSAGES);
  const messages = useMemo(() => [...results].reverse(), [results]);
  const pageStatus: StreamState["status"] = streamOn ? page.status : latest === undefined ? "LoadingFirstPage" : "Exhausted";
  const { loadMore: loadPage } = page;
  const loadMore = useCallback(() => loadPage(STREAM_PAGE), [loadPage]);

  const timeline = useVisitorQuery(api.versions.list, timelineOn ? { app_id: app.id } : "skip");
  const liveEntry = useVisitorQuery(api.versions.get, timeline ? "skip" : { app_id: app.id, number: app.live_version });
  // Without the timeline, the live version's entries seen so far, kept while
  // the next one loads.
  const [seen, setSeen] = useState<Map<number, TimelineEntry>>(new Map());
  if (liveEntry && seen.get(liveEntry.number) !== liveEntry) setSeen(new Map(seen).set(liveEntry.number, liveEntry));
  const versionByNumber = useMemo(() => (timeline ? new Map(timeline.map((v) => [v.number, v])) : seen), [timeline, seen]);

  // Where you are: the URL is the state, so a link always reopens it.
  const go = useCallback(
    (n: number | null, open: boolean, replace = false) => {
      const path = n === null ? appUrl(app.slug) : versionUrl(app.slug, n);
      navigate(open ? `${path}?room` : path, { replace });
    },
    [app.slug],
  );
  const [showAppAt, setShowAppAt] = useState(0);
  // Stepping through the past replaces the entry it came from, so Back
  // leaves the past in one step rather than replaying every version seen.
  const inPast = viewing !== null;
  const view = useCallback((n: number | null) => {
    go(n === app.live_version ? null : n, room, inPast);
    setShowAppAt(Date.now());
  }, [go, room, app.live_version, inPast]);
  const [warmed, warm] = useState<number | null>(null);
  const setRoomOpen = useCallback((open: boolean) => go(version, open, true), [go, version]);

  // The composer: its mode sticks per app on this device.
  const modeKey = `clayground.mode.${app.id}`;
  const [draft] = useState(createDraft);
  const [mode, setModeState] = useState<Mode>(() => load<Mode>(modeKey, "auto"));
  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    save(modeKey, m);
  }, [modeKey]);
  const [element, setElement] = useState<ElementRef | null>(null);
  const [focusAt, setFocusAt] = useState(0);
  const focus = useCallback(() => {
    setRoomOpen(true);
    setFocusAt(Date.now());
  }, [setRoomOpen]);

  const [picking, setPicking] = useState(false);
  const [reveal, setReveal] = useState<string | null>(null);
  const [flash, setFlash] = useState(0);
  const flashLive = useCallback(() => {
    view(null);
    setFlash((f) => f + 1);
  }, [view]);

  // Errors the app throws: the room hears about each version's first one,
  // whoever's browser saw it (the server keeps it to one note per version).
  const reportError = useVisitorMutation(api.messages.reportError);
  const reported = useRef(new Set<number>());
  const onError = useCallback(
    (v: number, message: string) => {
      if (reported.current.has(v)) return;
      reported.current.add(v);
      reportError({ app_id: app.id, version: v, message }).catch(() => reported.current.delete(v));
    },
    [reportError, app.id],
  );
  const liveError = messages.some((m) => m.note?.type === "error" && m.note.version === app.live_version);

  // The beat a version goes live: it lands when the new version is on
  // screen, and only then do the card, the bead, the faces and the app
  // celebrate together. Viewing the past, there is nothing to wait for.
  const [landed, setLanded] = useState(app.live_version);
  const [cheer, setCheer] = useState(0);
  const landedNow = useRef(app.live_version);
  const land = useCallback((v: number) => {
    if (v <= landedNow.current) return;
    landedNow.current = v;
    setLanded(v);
    setCheer(v);
  }, []);
  const liveNow = useRef(app.live_version);
  liveNow.current = app.live_version;
  const shownOnce = useRef(false);
  const onShown = useCallback((v: number) => {
    if (!shownOnce.current) {
      shownOnce.current = true;
      preloadParts();
    }
    if (v === liveNow.current) land(v);
  }, [land]);
  useEffect(() => {
    if (viewing !== null) land(app.live_version);
  }, [viewing, app.live_version, land]);
  const landing = app.live_version > landed ? app.live_version : null;

  // Where it landed: a ring around the element the change is about, drawn
  // in the app; when there is none on screen, the app column's edge glows.
  const frame = useRef<AppFrameHandle>(null);
  const [glow, setGlow] = useState(0);
  const spotlit = useRef(app.live_version);
  useEffect(() => {
    if (!cheer || cheer <= spotlit.current || viewing !== null) return;
    const entry = versionByNumber.get(cheer);
    if (!entry) return;
    spotlit.current = cheer;
    const where = entry.spotlight;
    if (!where) return setGlow(cheer);
    void (frame.current?.spotlight(where) ?? Promise.resolve(false)).then((found) => found || setGlow(cheer));
  }, [cheer, versionByNumber, viewing]);

  const restoreMutation = useVisitorMutation(api.versions.restore);
  const restore = useCallback(
    async (n: number, expectedLive: number) => {
      try {
        await restoreMutation({ app_id: app.id, number: n, expected_live: expectedLive });
        view(null);
      } catch (err) {
        toast({ text: errorData(err).message });
      }
    },
    [restoreMutation, app.id, view, toast],
  );
  const [forkFrom, setForkFrom] = useState<number | null>(null);
  const openCharacterPicker = useCallback(() => openPicker(hereNow.current.entries.map((e) => e.visitor)), [openPicker]);

  const building = useMemo(
    () =>
      (landing !== null ? messages.find((m) => m.build?.result_version === landing) : undefined) ??
      messages.find((m) => m.build?.status === "building") ??
      messages.find((m) => m.build?.status === "queued") ??
      null,
    [messages, landing],
  );
  // The gallery pictures a version from the screen of whoever asked for it,
  // once it has landed there, in a page of the gallery's size out of sight.
  const [pictured, setPictured] = useState(0);
  const live = app.live;
  const pictureLive = live && !live.has_still && live.author_id === me.id && landed === live.number && pictured !== live.number ? live.number : null;
  const pastBar = dock && viewing !== null;
  const shown = viewing ?? app.live_version;
  // Ready out of sight: the versions either side of the one on screen while
  // the timeline is open, and the one its hover points at.
  const preload = useMemo(
    () => [...new Set([...(dock || viewing !== null ? [shown - 1, shown + 1] : []), warmed ?? 0])].filter((n) => n >= 1 && n <= app.live_version && n !== shown),
    [dock, viewing, shown, warmed, app.live_version],
  );
  // The app on screen tried to write while looking only: the past bar says why.
  const [nudge, setNudge] = useState(0);
  const onRefused = useCallback(() => setNudge(Date.now()), []);
  // A new app's starter (v0) is only scaffolding: while its first build
  // runs, the column shows Clay at work instead (DESIGN 6.10).
  const making = landed === 0 && building !== null;
  // It stays a beat after the first version lands, fading over the app.
  const [madeBy, setMadeBy] = useState<MessageView | null>(null);
  useEffect(() => {
    if (making) return setMadeBy(building);
    const t = setTimeout(() => setMadeBy(null), FIRST_BUILD_FADE_MS);
    return () => clearTimeout(t);
  }, [making, building]);

  const state = useMemo<AppState>(
    () => ({
      app, timeline, versionByNumber, viewing, view, warm, prepare, flashLive, showAppAt, roomOpen: room, setRoomOpen, picking, setPicking,
      landed, making, cheer, restore, startFork: setForkFrom, openCharacterPicker, reveal, setReveal,
    }),
    [app, timeline, versionByNumber, viewing, view, prepare, flashLive, showAppAt, room, setRoomOpen, picking, landed, making, cheer, restore, openCharacterPicker, reveal],
  );
  const stream = useMemo<StreamState>(
    () => ({ messages, status: pageStatus, loadMore, building }),
    [messages, pageStatus, loadMore, building],
  );
  const composer = useMemo<ComposerState>(
    () => ({ draft, mode, setMode, element, setElement, focus, focusAt }),
    [draft, mode, setMode, element, focus, focusAt],
  );

  // Keys anywhere on the page: "/" opens the room, "t" the timeline alone
  // (desktop), Esc backs out of picking, then the past.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.closest("input, textarea, [contenteditable]") !== null);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        focus();
      } else if (e.key.toLowerCase() === "t" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && desktop && !room) {
        setTimelineOnly((t) => !t);
      } else if (e.key === "Escape" && !e.defaultPrevented) {
        if (picking) setPicking(false);
        else if (viewing !== null && !room) view(null);
        else if (timelineOnly && !room) setTimelineOnly(false);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [focus, picking, viewing, view, room, timelineOnly, desktop]);

  // Focus follows the room: opening it puts the cursor in the composer (on a
  // phone, the sheet itself, so no keyboard jumps up); closing it hands focus
  // to the capsule's Change it, unless it already went somewhere else.
  const capsuleFocus = useRef<HTMLButtonElement>(null);
  const roomWas = useRef(room);
  useEffect(() => {
    if (room === roomWas.current) return;
    roomWas.current = room;
    const roomEl = document.querySelector<HTMLElement>("[data-room]");
    if (!room) {
      if (focusLost(roomEl)) capsuleFocus.current?.focus();
    } else if (focusLost() && !freshFocus(focusAt)) {
      if (desktop) setFocusAt(Date.now());
      else roomEl?.focus({ preventScroll: true });
    }
  }, [room, desktop, focusAt]);

  const [roomWidth, setRoomWidth] = useState(() => load("clayground.roomWidth", ROOM_DEFAULT));
  const resizeRoom = useCallback((w: number) => {
    setRoomWidth(w);
    save("clayground.roomWidth", w);
  }, []);
  const panelWidth = desktop && room ? clampWidth(roomWidth) : 0;
  const lift = dock ? DOCK_HEIGHT + (pastBar ? PAST_BAR_HEIGHT : 0) : 0;
  const toggleTimeline = useCallback(() => setTimelineOnly((t) => !t), []);
  const closeTimeline = useCallback(() => setTimelineOnly(false), []);
  const backToLive = useCallback(() => view(null), [view]);

  // The stage: the app's frame shows the version in view, sized around the
  // panel and the dock.
  const [failed, setFailed] = useState<FailedFrame | null>(null);
  const onPicked = useCallback((el: ElementRef) => {
    setElement(el);
    setPicking(false);
    focus();
  }, [focus]);
  const onPickCancelled = useCallback(() => setPicking(false), []);
  const events = useMemo<AppFrameEvents>(
    () => ({ onPicked, onPickCancelled, onError, onShown, onRefused, onFailed: setFailed }),
    [onPicked, onPickCancelled, onError, onShown, onRefused],
  );
  const session = useMemo<FrameSession>(() => ({ creds, me, appId: app.id, name: app.name }), [creds, me, app.id, app.name]);
  const control = useMemo<StageControl>(
    () => ({ frame: { version: shown, live: app.live_version, preload, picking, session, events, ref: frame }, right: panelWidth, bottom: lift }),
    [shown, app.live_version, preload, picking, session, events, panelWidth, lift],
  );
  const { area, col } = useStage(control);

  return (
    <AppStateContext.Provider value={state}>
      <HereContext.Provider value={here}>
        <StreamContext.Provider value={stream}>
          <ComposerContext.Provider value={composer}>
            {area && createPortal(
              <>
                {madeBy && <FirstBuild m={madeBy} leaving={!making} />}
                {failed && <div className={s.failed}><FrameFailed {...failed} /></div>}
                {viewing !== null && <div className={s.pastOutline} />}
                {flash > 0 && <div key={flash} className={s.liveFlash} />}
                {glow > 0 && viewing === null && <div key={glow} className={s.landGlow} />}
                {/* Never over the app's own controls: with the timeline open the past
                    bar takes its own strip above it; otherwise the pill sits above
                    the capsule, and on a phone with the room open the sheet says it. */}
                {viewing !== null && !pastBar && (desktop || !room) && (
                  <ViewingPill number={viewing} place="capsule" compact={!desktop} nudge={nudge} onBack={backToLive} />
                )}
                {picking && <PickBanner onCancel={onPickCancelled} />}
                {pictureLive && (
                  <PreviewFrame
                    key={pictureLive}
                    appId={app.id}
                    slug={app.slug}
                    name={app.name}
                    version={pictureLive}
                    pictureIt
                    className={s.stillFrame}
                    onPictured={() => setPictured(pictureLive)}
                  />
                )}
              </>,
              area,
            )}
            {col && createPortal(
              <>
                {pastBar && viewing !== null && (
                  <div className={s.pastBar} style={{ bottom: DOCK_HEIGHT, height: PAST_BAR_HEIGHT }}>
                    <ViewingPill number={viewing} place="bar" compact={false} nudge={nudge} onBack={backToLive} />
                  </div>
                )}
                {dock && <TimelineDock onClose={room ? undefined : closeTimeline} />}
              </>,
              col,
            )}
            {roomSeen && (desktop ? <RoomPanel open={room} width={clampWidth(roomWidth)} onResize={resizeRoom} /> : <RoomSheet />)}
            {!room && <Capsule focusRef={capsuleFocus} errorDot={liveError} onTimeline={desktop ? toggleTimeline : undefined} lift={lift} />}
            {forkFrom !== null && <ForkModal from={forkFrom} onClose={() => setForkFrom(null)} />}
          </ComposerContext.Provider>
        </StreamContext.Provider>
      </HereContext.Provider>
    </AppStateContext.Provider>
  );
}
