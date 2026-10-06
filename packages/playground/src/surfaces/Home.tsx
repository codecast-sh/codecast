// Home (DESIGN 6.1): make something, or wander into what is busy now.
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { GalleryCard } from "../../convex/apps";
import { errorData } from "../lib/errors";
import { plural } from "../lib/format";
import { useIdentity, useVisitorMutation, useVisitorQuery } from "../lib/identity";
import { appUrl, navigate, roomUrl } from "../lib/router";
import { Blob } from "../ui/Blob";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chips";
import { Face, type Person } from "../ui/Face";
import { FaceStack } from "../ui/FaceStack";
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
  "a pixel canvas where each person gets one color",
  "a snack vote for the office, with a live bar chart",
];

const STARTERS = [
  { label: "Tiny planets guestbook", prompt: "a guestbook where every visitor plants a tiny planet that orbits a sun", dot: "var(--pool)" },
  { label: "Frog choir", prompt: "a frog choir: each person who visits gets a frog that sings one note when tapped", dot: "var(--mint)" },
  { label: "Snack vote", prompt: "a snack vote with big buttons and a live bar chart of the results", dot: "var(--bubble)" },
  { label: "Pixel wall", prompt: "a 24 by 24 pixel canvas everyone paints together, one color each", dot: "var(--butter)" },
];

export function Home() {
  useOpenGraph(null);
  const gallery = useVisitorQuery(api.apps.gallery, { limit: 24 });
  const maker = useRef<MakerHandle>(null);

  return (
    <div className={s.page}>
      <div className={s.fields} aria-hidden />
      <div className={s.column}>
        <TopBar />
        <section className={s.hero}>
          <h1 className={s.headline}>
            Make a thing.
            <br />
            Pass it around.
          </h1>
          <Crowd cards={gallery?.apps} />
        </section>
        <MakerBar handle={maker} />
        <div className={s.starters}>
          <span>Or start with</span>
          <div className={s.starterChips}>
            {STARTERS.map((st) => (
              <Chip key={st.label} dot={st.dot} onClick={() => maker.current?.make(st.prompt)}>
                {st.label}
              </Chip>
            ))}
          </div>
        </div>
        <section className={s.gallery}>
          <div className={s.galleryHead}>
            <h2>Busy right now</h2>
            {gallery && gallery.here_total > 0 && (
              <p>
                <LiveDot />
                {plural(gallery.here_total, "person", "people")} building in {plural(gallery.active_apps, "app")}
              </p>
            )}
          </div>
          {gallery && gallery.apps.length === 0 ? (
            <button className={s.emptyCard} onClick={() => maker.current?.focus()}>
              <Blob size={56} />
              Nothing's busy yet. Make the first thing.
            </button>
          ) : (
            <div className={s.grid}>
              {(gallery?.apps ?? []).map((card, i) => (
                <AppCard key={card.id} card={card} big={i === 0} />
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
        <Blob size={46} wobble />
        Clayground
      </a>
      <YouChip me={me} onClick={() => openPicker()} />
    </header>
  );
}

export function YouChip({ me, onClick }: { me: Person; onClick: () => void }) {
  return (
    <button className={s.you} onClick={onClick} aria-label="Change your character">
      <Face person={me} size={36} />
      <span className={s.youName}>{me.name}</span>
      <span className={s.youSub}>that's you</span>
    </button>
  );
}

/** Three animals active across Clayground right now, or the house band. */
function Crowd({ cards }: { cards: GalleryCard[] | undefined }) {
  const { me } = useIdentity();
  const faces = useMemo(() => {
    const seen = new Map<string, Person>();
    for (const c of cards ?? []) for (const p of c.here) if (!seen.has(p.avatar)) seen.set(p.avatar, p);
    const band: Person[] = [me, { id: "frog", avatar: "frog", name: "Puddle" }, { id: "toucan", avatar: "toucan", name: "Mango" }, { id: "otter", avatar: "otter", name: "Pebble" }];
    for (const p of band) if (seen.size < 3 && !seen.has(p.avatar)) seen.set(p.avatar, p);
    return [...seen.values()].slice(0, 3);
  }, [cards, me]);
  return (
    <div className={s.crowd} aria-hidden>
      {faces.map((p, i) => (
        <span key={p.id} className={s.crowdFace} style={{ ["--i" as string]: i }}>
          <Face person={p} size={92} />
        </span>
      ))}
      <span className={s.say}>anyone can change it</span>
    </div>
  );
}

type MakerHandle = { make: (prompt: string) => void; focus: () => void };

/** The big "Make something" input. Exported for the 404 page. */
export function MakerBar({ handle }: { handle?: React.RefObject<MakerHandle | null> }) {
  const create = useVisitorMutation(api.apps.create);
  const toast = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const placeholder = useTypedExample(text === "");

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
      void make(text);
    }}>
      <label className={s.makerField}>
        <span className="sr-only">Make something</span>
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          maxLength={2000}
          autoComplete="off"
          disabled={busy}
        />
      </label>
      <Button type="submit" variant="make" size="lg" busy={busy} className={s.makeIt}>
        Make it
      </Button>
    </form>
  );
}

/** "Make something", then after 1.2s idle, examples typed in one by one. */
function useTypedExample(active: boolean): string {
  const [shown, setShown] = useState("Make something");
  useEffect(() => {
    if (!active) return;
    let i = 0;
    let chars = 0;
    let timer: ReturnType<typeof setTimeout>;
    const type = () => {
      const ex = EXAMPLES[i % EXAMPLES.length];
      chars++;
      setShown(ex.slice(0, chars));
      if (chars < ex.length) timer = setTimeout(type, 38);
      else timer = setTimeout(() => {
        i++;
        chars = 0;
        type();
      }, 2600);
    };
    timer = setTimeout(type, 1200);
    return () => {
      clearTimeout(timer);
      setShown("Make something");
    };
  }, [active]);
  return shown;
}

function AppCard({ card, big }: { card: GalleryCard; big: boolean }) {
  return (
    <a className={`${s.card} ${big ? s.big : ""}`} href={appUrl(card.slug)} onClick={(e) => {
      if (e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      navigate(appUrl(card.slug));
    }}>
      <div className={s.thumb}>
        <Thumbnail slug={card.slug} version={card.live_version} />
        {card.here_count > 0 && (
          <span className={s.hereBadge}>
            <LiveDot />
            {card.here_count} here
          </span>
        )}
      </div>
      <div className={s.cardFoot}>
        <div className={s.cardMeta}>
          <h3>{card.name}</h3>
          <p>{card.live_version > 1 ? `${plural(card.contributor_count, "person", "people")} changed it · v${card.live_version}` : "Fresh clay · v1"}</p>
          {card.forked_from && <p className={s.forked}>forked from {card.forked_from.name}</p>}
        </div>
        <FaceStack people={card.here} max={3} size={30} />
      </div>
    </a>
  );
}
