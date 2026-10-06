// The room's stream (DESIGN 6.3, 6.4): chat, build cards and notes in time
// order, sticking to the bottom while you are near it, with a "3 new" pill
// when you are not, older pages loading as you scroll up.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MessageView } from "../../convex/messages";
import { useIdentity } from "../lib/identity";
import { useNow } from "../lib/useNow";
import { Blob } from "../ui/Blob";
import { Chip } from "../ui/Chips";
import { Dots } from "../ui/Dots";
import { Face } from "../ui/Face";
import { ArrowRightIcon } from "../ui/icons";
import { appUrl, navigate } from "../lib/router";
import { useAppState } from "./appState";
import { BuildCard, WaitingCard } from "./BuildCard";
import { ChatMessage, SystemNote } from "./ChatMessage";
import s from "./Stream.module.css";

const GROUP_MS = 2 * 60_000;
const STICK_PX = 80;
const LOAD_MORE_PX = 160;

export function Stream({ latestOnly = false }: { latestOnly?: boolean }) {
  const { stream, here, reveal, setReveal } = useAppState();
  const { me } = useIdentity();
  const now = useNow(30_000);
  const items = stream.messages;

  // Two people here sharing a name get their animal after it.
  const sharedNames = useMemo(() => {
    const ids = new Map<string, Set<string>>();
    for (const p of [...here.people, ...stream.messages.flatMap((m) => (m.author ? [m.author] : []))]) {
      ids.set(p.name, (ids.get(p.name) ?? new Set()).add(p.id));
    }
    return new Set([...ids].filter(([, set]) => set.size > 1).map(([name]) => name));
  }, [here.people, stream.messages]);

  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [unseen, setUnseen] = useState(0);
  const lastId = useRef<string | null>(null);
  const firstId = useRef<string | null>(null);
  const heightBefore = useRef(0);

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

  // The typing row and growing build cards keep a bottom-stuck view stuck.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
      heightBefore.current = el.scrollHeight;
    });
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  });

  const onScroll = () => {
    const el = scroller.current!;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    if (atBottom.current) setUnseen(0);
    if (el.scrollTop < LOAD_MORE_PX && stream.status === "CanLoadMore") {
      heightBefore.current = el.scrollHeight;
      stream.loadMore();
    }
  };

  const toBottom = () => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
    setUnseen(0);
  };

  // The toast's click: bring that card into view and flash it.
  useEffect(() => {
    if (!reveal) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-id="${reveal}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.dataset.flash = "1";
    setTimeout(() => delete el.dataset.flash, 900);
    setReveal(null);
  }, [reveal, items, setReveal]);

  if (latestOnly) return <LatestLine item={items.at(-1)} />;

  const loading = stream.status === "LoadingFirstPage";
  const exhausted = stream.status === "Exhausted";
  return (
    <div className={s.wrap}>
      <div className={s.stream} ref={scroller} onScroll={onScroll} role="log" aria-live="polite">
        <div className={s.items}>
          {exhausted && <LineageCard />}
          {!loading && items.length === 0 && <EmptyRoom />}
          {stream.status === "LoadingMore" && <div className={s.more}><Dots /></div>}
          {items.map((m, i) => (
            <Fragment key={m.id}>{renderItem(m, items[i - 1], now, me.id, sharedNames)}</Fragment>
          ))}
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
}

const itemKey = (m: MessageView) => m.id;
const mine = (m: MessageView, meId: string) => m.author?.id === meId;

function renderItem(m: MessageView, p: MessageView | undefined, now: number, meId: string, sharedNames: Set<string>) {
  if (m.kind === "system") return <SystemNote m={m} />;
  if (m.build) return <BuildCard m={m} b={m.build} />;
  if (m.kind === "request") return <WaitingCard m={m} />;
  if (m.kind === "build") return null;
  const grouped =
    !!p && p.kind === "chat" && !p.build && p.author?.id === m.author?.id && m.created_at - p.created_at < GROUP_MS;
  return <ChatMessage m={m} grouped={grouped} now={now} mine={m.author?.id === meId} sharedName={!!m.author && sharedNames.has(m.author.name)} />;
}

function TypingRow() {
  const { here } = useAppState();
  const t = here.typers;
  if (t.length === 0) return null;
  const text =
    t.length === 1 ? `${t[0].name} is typing` : t.length === 2 ? `${t[0].name} and ${t[1].name} are typing` : `${t.length} people are typing`;
  return (
    <div className={s.typing}>
      <span className={s.typingFaces}>
        {t.slice(0, 3).map((p) => (
          <Face key={p.id} person={p} size={24} />
        ))}
      </span>
      {text}
      <Dots />
    </div>
  );
}

/** Until Clay has written ideas for this app. */
const STARTER_IDEAS = ["make it dark", "add a sound when someone clicks", "add a scoreboard"];

function EmptyRoom() {
  const { app, composer } = useAppState();
  const ideas = app.ideas.length ? app.ideas : STARTER_IDEAS;
  return (
    <div className={s.empty}>
      <Blob size={64} wobble />
      <p className={s.quiet}>It's quiet in here.</p>
      <p className={s.emptyHint}>Say what you'd change. Clay builds it and everyone sees it.</p>
      <div className={s.ideas}>
        {ideas.map((idea) => (
          <Chip
            key={idea}
            onClick={() => {
              composer.setMode("change");
              composer.setText(idea);
              composer.focus();
            }}
          >
            {idea}
          </Chip>
        ))}
      </div>
    </div>
  );
}

/** At the top of a fork's stream: where it came from (DESIGN 6.8). */
function LineageCard() {
  const { app } = useAppState();
  const from = app.forked_from;
  if (!from) return null;
  return (
    <a className={s.lineage} href={appUrl(from.slug)} onClick={(e) => {
      e.preventDefault();
      navigate(appUrl(from.slug));
    }}>
      <b>
        Forked from {from.name} v{from.version} <ArrowRightIcon />
      </b>
      <span>Same code, a copy of the data. Change anything.</span>
    </a>
  );
}

/** The sheet at its peek: one line for the latest thing that happened. */
function LatestLine({ item: m }: { item: MessageView | undefined }) {
  if (!m) return <p className={s.latest}>It's quiet in here.</p>;
  if (m.note?.type === "error") return <p className={s.latest}><Blob size={20} /> The app hit an error</p>;
  const b = m.build;
  const text = b
    ? b.status === "live" ? `v${b.result_version} is live` : b.status === "failed" ? "Didn't make it" : b.status === "building" ? "Clay is building" : `In line: ${m.body}`
    : m.body;
  return (
    <p className={s.latest}>
      {m.author ? <Face person={m.author} size={24} /> : <Blob size={20} />}
      <b>{m.author?.name ?? "Clay"}</b>
      <span>{text}</span>
    </p>
  );
}
