// An app's page: /<slug> (live), /<slug>?room (room open), /<slug>/v/<n>
// (viewing the past). The app fills the viewport; the shell adds the capsule,
// and when asked, the room and the timeline (DESIGN 6.2 to 6.7).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePaginatedQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { AppView } from "../../convex/apps";
import type { ElementRef } from "../../convex/validators";
import { restoreVersion } from "../data/timelineApi";
import { useHere, usePresenceBeat } from "../data/presence";
import { errorData } from "../lib/errors";
import { useIdentity, useVisitorMutation, useVisitorQuery } from "../lib/identity";
import { appUrl, navigate, versionUrl } from "../lib/router";
import { load, save } from "../lib/storage";
import { useDesktop } from "../lib/useMedia";
import { useToast } from "../ui/Toast";
import { Blob } from "../ui/Blob";
import { AppFrame } from "./AppFrame";
import { AppStateContext, type AppErrorNote, type AppState, type Mode } from "./appState";
import { Capsule } from "./Capsule";
import { useCharacterPicker } from "./CharacterPicker";
import { ForkModal } from "./ForkModal";
import { NotFound } from "./NotFound";
import { PickBanner, ViewingPill } from "./ViewingPill";
import { RoomPanel, RoomSheet } from "./Room";
import { FirstBuild, isFirstBuild } from "./FirstBuild";
import { TimelineDock } from "./Timeline";
import { useOpenGraph } from "./openGraph";
import { ROOM_DEFAULT, clampWidth } from "./roomSize";
import s from "./AppPage.module.css";

export function AppPage({ slug, version, room }: { slug: string; version: number | null; room: boolean }) {
  const app = useVisitorQuery(api.apps.get, { slug });
  if (app === undefined) return <Waiting />;
  if (app === null) return <NotFound />;
  return <AppRoom key={app.id} app={app} version={version} room={room} />;
}

/** Nothing for the first 400ms, then the butter grid and the blob. */
function Waiting() {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setLate(true), 400);
    return () => clearTimeout(t);
  }, []);
  return <div className={s.waiting}>{late && <Blob size={72} squash />}</div>;
}

const STREAM_PAGE = 40;

function AppRoom({ app, version, room }: { app: AppView; version: number | null; room: boolean }) {
  const { creds } = useIdentity();
  const toast = useToast();
  const desktop = useDesktop();
  const openPicker = useCharacterPicker();
  useOpenGraph(app);

  const timeline = useVisitorQuery(api.versions.list, { app_id: app.id });
  const versionByNumber = useMemo(() => new Map((timeline ?? []).map((v) => [v.number, v])), [timeline]);
  const here = useHere(app.id);

  const viewing = version !== null && version !== app.live_version && version <= app.version_count ? version : null;
  usePresenceBeat(app.id, viewing);

  const page = usePaginatedQuery(api.messages.list, { app_id: app.id, ...creds }, { initialNumItems: STREAM_PAGE });
  const messages = useMemo(() => [...page.results].reverse(), [page.results]);

  // Where you are: the URL is the state, so a link always reopens it.
  const go = useCallback(
    (n: number | null, open: boolean, replace = false) => {
      const path = n === null ? appUrl(app.slug) : versionUrl(app.slug, n);
      navigate(open ? `${path}?room` : path, { replace });
    },
    [app.slug],
  );
  const view = useCallback((n: number | null) => go(n === app.live_version ? null : n, room), [go, room, app.live_version]);
  const setRoomOpen = useCallback((open: boolean) => go(version, open, true), [go, version]);

  // The composer: its mode sticks per app on this device.
  const modeKey = `clayground.mode.${app.id}`;
  const [text, setText] = useState("");
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

  // Errors the app throws in this browser: one Clay note per version.
  const [errorNotes, setErrorNotes] = useState<AppErrorNote[]>([]);
  const onError = useCallback((v: number, message: string) => {
    setErrorNotes((notes) => (notes.some((n) => n.version === v) ? notes : [...notes, { id: `error:${v}`, version: v, message, at: Date.now() }]));
  }, []);
  const liveError = errorNotes.some((n) => n.version === app.live_version);

  // A version going live while you are here: the toast (DESIGN 6.2).
  const seenLive = useRef(app.live_version);
  useEffect(() => {
    if (app.live_version <= seenLive.current) return;
    const entry = versionByNumber.get(app.live_version);
    if (!entry) return;
    seenLive.current = app.live_version;
    toast({
      face: entry.author ?? undefined,
      text: `v${entry.number} is live · ${entry.author ? `${entry.author.name}: ` : ""}${entry.summary}`,
      onClick: () => {
        setRoomOpen(true);
        if (entry.request_message_id) setReveal(entry.request_message_id);
      },
    });
  }, [app.live_version, versionByNumber, toast, setRoomOpen]);

  const restoreMutation = useVisitorMutation(restoreVersion);
  const restore = useCallback(
    async (n: number) => {
      try {
        await restoreMutation({ app_id: app.id, number: n });
        view(null);
      } catch (err) {
        const missing = String(err).includes("Could not find public function");
        toast({ text: missing ? "Restoring is almost ready. Try again soon." : errorData(err).message });
      }
    },
    [restoreMutation, app.id, view, toast],
  );
  const [forkFrom, setForkFrom] = useState<number | null>(null);

  const building = messages.some((m) => m.build?.status === "building");
  const firstBuild = isFirstBuild(app, messages);
  const [timelineOnly, setTimelineOnly] = useState(false);
  const dock = desktop && (room || timelineOnly);

  const state: AppState = {
    app,
    timeline,
    versionByNumber,
    here,
    stream: { messages, status: page.status, loadMore: () => page.loadMore(STREAM_PAGE) },
    errorNotes,
    viewing,
    view,
    flashLive,
    roomOpen: room,
    setRoomOpen,
    composer: { text, setText, mode, setMode, element, setElement, focus, focusAt },
    picking,
    setPicking,
    building,
    restore,
    startFork: setForkFrom,
    openCharacterPicker: () => openPicker(here.entries.map((e) => e.visitor)),
    reveal,
    setReveal,
  };

  // Keys anywhere on the page: "/" opens the room, Esc backs out of picking,
  // then the past.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.closest("input, textarea, [contenteditable]") !== null);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        focus();
      } else if (e.key === "Escape" && !e.defaultPrevented) {
        if (picking) setPicking(false);
        else if (timelineOnly && !room) setTimelineOnly(false);
        else if (viewing !== null && !room) view(null);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [focus, picking, viewing, view, room, timelineOnly]);

  const [roomWidth, setRoomWidth] = useState(() => load("clayground.roomWidth", ROOM_DEFAULT));
  const panelWidth = desktop && room ? clampWidth(roomWidth) : 0;

  return (
    <AppStateContext.Provider value={state}>
      <div className={s.page}>
        <main className={s.appCol} style={{ right: panelWidth }}>
          <div className={s.appArea} style={{ bottom: dock ? 76 : 0 }}>
            {firstBuild ? (
              <FirstBuild />
            ) : (
              <AppFrame
                slug={app.slug}
                appId={app.id}
                version={viewing ?? app.live_version}
                picking={picking}
                onPicked={(el) => {
                  setElement(el);
                  setPicking(false);
                  focus();
                }}
                onPickCancelled={() => setPicking(false)}
                onError={onError}
              />
            )}
            {viewing !== null && <div className={s.pastOutline} />}
            {flash > 0 && <div key={flash} className={s.liveFlash} />}
            {viewing !== null && <ViewingPill number={viewing} onBack={() => view(null)} />}
            {picking && <PickBanner onCancel={() => setPicking(false)} />}
          </div>
          {dock && <TimelineDock onClose={room ? undefined : () => setTimelineOnly(false)} />}
        </main>
        {desktop ? (
          <RoomPanel
            open={room}
            width={clampWidth(roomWidth)}
            onResize={(w) => {
              setRoomWidth(w);
              save("clayground.roomWidth", w);
            }}
          />
        ) : (
          <RoomSheet />
        )}
        {!room && <Capsule errorDot={liveError} onTimeline={desktop ? () => setTimelineOnly((t) => !t) : () => setRoomOpen(true)} />}
        {forkFrom !== null && <ForkModal from={forkFrom} onClose={() => setForkFrom(null)} />}
      </div>
    </AppStateContext.Provider>
  );
}
