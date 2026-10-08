// A moment of a replay, written in a message as `rp-12@1:23` on a line of its
// own (or a stretch, `rp-12@1:00-2:30`, opening at its start): the recorded
// page playing in place, opened at that second, with the player's own bar.
// What an agent quotes after `cast replay snap`, and what the transcript shows
// where the agent read a frame (`Frame of the replay: rp-N@m:ss`, synced
// instead of the picture). It is the same isolated player the Ops page embeds
// (ReplayPlayerFrame): the customer's page never renders on this origin, and
// the capability it plays through is minted for this viewer, checked against
// the replay's workspace, when the embed comes near the screen.
//
// A thread of moments is not a wall of players. Each player loads the whole
// capture (megabytes of page) on a fresh replayer in its own process, so an
// embed opens once, as the reader first nears it, and then stays open:
// letting it go would mint a new capability and download the capture again
// on every scroll back. At most LIVE_PLAYERS_MAX open by themselves on one
// page; past that an embed waits behind a play button until it is clicked.
// A replay that kept no page
// capture still reads as the replay at a time, saying so, with the link to
// its events at that moment.
import { useRef, useState, useSyncExternalStore } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import Link from "next/link";
import { ArrowUpRight, Film, Play } from "lucide-react";
import { formatCallTime, parseReplayRef, replayRefStart } from "@codecast/shared/entities";
import { useNearViewport } from "../../hooks/useNearViewport";
import { ReplayPlayerIframe } from "./ReplayPlayerFrame";
import { useReplayPlayerChannel, useReplayPlayerLink } from "../../hooks/useReplayPlayer";
import { replayTitle } from "./opsModel";

/** The player's own bar under the page (infra/replay-player CONTROLS_H). */
const PLAYER_BAR_PX = 44;
/** Until the player says how big the recording is. */
const DEFAULT_SIZE = { width: 1600, height: 1000 };

/** Players a page opens by itself; the rest wait for a click. */
export const LIVE_PLAYERS_MAX = 3;

// The embeds holding a self-opened player, in the order they asked.
const live = new Set<symbol>();
const liveListeners = new Set<() => void>();
const liveChanged = () => liveListeners.forEach((l) => l());
const subscribeLive = (l: () => void) => (liveListeners.add(l), () => void liveListeners.delete(l));

/**
 * Whether this embed may open its player without a click: it asked (`want`)
 * while fewer than LIVE_PLAYERS_MAX held one. A slot, once held, is kept
 * until the embed unmounts.
 */
function useLivePlayerSlot(want: boolean): boolean {
  const [id] = useState(() => Symbol("replay-embed"));
  const [held, setHeld] = useState(false);
  const size = useSyncExternalStore(subscribeLive, () => live.size, () => live.size);
  useMountEffect(() => () => {
    if (live.delete(id)) liveChanged();
  });
  useWatchEffect(() => {
    // The set itself, not this render's snapshot: embeds mounted in one commit all run here before any re-renders.
    if (!want || held || live.size >= LIVE_PLAYERS_MAX) return;
    live.add(id);
    setHeld(true);
    liveChanged();
  }, [want, held, size, id]);
  return held;
}

export function ReplayMomentEmbed({
  rawId,
  entity,
  served,
  href,
}: {
  rawId: string;
  /** The replay (replays.webGetReplay, or the Ops row in the store). */
  entity: any;
  /** The server answered, so a missing entity means no access. */
  served: boolean;
  /** The Ops replay page at this moment. */
  href: string;
}) {
  const ref = parseReplayRef(rawId);
  const atMs = replayRefStart(ref) ?? 0;
  const time = formatCallTime(atMs);
  const title = replayTitle(entity) ?? ref?.replay ?? rawId;
  const boxRef = useRef<HTMLDivElement>(null);
  const near = useNearViewport(boxRef, "1200px");
  // A row that says it kept no capture is not asked for a player at all.
  const knownNoCapture = !!entity && entity.dom_chunks === 0;
  const playable = !!entity && !knownNoCapture;
  const slot = useLivePlayerSlot(near && playable);
  const [clicked, setClicked] = useState(false);
  const open = playable && (slot || clicked);
  const link = useReplayPlayerLink(entity?._id ?? null, open, { t_ms: atMs });
  const [size, setSize] = useState<{ width: number; height: number; below: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const channel = useReplayPlayerChannel(link.state === "ready" ? link.origin : null, (msg) => {
    if (msg.type === "ready") {
      setSize({ width: msg.width, height: msg.height, below: msg.below_px ?? PLAYER_BAR_PX });
      setError(null);
    } else if (msg.type === "error") setError(msg.message);
  });

  if (served && !entity) {
    return (
      <div className="my-1 w-fit max-w-full rounded-lg border border-sol-border/40 px-3 py-2 text-[11.5px] text-sol-text-dim">
        <span className="font-mono">{rawId}</span> · not available to you
      </div>
    );
  }

  const box = size ?? { ...DEFAULT_SIZE, below: PLAYER_BAR_PX };
  const noCapture = knownNoCapture || link.state === "no-capture";
  const problem = link.state === "failed" ? link.error : error;
  return (
    <div
      ref={boxRef}
      className="my-1 w-[min(100%,640px)] overflow-hidden rounded-lg bg-sol-bg-alt ring-1 ring-sol-border/40"
      data-replay-moment={rawId}
      // The player's height follows the recording's shape at the embed's own
      // width (container units), plus what it draws below the page.
      style={{ containerType: "inline-size" }}
    >
      {noCapture || problem ? (
        <div className="flex flex-col items-center justify-center gap-1.5 px-6 py-6 text-center">
          <Film className="h-4 w-4 text-sol-text-dim" />
          <span className="text-[11.5px] leading-snug text-sol-text-muted">
            {problem ?? `This replay kept no page capture. Its events at ${time} are on the replay page.`}
          </span>
        </div>
      ) : (
        <div
          className="relative bg-sol-bg"
          // The player scales a recording down to fit, never up: a page
          // narrower than the embed is drawn at its own width.
          style={{ height: `calc(min(100cqw, ${box.width}px) * ${box.height / box.width} + ${box.below}px)`, maxHeight: "70vh" }}
        >
          {link.state === "ready" && (
            <ReplayPlayerIframe
              frameRef={channel.frameRef}
              url={link.url}
              title={`${title} at ${time}`}
              className="transition-opacity duration-150 motion-reduce:transition-none"
              style={{ height: "100%", opacity: size ? 1 : 0 }}
            />
          )}
          {!size && near && playable && !open ? (
            <button
              type="button"
              onClick={() => setClicked(true)}
              className="absolute inset-0 flex items-center justify-center gap-2 text-[11.5px] text-sol-text-muted hover:text-sol-text"
            >
              <Play className="h-4 w-4" />
              Play the page at {time}
            </button>
          ) : !size ? (
            <div className="absolute inset-0 flex items-center justify-center text-[11.5px] text-sol-text-dim">
              {served || entity ? "Loading the page capture…" : "Opening the replay…"}
            </div>
          ) : null}
        </div>
      )}
      <Link href={href} className="group flex items-center gap-2 px-2.5 py-1.5 hover:bg-sol-bg-highlight/40" title={`Open ${title} at ${time}`}>
        <Film className="h-3.5 w-3.5 shrink-0 text-sol-magenta" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-sol-text">{title}</span>
        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-sol-text-dim">{time}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-sol-text-dim">{ref?.replay ?? rawId}</span>
        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-sol-text-dim transition-colors group-hover:text-sol-text" />
      </Link>
    </div>
  );
}
