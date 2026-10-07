// The capsule (DESIGN 6.2): who is here, the timeline, and "Change it". It
// sits in a corner, moves only when someone drags it, snaps to the nearest
// corner on release, and tucks into a tab when dragged past a side edge.
// Above it one callout says what is happening while the room is closed: what
// a friend just said, and a change from the moment it is asked to the moment
// it is live, where the asker is looking. A landing it could not show (tucked,
// or showing something else) is announced by a toast instead.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import type { MessageView } from "../../convex/messages";
import { clock, plural } from "../lib/format";
import { useIdentity } from "../lib/identity";
import { load, save } from "../lib/storage";
import { useLinger } from "../lib/useLinger";
import { useMedia } from "../lib/useMedia";
import { nameFor, reverseOf, versionLine } from "../lib/versionCopy";
import { Blob } from "../ui/Blob";
import { Button } from "../ui/Button";
import { Face } from "../ui/Face";
import { FaceStack } from "../ui/FaceStack";
import { BuildLine } from "../ui/BuildLine";
import { ChatIcon, CheckIcon, TimelineIcon } from "../ui/icons";
import { Keys } from "../ui/Keys";
import { Spinner } from "../ui/Spinner";
import { useTip } from "../ui/Tip";
import { LiveToastText, useToast } from "../ui/Toast";
import { useAppState, useComposer, useHereState, useStream } from "./appState";
import { ReverseButton, TryIt, useReverse, useSummary } from "./BuildCard";
import { changePhase, useBusy, useBuildTicker, type ChangePhase } from "./buildTicker";
import s from "./Capsule.module.css";

type Corner = "tl" | "tr" | "bl" | "br";
type Placement = { corner: Corner; tucked: null | { side: "left" | "right"; y: number } };

const KEY = "clayground.capsule";
const HINT_KEY = "clayground.hinted";
const TUCK_PAST = 40;

/** `onTimeline` is desktop's: on a phone the timeline lives in the room.
 *  `lift`: a dock along the bottom edge the capsule must sit above. */
export function Capsule({ errorDot, onTimeline, lift = 0, focusRef }: { errorDot: boolean; onTimeline?: () => void; lift?: number; focusRef?: RefObject<HTMLButtonElement | null> }) {
  const { setRoomOpen, setReveal, cheer } = useAppState();
  const here = useHereState();
  const stream = useStream();
  const composer = useComposer();
  const { building } = stream;
  const narrow = useMedia("(max-width: 767px)");
  // No keyboard to speak of: a phone, or any touch screen.
  const touch = useMedia("(hover: none)") || narrow;
  const margin = narrow ? 12 : 20;
  const [place, setPlace] = useState<Placement>(() => load<Placement>(KEY, { corner: "br", tucked: null }));
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [snapFrom, setSnapFrom] = useState<{ dx: number; dy: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const timelineTip = useTip(<>Timeline <Keys keys={["T"]} /></>, place.corner[0] === "t" ? "below" : "above");

  const commit = (p: Placement) => {
    setPlace(p);
    save(KEY, p);
  };

  // After a release the capsule sits in its corner, offset back to where it
  // was let go; the next frame lets it spring home.
  useLayoutEffect(() => {
    if (!snapFrom) return;
    box.current?.getBoundingClientRect();
    const t = setTimeout(() => setSnapFrom(null), 16);
    return () => clearTimeout(t);
  }, [snapFrom]);

  // Most recent speaker first, then everyone else in arrival order.
  const people = useMemo(() => {
    const spoke = new Map<string, number>();
    for (const m of stream.messages) if (m.author) spoke.set(m.author.id, m.created_at);
    return [...here.people].sort((a, b) => (spoke.get(b.id) ?? 0) - (spoke.get(a.id) ?? 0));
  }, [here.people, stream.messages]);

  const hint = useFirstVisitHint();
  const heard = useHeard();
  const change = useFollowedChange();
  // One callout at a time: a landing (or a miss) first, so it happens where
  // the asker is looking; then what someone just said; then the change in
  // flight. A said message that turns into a request keeps its callout.
  const showing = !place.tucked && !hint.show && !drag;
  const settling = change.phase === "landing" || change.phase === "live" || change.phase === "failed";
  const followed = change.m && { m: change.m, hold: change.hold };
  const subject = !showing ? null : (settling && followed) || (heard.said && { m: heard.said, hold: heard.hold }) || followed;
  const landingShown = subject?.m === change.m && (change.phase === "landing" || change.phase === "live");
  useLandingToast(landingShown ? (change.m?.build?.result_version ?? null) : null);

  const startDrag = (e: ReactPointerEvent) => {
    e.preventDefault();
    hint.dismiss();
    const rect = box.current!.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setDrag({ x: ev.clientX - dx, y: ev.clientY - dy });
    const up = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      const x = ev.clientX - dx;
      const y = ev.clientY - dy;
      setDrag(null);
      const yClamped = Math.min(Math.max(y, margin), innerHeight - rect.height - margin);
      if (x < -TUCK_PAST) return commit({ corner: place.corner, tucked: { side: "left", y: yClamped } });
      if (x + rect.width > innerWidth + TUCK_PAST) return commit({ corner: place.corner, tucked: { side: "right", y: yClamped } });
      const corner = nearestCorner(x + rect.width / 2, y + rect.height / 2);
      const home = { x: corner[1] === "l" ? margin : innerWidth - rect.width - margin, y: corner[0] === "t" ? margin : innerHeight - rect.height - margin - lift };
      setSnapFrom({ dx: x - home.x, dy: y - home.y });
      commit({ corner, tucked: null });
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  if (place.tucked) {
    const { side, y } = place.tucked;
    return (
      <button
        ref={focusRef}
        className={`${s.tab} ${s[side]}`}
        style={{ top: Math.min(y, innerHeight - 100) }}
        onClick={() => commit({ corner: `${y < innerHeight / 2 ? "t" : "b"}${side === "left" ? "l" : "r"}` as Corner, tucked: null })}
        aria-label={`${plural(here.people.length, "person", "people")} here${heard.unread ? `, ${plural(heard.unread, "new message")}` : ""}. Show the capsule`}
      >
        {people[0] && <Face person={people[0]} size={24} />}
        <span className={s.count}>{here.people.length}</span>
        {heard.unread > 0 && <span className={s.badge} aria-hidden>{heard.unread}</span>}
        {building && <Spinner />}
      </button>
    );
  }

  const openRoom = () => {
    hint.dismiss();
    setRoomOpen(true);
  };

  const c = place.corner;
  const anchored = {
    [c[1] === "l" ? "left" : "right"]: margin,
    [c[0] === "t" ? "top" : "bottom"]: c[0] === "t" ? margin : margin + lift,
    transform: snapFrom ? `translate(${snapFrom.dx}px, ${snapFrom.dy}px)` : undefined,
  };

  return (
    <div
      ref={box}
      className={`${s.capsule} ${drag ? s.dragging : ""} ${snapFrom ? s.snapping : ""}`}
      style={drag ? { left: drag.x, top: drag.y } : anchored}
      data-corner={c}
      onPointerDown={hint.dismiss}
    >
      <span className={s.grip} onPointerDown={startDrag} aria-hidden title="Drag me">
        <i /><i /><i /><i /><i /><i />
      </span>
      <button
        className={s.people}
        onClick={openRoom}
        aria-label={`${plural(here.people.length, "person", "people")} here${heard.unread ? `, ${plural(heard.unread, "new message")}` : ""}${errorDot && !onTimeline ? ". The app hit an error" : ""}. Open the room`}
      >
        <FaceStack people={people} max={narrow ? 3 : 4} size={24} typing={here.typing} hop={cheer} />
        <span className={s.here}>{here.people.length} here</span>
        {heard.unread > 0 && <span className={s.badge} aria-hidden>{heard.unread}</span>}
        {errorDot && !onTimeline && <ErrorDot />}
      </button>
      {onTimeline && (
        <>
          <i className={s.divider} />
          <button className={s.tool} onClick={onTimeline} aria-label={errorDot ? "Timeline. The app hit an error" : "Timeline"} aria-keyshortcuts="T" {...timelineTip.describedBy}>
            <TimelineIcon />
            {errorDot && <ErrorDot />}
            {timelineTip.tip}
          </button>
        </>
      )}
      <button
        ref={focusRef}
        className={`${s.change} on-dark`}
        aria-keyshortcuts="/"
        onClick={() => {
          composer.setMode("change");
          composer.focus();
        }}
      >
        <ChatIcon />
        Change it
        {!narrow && <Keys keys={["/"]} hidden />}
      </button>
      {subject && (
        <Callout
          key={subject.m.id}
          m={subject.m}
          hold={subject.hold}
          onOpen={() => {
            setRoomOpen(true);
            setReveal(subject.m.id);
          }}
        />
      )}
      {hint.show && !drag && (
        <div className={s.hint} onClick={hint.dismiss} role="note">
          <span>
            {here.people.length > 1
              ? `${here.people.length} people are in here. Open the room to watch them or change the app.`
              : "Anyone with this link can change this app. Say what you'd change."}
          </span>
          <small>
            {touch ? "Drag it out of the way." : <>Drag it anywhere. <Keys keys={["/"]} /> opens the room.</>}
          </small>
        </div>
      )}
    </div>
  );
}

const SAID_MS = 5000;
const LIVE_MS = 5000;
const TOAST_AFTER_MS = 400;

type Hold = (on: boolean) => void;

/** The callout above the capsule, for one message as it changes: what was
 *  said, then, once it is a request, its build from in line to live. Hovering
 *  or focusing it holds it. */
function Callout({ m, hold, onOpen }: { m: MessageView; hold: Hold; onOpen: () => void }) {
  return (
    <div
      className={`${s.callout} ${m.build ? "" : s.said}`}
      onPointerEnter={() => hold(true)}
      onPointerLeave={() => hold(false)}
      onFocus={() => hold(true)}
      onBlur={() => hold(false)}
    >
      {m.build ? <ChangeView m={m} onOpen={onOpen} /> : <SaidView m={m} onOpen={onOpen} />}
    </div>
  );
}

/** One line of what someone just said. */
function SaidView({ m, onOpen }: { m: MessageView; onOpen: () => void }) {
  return (
    <button className={s.calloutMain} onClick={onOpen} aria-label={`${m.author!.name}: ${m.body}. Open the room`}>
      <Face person={m.author!} size={20} />
      <b>{m.author!.name}</b>
      <span className={s.saidText}>{m.body}</span>
    </button>
  );
}

const GLYPH: Record<ChangePhase, () => ReactNode> = {
  starting: () => <Spinner />,
  queued: () => <Blob size={16} />,
  building: () => <Spinner />,
  landing: () => <span className={s.check}><CheckIcon /></span>,
  live: () => <span className={s.check}><CheckIcon /></span>,
  failed: () => <span className={s.bang}>!</span>,
};

/** A change, said where the capsule is: who is changing it and how it is
 *  going, then the one celebration in place (the line turns green, "v16 is
 *  live", what changed and what to try) with Undo beside it. */
function ChangeView({ m, onOpen }: { m: MessageView; onOpen: () => void }) {
  const t = useBuildTicker(m);
  const { me } = useIdentity();
  const { versionByNumber } = useAppState();
  const summary = useSummary(m.build!);
  const undo = useReverse(t?.version ?? 0);
  if (!t) return null;
  const live = t.phase === "live";
  const tryIt = live ? versionByNumber.get(t.version)?.try_it : null;
  const who = nameFor(m.author, me.id);
  return (
    <>
      <BuildLine progress={t.progress} state={t.state} />
      <button className={s.calloutMain} onClick={onOpen} aria-label={`${t.title}, asked by ${who}. Open the room`}>
        <span className={s.calloutHead}>
          {GLYPH[t.phase]()}
          <span className={s.calloutTitle}>
            {live || t.phase === "landing" ? <>v{t.version} <span className={s.liveWord}>{live ? "is live" : "going live"}</span></> : t.title}
          </span>
          <span className={s.calloutWho}>
            {m.author && <Face person={m.author} size={16} />}
            <span className={s.calloutName}>{who}</span>
            {t.phase === "building" && t.elapsed > 0 && <span className={s.calloutClock}>{clock(t.elapsed)}</span>}
          </span>
        </span>
        {live ? <span className={s.calloutSummary}>{summary || m.body}</span> : <span className={s.calloutLine} key={t.lineKey}>{t.line}</span>}
      </button>
      {live && (
        <div className={s.calloutLive}>
          {tryIt && <TryIt text={tryIt} className={s.tryIt} />}
          <div className={s.calloutActions}>
            {undo && <ReverseButton r={undo} />}
            <Button variant="text" onClick={onOpen}>Open</Button>
          </div>
        </div>
      )}
    </>
  );
}

/** What friends say while the room is closed: the count since the capsule
 *  appeared (on arrival, or when the room closed), and the latest message for
 *  a few seconds of time on screen. Only finished chat counts: your own
 *  messages, requests and a message still being sorted never do. */
function useHeard() {
  const { messages, status } = useStream();
  const { me } = useIdentity();
  const since = useRef<number | null>(null);
  if (since.current === null && status !== "LoadingFirstPage") since.current = messages.at(-1)?.created_at ?? 0;
  const from = since.current;
  const fromOthers = useMemo(
    () => (from === null ? [] : messages.filter((m) => (m.kind === "chat" || m.kind === "request") && m.author && m.author.id !== me.id && m.created_at > from)),
    [messages, from, me.id],
  );
  const unread = fromOthers.filter((m) => m.kind === "chat" && !m.build && !m.triage_pending).length;
  const latest = fromOthers.at(-1)?.id ?? null;
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => setSaid(latest), [latest]);
  const { hold } = useLinger(said, SAID_MS, () => setSaid(null), true);
  return { unread, said: (said && messages.find((m) => m.id === said)) || null, hold };
}

/** The change the callout follows: the one in flight, kept through its
 *  landing (or its failure) for a few seconds of time on screen, then the
 *  next in flight, if any. */
function useFollowedChange() {
  const { landed } = useAppState();
  const { messages, building } = useStream();
  const busy = useBusy();
  const next = building?.id ?? null;
  const [id, setId] = useState<string | null>(next);
  const m = (id && messages.find((x) => x.id === id)) || null;
  const phase = m?.build ? changePhase(m.build, landed, busy) : null;
  const settled = phase === "live" || phase === "failed";
  useEffect(() => {
    if (!settled && next !== null && next !== id) setId(next);
  }, [settled, next, id]);
  const nextNow = useRef(next);
  nextNow.current = next;
  const { hold } = useLinger(settled ? id : null, LIVE_MS, () => setId(nextNow.current), true);
  return { m: phase ? m : null, phase, hold };
}

/** A version that lands while the callout cannot show it (`presented` is the
 *  version it is showing land) gets the toast at the top, with its Undo. */
function useLandingToast(presented: number | null) {
  const { cheer, versionByNumber, setRoomOpen, setReveal, restore } = useAppState();
  const { messages } = useStream();
  const toast = useToast();
  const told = useRef(cheer);
  const now = useRef({ presented, messages });
  now.current = { presented, messages };
  useEffect(() => {
    if (!cheer || cheer <= told.current) return;
    const entry = versionByNumber.get(cheer);
    if (!entry) return;
    told.current = cheer;
    if (now.current.presented === cheer) return;
    const line = versionLine(entry, versionByNumber);
    const back = reverseOf(entry, versionByNumber);
    // It follows the app's own swap rather than racing it.
    setTimeout(() => toast({
      face: entry.author ?? undefined,
      text: <LiveToastText version={entry.number} name={entry.author?.name} verb={line.verb} summary={line.summary} />,
      action: back ? { label: back.label, onClick: () => void restore(back.target, entry.number) } : undefined,
      onClick: () => {
        setRoomOpen(true);
        const at = entry.request_message_id ?? now.current.messages.find((m) => m.note?.type === "restore" && m.note.version === entry.number)?.id;
        if (at) setReveal(at);
      },
    }), TOAST_AFTER_MS);
  }, [cheer, versionByNumber, toast, restore, setRoomOpen, setReveal]);
}

function ErrorDot() {
  return <i className={s.errorDot} aria-hidden />;
}

function nearestCorner(cx: number, cy: number): Corner {
  return `${cy < innerHeight / 2 ? "t" : "b"}${cx < innerWidth / 2 ? "l" : "r"}` as Corner;
}

/** Shown the first time this device opens any app, so a newcomer learns that
 *  anyone can change it, alone or not; gone on any click, on drag, or after
 *  10s, and never again. */
function useFirstVisitHint() {
  const [state, setState] = useState<"unseen" | "showing" | "done">(() => (load(HINT_KEY, false) ? "done" : "unseen"));
  useEffect(() => {
    if (state !== "unseen") return;
    setState("showing");
    save(HINT_KEY, true);
  }, [state]);
  useEffect(() => {
    if (state !== "showing") return;
    const t = setTimeout(() => setState("done"), 10_000);
    const click = () => setState("done");
    addEventListener("pointerdown", click, { once: true });
    return () => {
      clearTimeout(t);
      removeEventListener("pointerdown", click);
    };
  }, [state]);
  return { show: state === "showing", dismiss: () => state === "showing" && setState("done") };
}
