// The replay player's link and channel, as codecast embeds it (docs/architecture/external-data.md
// X5, "Playing a replay"; contracts/replayPlayer.ts). A recording's page
// capture is a customer's DOM, so it never renders on this origin: the player
// is a page on its own origin (replay.codecast.sh), loaded here in an iframe
// through a capability Convex mints for one replay and one viewer, fresh each
// time the player opens (it lasts ten minutes; the page reads its events once,
// at load, so a capability that lapses later costs nothing).
//
// Two hosts use this: the /ops replay page, which hides the player's own bar
// and drives it from its scrubber and event list, and the `rp-N@1:23` embed in
// markdown, which keeps the player's bar and just opens it at the moment.
// Messages are trusted only from the player's origin and only from this
// iframe's window; commands go to that origin alone. The player's `hello`
// (it does not know this page's origin yet) is answered here, for every host. The iframe is
// components/ops/ReplayPlayerFrame.tsx.
import { useCallback, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import {
  REPLAY_HOST_SOURCE,
  REPLAY_PLAYER_ORIGIN,
  isReplayPlayerMessage,
  type ReplayHostMessage,
  type ReplayPlayerLink,
  type ReplayPlayerMessage,
} from "@codecast/shared/contracts/replayPlayer";
import { useWatchEffect } from "./useWatchEffect";

export type ReplayPlayerLinkState =
  | { state: "idle" }
  | { state: "opening" }
  | { state: "ready"; url: string; origin: string }
  /** The replay keeps no page capture: there is nothing to play, only the text stream. */
  | { state: "no-capture" }
  | { state: "failed"; error: string };

/**
 * A player link for one replay, minted when `open` turns true and dropped when
 * it turns false, so every opening carries a fresh capability. Where the
 * player opens and whether it shows its own bar are read at the mint: later
 * moves go over postMessage, not through a new link.
 */
export function useReplayPlayerLink(
  replay: string | null,
  open: boolean,
  opts: { t_ms?: number | null; controls?: boolean; autoplay?: boolean },
): ReplayPlayerLinkState {
  const playerLink = useAction(api.replays.playerLink);
  const [link, setLink] = useState<ReplayPlayerLinkState>({ state: "idle" });
  // Read at the mint, never a reason to mint again.
  const mintRef = useRef({ playerLink, opts });
  mintRef.current = { playerLink, opts };
  useWatchEffect(() => {
    if (!replay || !open) {
      setLink({ state: "idle" });
      return;
    }
    let cancelled = false;
    setLink({ state: "opening" });
    const { t_ms, controls, autoplay } = mintRef.current.opts;
    mintRef.current.playerLink({
      replay,
      ...(t_ms != null ? { t_ms: Math.max(0, Math.round(t_ms)) } : {}),
      ...(controls === false ? { controls: false } : {}),
      ...(autoplay ? { autoplay: true } : {}),
    }).then(
      (res: ReplayPlayerLink) => {
        if (cancelled) return;
        if (!res.has_dom || !res.player_url) return setLink({ state: "no-capture" });
        setLink({ state: "ready", url: res.player_url, origin: playerOrigin(res.player_url) });
      },
      (e: unknown) => {
        if (!cancelled) setLink({ state: "failed", error: playerLinkError(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [replay, open]);
  return link;
}

/** The origin a minted player URL is on. Convex builds it from REPLAY_PLAYER_ORIGIN; anything unparsable falls back to that. */
function playerOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return REPLAY_PLAYER_ORIGIN;
  }
}

function playerLinkError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return /not found/i.test(msg) ? "This replay is not available to you." : "The player could not be opened.";
}

/** A host command without its tag, one variant at a time. */
export type ReplayHostCommand = ReplayHostMessage extends infer M ? (M extends ReplayHostMessage ? Omit<M, "source"> : never) : never;

/**
 * The iframe's channel: a ref for the frame, `send` for commands, and
 * `onMessage` called with each message the player in THIS frame posts.
 */
export function useReplayPlayerChannel(origin: string | null, onMessage: (msg: ReplayPlayerMessage) => void) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const handler = useRef(onMessage);
  handler.current = onMessage;
  useWatchEffect(() => {
    if (!origin) return;
    const on = (e: MessageEvent) => {
      const frame = frameRef.current?.contentWindow;
      if (e.origin !== origin || !frame || e.source !== frame || !isReplayPlayerMessage(e.data)) return;
      // A player that cannot see this page's origin holds its messages and
      // says hello until a command tells it; the answer is that command.
      if (e.data.type === "hello") {
        frame.postMessage({ source: REPLAY_HOST_SOURCE, type: "hello" }, origin);
        return;
      }
      handler.current(e.data);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [origin]);
  const send = useCallback(
    (cmd: ReplayHostCommand) => {
      if (origin) frameRef.current?.contentWindow?.postMessage({ source: REPLAY_HOST_SOURCE, ...cmd }, origin);
    },
    [origin],
  );
  return { frameRef, send };
}

