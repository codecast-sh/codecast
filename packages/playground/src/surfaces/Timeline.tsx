// The timeline (DESIGN 6.6): one mark per version on a hairline. With room
// (30px or more a version) each mark is the asker's face; below that, a small
// dot whose face shows on hover. Moving along it is time travel: ←/→, a
// click, or a press dragged along the rail shows that version at once, to
// you only, and the past bar says what you are looking at. Hover peeks at a
// version before you go there, with Make live and Fork from here. Esc
// returns to live, Home/End jump.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { TimelineEntry } from "../../convex/versions";
import { ago, plural, since } from "../lib/format";
import { appUrl } from "../lib/router";
import { useDesktop } from "../lib/useMedia";
import { useNow } from "../lib/useNow";
import { Button, IconButton } from "../ui/Button";
import { useIdentity } from "../lib/identity";
import { Face, type Person } from "../ui/Face";
import { FaceStack } from "../ui/FaceStack";
import { CloseIcon, ForkIcon, RestoreIcon } from "../ui/icons";
import { Keys } from "../ui/Keys";
import { Link } from "../ui/Link";
import { makeLiveSays, versionSummary } from "../lib/versionCopy";
import { Popover } from "../ui/Popover";
import { useAppState, useHereState, useStream } from "./appState";
import { ForkedInto } from "./ForkModal";
import s from "./Timeline.module.css";

const PEEK_DELAY_MS = 120;
const PEEK_LINGER_MS = 220;
/** Below this many pixels a version, marks are dots and faces show on hover. */
const FACE_MIN_PX = 30;
/** A live label this wide needs its left neighbor's label out of the way. */
const ROOMY_PX = 52;
/** A press that moves this far along the rail is a drag through time. */
const DRAG_PX = 4;

/** Desktop: the dock at the bottom of the app column. */
export function TimelineDock({ onClose }: { onClose?: () => void }) {
  const { timeline, viewing } = useAppState();
  const now = useNow(60_000);
  const first = timeline?.[0];
  return (
    <section className={s.dock} aria-label="Timeline">
      <div className={s.label}>
        <b>{timeline?.length === 0 ? "No versions yet" : plural(timeline?.length ?? 0, "version")}</b>
        {first && <span>{since(first.created_at, now)}</span>}
      </div>
      <Track />
      {/* Both hints always hold their place, so viewing never moves the rail. */}
      <span className={s.keys}>
        <Keys keys={["←", "→"]}>to step</Keys>
        <span className={viewing === null ? s.unseen : ""} aria-hidden={viewing === null}>
          <Keys keys={["esc"]}>back to live</Keys>
        </span>
      </span>
      {onClose && (
        <IconButton label="Close the timeline" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      )}
    </section>
  );
}

/** Mobile: a strip of faces inside the room sheet. */
export function TimelineStrip() {
  return (
    <section className={s.strip} aria-label="Timeline">
      <Track faces />
    </section>
  );
}

/** How many pixels each version gets on the track. */
function useSlotWidth(count: number) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return { box, slot: count > 0 ? width / count : width };
}

function Track({ faces: alwaysFaces = false }: { faces?: boolean }) {
  const { app, timeline: all = [], viewing, view, warm, landed, cheer, versionByNumber } = useAppState();
  const { building } = useStream();
  const watching = useWatching();
  // A version still on its way to your screen stays the building mark.
  const timeline = all.filter((v) => v.number <= landed);
  const desktop = useDesktop();
  const [focus, setFocus] = useState<number | null>(null);
  const [peek, setPeek] = useState<{ n: number; anchor: HTMLElement } | null>(null);
  const marks = useRef(new Map<number, HTMLButtonElement>());
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { box, slot } = useSlotWidth(timeline.length + (building ? 1 : 0));
  const faces = alwaysFaces || slot >= FACE_MIN_PX;
  const roomy = slot >= ROOMY_PX;
  const first = timeline[0]?.number ?? 1;
  const forkedFrom = app.forked_from && timeline[0]?.kind === "fork" ? app.forked_from : null;

  const shown = viewing ?? landed;
  const tabbable = focus ?? shown;

  // Keep the live mark (or the one you are viewing) in view.
  useLayoutEffect(() => {
    marks.current.get(shown)?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [shown, timeline.length]);

  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const showPeek = (n: number) => {
    const anchor = marks.current.get(n);
    if (anchor) setPeek({ n, anchor });
    warm(n);
  };
  const hoverIn = (n: number) => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => showPeek(n), PEEK_DELAY_MS);
  };
  const hoverOut = () => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setPeek(null), PEEK_LINGER_MS);
  };

  // Going to a version shows it: the peek steps aside for the past bar,
  // which says what you are looking at, and reopens only on the next hover.
  const quietFocus = useRef(false);
  const go = (n: number, focusMark = false) => {
    const to = Math.min(Math.max(n, first), landed);
    clearTimeout(hoverTimer.current);
    setPeek(null);
    setFocus(to);
    if (to !== shown) view(to === landed ? null : to);
    if (focusMark) {
      quietFocus.current = true;
      marks.current.get(to)?.focus();
      quietFocus.current = false;
    }
  };

  const onKey = (e: KeyboardEvent) => {
    const step: Record<string, () => void> = {
      ArrowLeft: () => go(shown - 1, true),
      ArrowRight: () => go(shown + 1, true),
      Home: () => go(first, true),
      End: () => go(landed, true),
      Escape: () => go(landed, true),
    };
    const run = step[e.key];
    if (!run) return;
    e.preventDefault();
    e.stopPropagation();
    run();
  };

  // A press dragged along the rail moves through time under the pointer.
  const drag = useRef<{ x: number; moved: boolean } | null>(null);
  const nearest = (x: number) => {
    let best: number | null = null;
    let gap = Infinity;
    for (const [n, el] of marks.current) {
      const r = el.getBoundingClientRect();
      const d = Math.abs(r.left + r.width / 2 - x);
      if (d < gap) [best, gap] = [n, d];
    }
    return best;
  };
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || e.pointerType !== "mouse") return;
    drag.current = { x: e.clientX, moved: false };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.x) < DRAG_PX) return;
      d.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    const n = nearest(e.clientX);
    if (n !== null) go(n);
  };
  const onPointerUp = () => {
    // The click that ends a drag is not a click on a mark.
    if (drag.current?.moved) setTimeout(() => (drag.current = null));
    else drag.current = null;
  };

  return (
    <div className={s.trackWrap}>
      <div
        ref={box}
        className={`${s.track} ${faces ? s.faces : s.dots}`}
        onKeyDown={onKey}
        onPointerLeave={hoverOut}
        onPointerDown={desktop ? onPointerDown : undefined}
        onPointerMove={desktop ? onPointerMove : undefined}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="listbox"
        aria-label="Versions"
        aria-orientation="horizontal"
        aria-keyshortcuts="ArrowLeft ArrowRight Home End Escape"
      >
        <div className={s.rail}>
          {forkedFrom && (
            <span className={s.stub}>
              <Link to={appUrl(forkedFrom.slug)} title={`Forked from ${forkedFrom.name} v${forkedFrom.version}`}>
                <ForkIcon />from {forkedFrom.name} v{forkedFrom.version}
              </Link>
            </span>
          )}
          {timeline.map((v) => {
            const live = v.number === landed;
            const isViewing = v.number === viewing;
            const crowdsLive = !roomy && v.number === landed - 1;
            const label = live ? `v${v.number} live` : isViewing ? `v${v.number}` : faces && !crowdsLive ? String(v.number) : null;
            const state = isViewing ? s.viewing : live ? s.live : "";
            return (
              <span key={v.number} className={s.slot}>
                <button
                  ref={(el) => {
                    if (el) marks.current.set(v.number, el);
                    else marks.current.delete(v.number);
                  }}
                  role="option"
                  aria-selected={v.number === shown}
                  aria-label={`v${v.number}${live ? ", live" : ""}: ${versionSummary(v, versionByNumber)}${v.forks.length ? `, forked ${plural(v.forks.length, "time")}` : ""}`}
                  tabIndex={v.number === tabbable ? 0 : -1}
                  className={`${s.mark} ${state} ${live && cheer === v.number ? s.cheer : ""} ${peek?.n === v.number ? s.peeked : ""}`}
                  onPointerEnter={desktop ? () => hoverIn(v.number) : undefined}
                  onFocus={(e) => {
                    setFocus(v.number);
                    // Tabbing in peeks; a click or a step shows the version instead.
                    // Focus handed back from the peek (Esc, or a choice in it) has no
                    // relatedTarget: it stays closed, so Tab can leave the track.
                    if (!quietFocus.current && e.relatedTarget && e.currentTarget.matches(":focus-visible")) showPeek(v.number);
                  }}
                  onClick={() => {
                    if (drag.current?.moved) return;
                    if (desktop) go(v.number);
                    else if (peek?.n === v.number) setPeek(null);
                    else showPeek(v.number);
                  }}
                >
                  {!v.author ? (
                    <i className={`${s.tick} ${v.kind === "restore" ? s.restore : ""}`} />
                  ) : faces ? (
                    <span className={s.face}>
                      <Face person={v.author} size={20} />
                      {v.kind === "restore" && <span className={s.restoreBadge}><RestoreIcon /></span>}
                    </span>
                  ) : (
                    <>
                      <i className={`${s.tick} ${v.kind === "restore" ? s.restore : ""}`} />
                      <span className={s.hoverFace}><Face person={v.author} size={20} /></span>
                    </>
                  )}
                  {v.forks.length > 0 && <i className={s.forked} />}
                </button>
                {label && <span className={`${s.num} ${state}`}>{label}</span>}
                {watching.has(v.number) && (
                  <span className={s.watchers} title={`${watching.get(v.number)!.map((p) => p.name).join(", ")} ${watching.get(v.number)!.length === 1 ? "is" : "are"} viewing v${v.number}`}>
                    <FaceStack people={watching.get(v.number)!} max={3} size={16} />
                  </span>
                )}
              </span>
            );
          })}
          {building && (
            <span className={s.slot}>
              <span className={s.building} aria-label="Building the next version" />
            </span>
          )}
        </div>
      </div>
      {peek && (
        <Popover anchor={peek.anchor} place="above" align="center" width={320} className={s.peekBox} onClose={() => setPeek(null)} label={`v${peek.n}`} takeFocus={false}>
          <div onPointerEnter={() => clearTimeout(hoverTimer.current)} onPointerLeave={hoverOut}>
            <Peek entry={timeline.find((v) => v.number === peek.n)!} onDone={() => setPeek(null)} />
          </div>
        </Popover>
      )}
    </div>
  );
}

/** Everyone else looking at a past version, by the version: where your
 *  friends are, without asking. */
function useWatching() {
  const here = useHereState();
  const { me } = useIdentity();
  return useMemo(() => {
    const by = new Map<number, Person[]>();
    for (const e of here.entries) {
      if (e.viewing_version == null || e.visitor.id === me.id) continue;
      by.set(e.viewing_version, [...(by.get(e.viewing_version) ?? []), e.visitor]);
    }
    return by;
  }, [here.entries, me.id]);
}

function Peek({ entry, onDone }: { entry: TimelineEntry; onDone: () => void }) {
  const { app, viewing, view, restore, startFork, versionByNumber } = useAppState();
  const stream = useStream();
  const now = useNow(60_000);
  const [restoring, setRestoring] = useState(false);
  if (!entry) return null;
  const live = entry.number === app.live_version;
  const request = entry.request_message_id ? stream.messages.find((m) => m.id === entry.request_message_id)?.body : null;
  return (
    <div className={s.peek}>
      <div className={s.peekHead}>
        <b>v{entry.number}</b>
        {entry.author && <Face person={entry.author} size={20} />}
        <small>{entry.author ? `${entry.author.name} · ` : ""}{ago(entry.created_at, now)}</small>
      </div>
      <p className={s.summary}>{versionSummary(entry, versionByNumber)}</p>
      {request && <q className={s.request}>{request}</q>}
      {entry.kind === "fork" && app.forked_from && (
        <p className={s.origin}>
          <ForkIcon />
          <span>Forked from <Link to={appUrl(app.forked_from.slug)}>{app.forked_from.name} v{app.forked_from.version}</Link></span>
        </p>
      )}
      {entry.forks.length > 0 && <p className={s.origin}><ForkIcon /><ForkedInto forks={entry.forks} /></p>}
      {!live && <p className={s.takes}>{makeLiveSays(entry.number, app.live_version, versionByNumber)}</p>}
      <div className={s.peekActions}>
        {live ? (
          <span className={s.isLive}>This is live</span>
        ) : (
          <>
            {entry.number !== viewing && (
              <Button variant="ink" onClick={() => {
                view(entry.number);
                onDone();
              }}>View</Button>
            )}
            <Button busy={restoring} onClick={async () => {
              setRestoring(true);
              await restore(entry.number, app.live_version);
              setRestoring(false);
              onDone();
            }}>Make v{entry.number} live</Button>
          </>
        )}
        <Button onClick={() => {
          startFork(entry.number);
          onDone();
        }}><ForkIcon />Fork from here</Button>
      </div>
    </div>
  );
}
