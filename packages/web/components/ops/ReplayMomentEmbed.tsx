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
// A thread of moments is not a wall of players: one is opened as the reader
// nears it and let go once they are far past (the capture is megabytes of
// page), the way a call moment holds its video. A replay that kept no page
// capture still reads as the replay at a time, saying so, with the link to
// its events at that moment.
import { useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Film } from "lucide-react";
import { formatCallTime, parseReplayRef, replayRefStart } from "@codecast/shared/entities";
import { useNearViewport } from "../../hooks/useNearViewport";
import { ReplayPlayerIframe, useReplayPlayerChannel, useReplayPlayerLink } from "./ReplayPlayerFrame";
import { replayTitle } from "./opsModel";

/** The player's own bar under the page (infra/replay-player CONTROLS_H). */
const PLAYER_BAR_PX = 44;
/** Until the player says how big the recording is. */
const DEFAULT_SIZE = { width: 16, height: 10 };

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
  const close = useNearViewport(boxRef, "1200px", { latch: false });
  // A row that says it kept no capture is not asked for a player at all.
  const knownNoCapture = !!entity && entity.dom_chunks === 0;
  const link = useReplayPlayerLink(entity?._id ?? null, close && !!entity && !knownNoCapture, { t_ms: atMs });
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const channel = useReplayPlayerChannel(link.state === "ready" ? link.origin : null, (msg) => {
    if (msg.type === "ready") {
      setSize({ width: msg.width, height: msg.height });
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

  const box = size ?? DEFAULT_SIZE;
  const noCapture = knownNoCapture || link.state === "no-capture";
  const problem = link.state === "failed" ? link.error : error;
  return (
    <div
      ref={boxRef}
      className="my-1 w-[min(100%,640px)] overflow-hidden rounded-lg bg-sol-bg-alt ring-1 ring-sol-border/40"
      data-replay-moment={rawId}
      // The player's height follows the recording's shape at the embed's own
      // width (container units), plus its bar.
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
          style={{ height: `calc(100cqw * ${box.height / box.width} + ${PLAYER_BAR_PX}px)`, maxHeight: "70vh" }}
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
          {!size && (
            <div className="absolute inset-0 flex items-center justify-center text-[11.5px] text-sol-text-dim">
              {served || entity ? "Loading the page capture…" : "Opening the replay…"}
            </div>
          )}
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
