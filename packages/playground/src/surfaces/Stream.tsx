// The room's stream (DESIGN 6.3, 6.4): chat, build cards and notes in time
// order, sticking to the bottom while you are near it, with a "3 new" pill
// when you are not, older pages loading as you scroll up. A version sits
// where it landed, not where it was asked for, so the versions read in
// order top to bottom.
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MessageView } from "../../convex/messages";
import { useIdentity } from "../lib/identity";
import { inLandingOrder } from "../lib/streamOrder";
import { nameFor, restoreSaid } from "../lib/versionCopy";
import { chatTime } from "../lib/format";
import { useNow } from "../lib/useNow";
import { useReducedMotion } from "../lib/useMedia";
import { Blob } from "../ui/Blob";
import { Dots } from "../ui/Dots";
import { Face } from "../ui/Face";
import { appUrl } from "../lib/router";
import { Link } from "../ui/Link";
import { useTyping } from "../data/presence";
import { useAppState, useHereState, useStream } from "./appState";
import { BuildCard, RestoreCard, WaitingCard } from "./BuildCard";
import { IdeaChips } from "./IdeaChips";
import { ChatMessage, SystemNote } from "./ChatMessage";
import s from "./Stream.module.css";

const GROUP_MS = 2 * 60_000;
const STICK_PX = 80;
const LOAD_MORE_PX = 160;
/** A scroll this soon after a wheel or touch is the reader's own. */
const HAND_MS = 250;

/** `onBrowse`: the reader scrolled back into history by hand. */
export const Stream = memo(function Stream({ onBrowse }: { onBrowse?: () => void }) {
  const { reveal, setReveal } = useAppState();
  const stream = useStream();
  const here = useHereState();
  const { me } = useIdentity();
  const now = useNow(30_000);
  const behavior = useReducedMotion() ? "auto" : "smooth";
  const items = useMemo(() => inLandingOrder(stream.messages), [stream.messages]);

  // Two people here sharing a name get their animal after it.
  const sharedNames = useMemo(() => {
    const ids = new Map<string, Set<string>>();
    for (const p of [...here.people, ...stream.messages.flatMap((m) => (m.author ? [m.author] : []))]) {
      ids.set(p.name, (ids.get(p.name) ?? new Set()).add(p.id));
    }
    return new Set([...ids].filter(([, set]) => set.size > 1).map(([name]) => name));
  }, [here.people, stream.messages]);

  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [unseen, setUnseen] = useState(0);
  const lastId = useRef<string | null>(null);
  const firstId = useRef<string | null>(null);
  const heightBefore = useRef(0);
  const lastTop = useRef(0);
  const handAt = useRef(0);

  // Keep the view where the reader left it as items arrive at either end.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || items.length === 0) return;
    const first = itemKey(items[0]);
    const last = itemKey(items[items.length - 1]);
    if (firstId.current && first !== firstId.current && last === lastId.current) {
      el.scrollTop += el.scrollHeight - heightBefore.current;
    } else if (last !== lastId.current) {
      if (atBottom.current || lastId.current === null || mine(items[items.length - 1], me.id)) {
        el.scrollTop = el.scrollHeight;
        setUnseen(0);
      } else {
        const idx = items.findIndex((i) => itemKey(i) === lastId.current);
        setUnseen((n) => n + (idx < 0 ? 1 : items.length - 1 - idx));
      }
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    firstId.current = first;
    lastId.current = last;
    heightBefore.current = el.scrollHeight;
  });

  // The typing row and growing build cards keep a bottom-stuck view stuck:
  // any row that grows grows the list.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !list.current) return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
      heightBefore.current = el.scrollHeight;
    });
    ro.observe(list.current);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scroller.current!;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    if (atBottom.current) setUnseen(0);
    if (onBrowse && el.scrollTop < lastTop.current && performance.now() - handAt.current < HAND_MS) onBrowse();
    lastTop.current = el.scrollTop;
    if (el.scrollTop < LOAD_MORE_PX && stream.status === "CanLoadMore") {
      heightBefore.current = el.scrollHeight;
      stream.loadMore();
    }
  };

  const toBottom = () => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior });
    setUnseen(0);
  };

  // The toast's click: bring that card into view and flash it.
  useEffect(() => {
    if (!reveal) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-id="${reveal}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior });
    el.dataset.flash = "1";
    setTimeout(() => delete el.dataset.flash, 900);
    setReveal(null);
  }, [reveal, items, setReveal, behavior]);

  const loading = stream.status === "LoadingFirstPage";
  const exhausted = stream.status === "Exhausted";
  return (
    <div className={s.wrap}>
      <BuildStatus />
      <div
        className={s.stream}
        ref={scroller}
        onScroll={onScroll}
        onWheel={() => (handAt.current = performance.now())}
        onTouchMove={() => (handAt.current = performance.now())}
      >
        <div className={s.items} ref={list}>
          {exhausted && <OriginRow />}
          {!loading && items.length === 0 && <EmptyRoom />}
          {stream.status === "LoadingMore" && <div className={s.more} aria-hidden><Dots /></div>}
          {/* Only new rows are news: older pages arrive while it is busy,
              and the typing row sits outside it. */}
          <div className={s.log} role="log" aria-label="Room messages" aria-relevant="additions" aria-busy={stream.status === "LoadingMore" || loading}>
            {items.map((m, i) => (
              <Fragment key={m.id}>{renderItem(m, items[i - 1], now, me.id, sharedNames)}</Fragment>
            ))}
          </div>
          <TypingRow />
        </div>
      </div>
      {unseen > 0 && (
        <button className={s.newPill} onClick={toBottom}>
          {unseen} new
        </button>
      )}
    </div>
  );
});

/** What Clay is doing, said once per change for screen readers. The log
 *  announces new rows; a card changing state in place is said here. The
 *  latest row that moves the app, restores included, decides it. */
function BuildStatus() {
  const { app, versionByNumber } = useAppState();
  const { messages } = useStream();
  const { me } = useIdentity();
  const latest = messages.findLast((m) => m.build || m.note?.type === "restore");
  const b = latest?.build;
  const note = latest?.note?.type === "restore" ? latest.note : null;
  const text =
    note ? `v${note.version} is live. ${restoreSaid(note, versionByNumber, me.id)}`
    : !b ? ""
    : b.status === "queued" ? "A change is in line"
    : b.status === "building" ? `Clay is building v${b.result_version ?? app.version_count + 1}`
    : b.status === "live" ? `v${b.result_version} is live`
    : b.failure === "declined" ? `Clay answered: ${b.error ?? ""}`
    : `Didn't make it. ${b.error ?? ""}`;
  return <p className="sr-only" role="status">{text}</p>;
}

const itemKey = (m: MessageView) => m.id;
const mine = (m: MessageView, meId: string) => m.author?.id === meId;

function renderItem(m: MessageView, p: MessageView | undefined, now: number, meId: string, sharedNames: Set<string>) {
  if (m.note?.type === "restore") return <RestoreCard m={m} note={m.note} />;
  if (m.kind === "system") return <SystemNote m={m} />;
  if (m.build) return <BuildCard m={m} b={m.build} />;
  if (m.kind === "request") return <WaitingCard m={m} />;
  if (m.kind === "build") return null;
  const grouped =
    !!p && p.kind === "chat" && !p.build && p.author?.id === m.author?.id && m.created_at - p.created_at < GROUP_MS;
  return <ChatMessage m={m} grouped={grouped} now={now} mine={m.author?.id === meId} sharedName={!!m.author && sharedNames.has(m.author.name)} />;
}

function TypingRow() {
  const here = useHereState();
  const { app } = useAppState();
  const typing = useTyping(app.id);
  const t = here.people.slice(1).filter((p) => typing.has(p.id));
  if (t.length === 0) return null;
  const text =
    t.length === 1 ? `${t[0].name} is typing` : t.length === 2 ? `${t[0].name} and ${t[1].name} are typing` : `${t.length} people are typing`;
  return (
    <div className={s.typing} aria-hidden>
      <span className={s.typingFaces}>
        {t.slice(0, 3).map((p) => (
          <Face key={p.id} person={p} size={16} />
        ))}
      </span>
      {text}
      <Dots />
    </div>
  );
}

function EmptyRoom() {
  return (
    <div className={s.empty}>
      <Blob size={44} />
      <p className={s.quiet}>It's quiet in here.</p>
      <p className={s.emptyHint}>Say what you'd change. Clay builds it and everyone sees it.</p>
      <IdeaChips className={s.ideas} />
    </div>
  );
}

/** The top of every room: who made the app, when, and what it started as,
 *  or for a fork, where it came from (DESIGN 6.8). It sits at the top of the
 *  scroll while the log stays anchored to the bottom. */
function OriginRow() {
  const { app, timeline } = useAppState();
  const { me } = useIdentity();
  const { messages } = useStream();
  const now = useNow(60_000);
  const from = app.forked_from;
  const by = app.created_by;
  // A made app's first words are its maker's first request, in their words;
  // the starter under it is only scaffolding, so it never speaks for them.
  // While Clay makes it, the card below already says what they asked.
  // Only the maker's own words: on an app made from a starter, the first
  // change is someone else's and says nothing about who made it.
  const first = timeline?.find((v) => v.kind !== "seed");
  const firstShown = first && first.author?.id === by?.id ? first : undefined;
  const firstAsk = firstShown?.kind === "build" ? firstShown.request_message_id : undefined;
  const said = from ? null : (firstAsk && messages.find((m) => m.id === firstAsk)?.body);
  const detail = from ? "Same code, a copy of the data. Change anything." : (said ?? firstShown?.summary);
  return (
    <div className={s.origin}>
      {by ? <Face person={by} size={28} /> : <Blob size={28} />}
      <p className={s.originHead}>
        <b>{by ? nameFor(by, me.id) : "Clay"}</b> {from ? "forked" : "made"} <b>{app.name}</b>
        {from && (
          <>
            {" "}from{" "}
            <Link className={s.originLink} to={appUrl(from.slug)}>{from.name} v{from.version}</Link>
          </>
        )}
        <time className={s.originWhen}>{chatTime(app.created_at, now)}</time>
      </p>
      {detail && <p className={s.originDetail}>{said ? <q>{detail}</q> : detail}</p>}
    </div>
  );
}
