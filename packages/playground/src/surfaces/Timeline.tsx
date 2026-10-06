// The timeline (DESIGN 6.6): every version a bead on a string. Hover or focus
// peeks at one; View shows it to you only; Restore and Fork from here act on
// it. ←/→ step, Enter views, Esc returns to live, Home/End jump.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { TimelineEntry } from "../../convex/versions";
import { ago, plural, since } from "../lib/format";
import { useDesktop } from "../lib/useMedia";
import { useNow } from "../lib/useNow";
import { Button, IconButton } from "../ui/Button";
import { Face } from "../ui/Face";
import { CloseIcon } from "../ui/icons";
import { Keys } from "../ui/Keys";
import { Popover } from "../ui/Popover";
import { Spinner } from "../ui/Spinner";
import { useAppState } from "./appState";
import s from "./Timeline.module.css";

const BEAD_FILLS = ["var(--butter)", "var(--bubble)", "var(--sky)", "var(--cream)"];
const PEEK_DELAY_MS = 120;
const PEEK_LINGER_MS = 220;

/** Desktop: the dock at the bottom of the app column. */
export function TimelineDock({ onClose }: { onClose?: () => void }) {
  const { timeline } = useAppState();
  const now = useNow(60_000);
  const first = timeline?.[0];
  return (
    <section className={s.dock} aria-label="Timeline">
      <div className={s.dockHead}>
        <b>{plural(timeline?.length ?? 0, "version")}</b>
        {first && <span>{since(first.created_at, now)}</span>}
      </div>
      <Beads />
      <span className={s.stepKeys}>
        <Keys keys={["←", "→"]}>to step</Keys>
      </span>
      {onClose && (
        <IconButton label="Close the timeline" size={32} onClick={onClose}>
          <CloseIcon />
        </IconButton>
      )}
    </section>
  );
}

/** Mobile: a bead strip inside the room sheet. */
export function TimelineStrip() {
  return (
    <section className={s.strip} aria-label="Timeline">
      <Beads />
    </section>
  );
}

function Beads() {
  const { timeline = [], app, viewing, view, building } = useAppState();
  const desktop = useDesktop();
  const [focus, setFocus] = useState<number | null>(null);
  const [peek, setPeek] = useState<{ n: number; anchor: HTMLElement } | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const beads = useRef(new Map<number, HTMLButtonElement>());
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const shown = viewing ?? app.live_version;
  const tabbable = focus ?? shown;

  // Keep the live bead (or the one you are viewing) in view.
  useLayoutEffect(() => {
    beads.current.get(shown)?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [shown, timeline.length]);

  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const showPeek = (n: number) => {
    const anchor = beads.current.get(n);
    if (anchor) setPeek({ n, anchor });
  };
  const hoverIn = (n: number) => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => showPeek(n), PEEK_DELAY_MS);
  };
  const hoverOut = () => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setPeek(null), PEEK_LINGER_MS);
  };

  const moveTo = (n: number) => {
    const clamped = Math.min(Math.max(n, timeline[0]?.number ?? 1), timeline.at(-1)?.number ?? 1);
    setFocus(clamped);
    beads.current.get(clamped)?.focus();
  };

  const onKey = (e: KeyboardEvent) => {
    const at = focus ?? shown;
    const step: Record<string, () => void> = {
      ArrowLeft: () => moveTo(at - 1),
      ArrowRight: () => moveTo(at + 1),
      Home: () => moveTo(timeline[0]?.number ?? 1),
      End: () => moveTo(app.live_version),
      Enter: () => view(at),
      Escape: () => {
        view(null);
        setPeek(null);
      },
    };
    const run = step[e.key];
    if (!run) return;
    e.preventDefault();
    e.stopPropagation();
    run();
  };

  return (
    <div className={s.beadsWrap}>
      <div className={s.beads} ref={strip} onKeyDown={onKey} onPointerLeave={hoverOut} role="listbox" aria-label="Versions" aria-orientation="horizontal">
        <div className={s.string}>
          {timeline.map((v) => {
            const live = v.number === app.live_version;
            const isViewing = v.number === viewing;
            return (
              <span key={v.number} className={s.slot}>
                <button
                  ref={(el) => {
                    if (el) beads.current.set(v.number, el);
                    else beads.current.delete(v.number);
                  }}
                  role="option"
                  aria-selected={v.number === shown}
                  aria-label={`v${v.number}: ${v.summary}`}
                  tabIndex={v.number === tabbable ? 0 : -1}
                  className={`${s.bead} ${live ? s.live : ""} ${isViewing ? s.viewing : ""} ${v.kind === "restore" ? s.restore : ""} ${peek?.n === v.number ? s.peeked : ""}`}
                  style={{ ["--fill" as string]: BEAD_FILLS[v.number % BEAD_FILLS.length] }}
                  onPointerEnter={desktop ? () => hoverIn(v.number) : undefined}
                  onFocus={() => {
                    setFocus(v.number);
                    showPeek(v.number);
                  }}
                  onClick={() => (desktop ? view(v.number) : peek?.n === v.number ? setPeek(null) : showPeek(v.number))}
                >
                  {live && <span className={s.num}>{v.number}</span>}
                  {v.author && <span className={s.askerFace}><Face person={v.author} size={18} /></span>}
                </button>
              </span>
            );
          })}
          {building && (
            <span className={s.slot}>
              <span className={s.buildingBead} aria-label="Building the next version"><Spinner size={14} /></span>
            </span>
          )}
        </div>
      </div>
      {peek && (
        <Popover anchor={peek.anchor} place="above" align="center" width={280} onClose={() => setPeek(null)}>
          <div onPointerEnter={() => clearTimeout(hoverTimer.current)} onPointerLeave={hoverOut}>
            <Peek entry={timeline.find((v) => v.number === peek.n)!} onDone={() => setPeek(null)} />
          </div>
        </Popover>
      )}
    </div>
  );
}

function Peek({ entry, onDone }: { entry: TimelineEntry; onDone: () => void }) {
  const { app, view, restore, startFork, stream } = useAppState();
  const now = useNow(60_000);
  const [restoring, setRestoring] = useState(false);
  if (!entry) return null;
  const live = entry.number === app.live_version;
  const request = entry.request_message_id ? stream.messages.find((m) => m.id === entry.request_message_id)?.body : null;
  return (
    <div className={s.peek}>
      <div className={s.peekHead}>
        <b>v{entry.number}</b>
        {entry.author && <Face person={entry.author} size={24} />}
        <small>{entry.author ? `${entry.author.name} · ` : ""}{ago(entry.created_at, now)}</small>
      </div>
      <p className={s.summary}>{entry.summary}</p>
      {request && <q className={s.request}>{request}</q>}
      <div className={s.peekActions}>
        {live ? (
          <span className={s.isLive}>This is live</span>
        ) : (
          <>
            <Button size="sm" onClick={() => {
              view(entry.number);
              onDone();
            }}>View</Button>
            <Button size="sm" variant="live" busy={restoring} onClick={async () => {
              setRestoring(true);
              await restore(entry.number);
              setRestoring(false);
              onDone();
            }}>Restore</Button>
          </>
        )}
        <Button size="sm" variant="fork" onClick={() => {
          startFork(entry.number);
          onDone();
        }}>Fork from here</Button>
      </div>
    </div>
  );
}
