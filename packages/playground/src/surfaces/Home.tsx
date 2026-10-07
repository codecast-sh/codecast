// Home (DESIGN 6.1): make something first, then see what people are doing
// right now and wander into it.
import { useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { ActivityEvent } from "../../convex/activity";
import type { GalleryCard } from "../../convex/apps";
import { errorData } from "../lib/errors";
import { ago, plural } from "../lib/format";
import { useIdentity, useVisitorMutation, useVisitorQuery } from "../lib/identity";
import { MAKE_PARAM, appUrl, navigate, roomUrl } from "../lib/router";
import { useMedia } from "../lib/useMedia";
import { useNow } from "../lib/useNow";
import { Blob } from "../ui/Blob";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chips";
import { Face } from "../ui/Face";
import { FaceStack } from "../ui/FaceStack";
import { Keys } from "../ui/Keys";
import { Link } from "../ui/Link";
import { LiveDot } from "../ui/LiveDot";
import { useToast } from "../ui/Toast";
import { useCharacterPicker } from "./CharacterPicker";
import { Thumbnail } from "./Thumbnail";
import { useOpenGraph } from "./openGraph";
import s from "./Home.module.css";

const EXAMPLES = [
  "a guestbook where every visitor plants a tiny planet",
  "a frog choir, one note per person",
  "a wall of haiku anyone can add a line to",
  "a paper plane contest, longest throw today wins",
  "a snack vote for the office, with a live bar chart",
];

/** Ideas to start from. One whose kind of app the gallery already shows is
 *  left out, so a newcomer joins that one rather than make a copy. */
const STARTERS = [
  { label: "Frog choir", like: /frog|choir/i, prompt: "a frog choir: each person who visits gets a frog that sings one note when tapped" },
  { label: "Snack vote", like: /vote|poll|snack/i, prompt: "a snack vote with big buttons and a live bar chart of the results" },
  { label: "Paper plane contest", like: /plane/i, prompt: "a paper plane contest: everyone throws a plane with one swipe, and the longest flight today wins" },
  { label: "Haiku wall", like: /haiku|poem/i, prompt: "a wall where each visitor adds one line, and every three lines become a haiku card" },
  { label: "Tiny planets guestbook", like: /guestbook|planet/i, prompt: "a guestbook where every visitor plants a tiny planet that orbits a sun" },
  { label: "Lunch spinner", like: /lunch|spinner|wheel/i, prompt: "a lunch spinner: everyone adds a place, and one big spin picks today's lunch for the group" },
  { label: "Word chain", like: /word|chain/i, prompt: "a word chain: each person adds a word that starts with the last letter of the word before, and the chain grows across the screen" },
  { label: "Desert island picks", like: /island|desert/i, prompt: "desert island picks: everyone names the three things they would bring, and the most picked things rise to the top" },
  { label: "Cloud spotting", like: /cloud|sky/i, prompt: "a slow sky where each visitor names a cloud shape they see, and the clouds drift by carrying their names" },
  { label: "Pixel wall", like: /pixel/i, prompt: "a 24 by 24 pixel canvas everyone paints together, one color each" },
];
const STARTERS_SHOWN = 4;

/** A version this fresh reads as "live now" in the feed. */
const JUST_LIVE_MS = 5 * 60_000;

export function Home() {
  useOpenGraph(null);
  const gallery = useVisitorQuery(api.apps.gallery, { limit: 24 });
  const maker = useRef<MakerHandle>(null);

  // "Make your own" from an app's room lands here with the maker ready.
  useEffect(() => {
    if (!new URLSearchParams(location.search).has(MAKE_PARAM)) return;
    maker.current?.focus();
    navigate("/", { replace: true });
  }, []);

  const names = gallery?.apps.map((a) => a.name).join("\n") ?? "";
  const starters = STARTERS.filter((st) => !st.like.test(names)).slice(0, STARTERS_SHOWN);
  const busy = (gallery?.apps[0]?.here_count ?? 0) > 0;

  return (
    <div className={s.page}>
      <div className={s.column}>
        <TopBar />
        <section className={s.hero}>
          <div className={s.make}>
            <h1 className={s.headline}>Make a thing. Pass it around.</h1>
            <p className={s.lede}>
              Describe an app and Clay builds it in seconds. Anyone with the link can change it by chatting, and everyone sees it change.
            </p>
            <MakerBar handle={maker} autoFocus />
            <div className={s.starters}>
              <span>Or start with</span>
              <div className={s.starterChips}>
                {starters.map((st) => (
                  <Chip key={st.label} onClick={() => maker.current?.make(st.prompt)}>
                    {st.label}
                  </Chip>
                ))}
              </div>
            </div>
          </div>
          <RightNow />
        </section>
        <section className={s.gallery}>
          <div className={s.galleryHead}>
            <h2>{gallery && !busy ? "Made recently" : "Busy right now"}</h2>
            {gallery && gallery.here_total > 0 && (
              <p>
                <LiveDot />
                {plural(gallery.here_total, "person", "people")} building in {plural(gallery.active_apps, "app")}
              </p>
            )}
          </div>
          {gallery && gallery.apps.length === 0 ? (
            <button className={s.emptyTile} onClick={() => maker.current?.focus()}>
              Nothing's busy yet. Make the first thing.
            </button>
          ) : (
            <div className={`${s.grid} ${busy ? s.withBig : ""}`}>
              {(gallery?.apps ?? []).map((card, i) => (
                <AppTile key={card.id} card={card} big={busy && i === 0} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function TopBar() {
  const { me } = useIdentity();
  const openPicker = useCharacterPicker();
  return (
    <header className={s.top}>
      <a className={s.wordmark} href="/" onClick={(e) => e.preventDefault()}>
        <Blob size={22} />
        Clayground
      </a>
      <button className={s.you} onClick={() => openPicker()} aria-label="Change your character">
        <Face person={me} size={28} />
        <span className={s.youName}>{me.name}</span>
        <span className={s.youSub}>that's you</span>
      </button>
    </header>
  );
}

/** The latest things people did anywhere in Clayground; new ones slide in on top. */
function RightNow() {
  const events = useVisitorQuery(api.activity.recent, {});
  const now = useNow(30_000);
  const seen = useRef<Set<string> | null>(null);
  if (events && !seen.current) seen.current = new Set(events.map((e) => e.id));
  useEffect(() => events?.forEach((e) => seen.current?.add(e.id)), [events]);
  if (events?.length === 0) return null;
  return (
    <section className={s.feed} aria-label="Right now">
      <h2 className={s.feedHead}>
        Right now <LiveDot />
      </h2>
      <ol className={s.feedRows}>
        {(events ?? []).map((e) => (
          <FeedRow key={e.id} e={e} now={now} fresh={!seen.current?.has(e.id)} />
        ))}
      </ol>
    </section>
  );
}

/** "Tango turns the scoreboard gold" over "Tiny platformer · 2m". */
function FeedRow({ e, now, fresh }: { e: ActivityEvent; now: number; fresh: boolean }) {
  const justLive = e.live && now - e.at < JUST_LIVE_MS;
  return (
    <li className={fresh ? s.fresh : ""}>
      <Link to={appUrl(e.slug)} title={`${e.who?.name ?? "Clay"} ${e.said}`}>
        {e.who ? <Face person={e.who} size={24} decorative /> : <Blob size={24} />}
        <span className={s.feedText}>
          <span className={s.feedSaid}>
            <b>{e.who?.name ?? "Clay"}</b> {e.said}
          </span>
          <span className={s.feedMeta}>
            <span className={s.feedApp}>{e.app_name}</span>
            {" · "}
            {justLive ? <span className={s.feedLive}>live now</span> : <time>{ago(e.at, now)}</time>}
          </span>
        </span>
      </Link>
    </li>
  );
}

type MakerHandle = { make: (prompt: string) => void; focus: () => void };

/** The "Make something" bar. Exported for the 404 page. `autoFocus`: ready
 *  to type into on arrival where there is a keyboard and a pointer; a
 *  phone's keyboard would cover the page, so there it waits for a tap. */
export function MakerBar({ handle, autoFocus = false }: { handle?: React.RefObject<MakerHandle | null>; autoFocus?: boolean }) {
  const create = useVisitorMutation(api.apps.create);
  const toast = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // Examples rotate until the person reaches for the field themselves.
  const [reached, setReached] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const example = useRotatingExample(text === "" && !reached);
  const typeFirst = useMedia("(hover: hover) and (pointer: fine)");

  useEffect(() => {
    if (autoFocus && typeFirst) input.current?.focus({ preventScroll: true });
  }, [autoFocus, typeFirst]);

  const make = async (prompt: string) => {
    const p = prompt.trim();
    if (!p || busy) return;
    setText(p);
    setBusy(true);
    try {
      const { slug } = await create({ prompt: p });
      navigate(roomUrl(slug));
    } catch (err) {
      setBusy(false);
      toast({ text: errorData(err).message });
    }
  };

  if (handle) handle.current = { make, focus: () => input.current?.focus() };

  return (
    <form className={s.maker} onSubmit={(e) => {
      e.preventDefault();
      // An empty field showing an example makes that example.
      void make(text || (EXAMPLES.includes(example) ? example : ""));
    }}>
      <label className={s.makerField}>
        <span className="sr-only">Make something</span>
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPointerDown={() => setReached(true)}
          onKeyDown={() => setReached(true)}
          maxLength={2000}
          autoComplete="off"
          disabled={busy}
        />
        {text === "" && (
          <span className={s.placeholder} key={example} aria-hidden>
            {example}
          </span>
        )}
      </label>
      <Button type="submit" variant="accent" size="lg" busy={busy} className={`${s.makeIt} on-dark`}>
        Make it
        <span className={s.makeKey}><Keys keys={["↵"]} hidden /></span>
      </Button>
    </form>
  );
}

const FIRST_EXAMPLE_MS = 1_200;
const EXAMPLE_MS = 3_200;

/** "Make something", then after a moment idle, a whole example at a time. */
function useRotatingExample(active: boolean): string {
  const [i, setI] = useState(-1);
  useEffect(() => {
    if (!active) return setI(-1);
    let timer = setTimeout(function next() {
      setI((n) => n + 1);
      timer = setTimeout(next, EXAMPLE_MS);
    }, FIRST_EXAMPLE_MS);
    return () => clearTimeout(timer);
  }, [active]);
  return i < 0 ? "Make something" : EXAMPLES[i % EXAMPLES.length];
}

function AppTile({ card, big }: { card: GalleryCard; big: boolean }) {
  const now = useNow(60_000);
  const [hovered, setHovered] = useState(false);
  const latest = card.latest;
  return (
    <Link
      className={`${s.tile} ${big ? s.big : ""}`}
      to={appUrl(card.slug)}
      onPointerEnter={(e) => e.pointerType === "mouse" && setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      <div className={s.thumb}>
        <Thumbnail appId={card.id} slug={card.slug} name={card.name} version={card.live_version} still={card.still_url} busy={card.here_count > 0} hovered={hovered} />
        {card.here_count > 0 && (
          <span className={s.hereBadge}>
            <LiveDot />
            <FaceStack people={card.here} max={3} size={20} />
            {card.here_count} here
          </span>
        )}
      </div>
      <div className={s.tileFoot}>
        <h3>{card.name}</h3>
        {latest && (
          <p title={`${latest.by?.name ?? "Clay"} ${latest.said}`}>
            {latest.by && <Face person={latest.by} size={16} decorative />}
            <span className={s.tileSaid}>
              <b>{latest.by?.name ?? "Clay"}</b> {latest.said}
            </span>
            <time>{ago(latest.at, now)}</time>
          </p>
        )}
      </div>
    </Link>
  );
}
