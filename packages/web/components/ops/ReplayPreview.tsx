// A recording's page at a glance, from the list: hover a row (or press Space
// on it) and a card plays the recorded page, muted of controls, from the
// first moment the person did something. It is the same isolated player the
// replay page embeds (ReplayPlayerFrame), so the customer's page never renders
// on this origin; the card mints its capability only once it opens, and a
// row that kept no page capture never asks.
import { useState } from "react";
import { createPortal } from "react-dom";
import { Film } from "lucide-react";
import { ReplayPlayerIframe } from "./ReplayPlayerFrame";
import { useReplayPlayerChannel, useReplayPlayerLink } from "../../hooks/useReplayPlayer";
import { formatReplayTime } from "@codecast/shared/replay";
import { previewAt } from "./replayModel";
import type { OpsReplay } from "./opsTypes";

const CARD_W = 400;
const CARD_MAX_H = 300;

/** The card's place: beside the row's left edge, under it, or above it near the bottom of the window. */
function placeCard(anchor: DOMRect, height: number): { left: number; top: number } {
  const left = Math.max(8, Math.min(anchor.left + 40, window.innerWidth - CARD_W - 8));
  const below = anchor.bottom + 6;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, anchor.top - height - 6) : below;
  return { left, top };
}

export function ReplayPreview({ replay: r, anchor }: { replay: OpsReplay; anchor: DOMRect }) {
  const at = previewAt(r.shape, r.captured_ms ?? r.duration_ms);
  const hasDom = (r.dom_chunks ?? 0) > 0;
  const link = useReplayPlayerLink(hasDom ? r._id : null, hasDom, { t_ms: at, controls: false, autoplay: true });
  const [size, setSize] = useState<{ width: number; height: number; below: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const channel = useReplayPlayerChannel(link.state === "ready" ? link.origin : null, (msg) => {
    if (msg.type === "ready") {
      setSize({ width: msg.width, height: msg.height, below: msg.below_px ?? 0 });
      channel.send({ type: "speed", speed: 2 });
      channel.send({ type: "seek", t_ms: at, play: true });
    } else if (msg.type === "size") setSize((prev) => (prev ? { ...prev, width: msg.width, height: msg.height } : prev));
    else if (msg.type === "error") setError(msg.message);
  });
  // The card shows the page alone: what the player draws under it (its remote-assets strip) runs past the stage's bottom, clipped.
  const h = size ? Math.min(CARD_MAX_H, Math.round((CARD_W * size.height) / size.width)) : 225;
  const pos = placeCard(anchor, h + 26);
  const problem = !hasDom ? "No page capture: events only" : link.state === "failed" ? link.error : error;
  return createPortal(
    <div className="rp-preview" style={{ left: pos.left, top: pos.top, width: CARD_W }} role="tooltip" data-replay-preview={r.short_id}>
      <div className="rp-preview-stage" style={{ height: h }}>
        {problem ? (
          <span className="rp-preview-note"><Film className="w-3.5 h-3.5" aria-hidden />{problem}</span>
        ) : (
          <>
            {link.state === "ready" && (
              <ReplayPlayerIframe frameRef={channel.frameRef} url={link.url} title={`Preview of ${r.short_id}`} style={{ height: `calc(100% + ${size?.below ?? 0}px)`, top: 0, bottom: "auto", opacity: size ? 1 : 0, pointerEvents: "none" }} />
            )}
            {!size && <span className="rp-preview-note ops-quiet">Loading the page…</span>}
          </>
        )}
      </div>
      <div className="rp-preview-foot ops-num">
        <span className="ops-mono">{r.short_id}</span>
        <span className="ops-dim">from {formatReplayTime(at).replace(/\.\d$/, "")} at 2×</span>
      </div>
    </div>,
    document.body,
  );
}
