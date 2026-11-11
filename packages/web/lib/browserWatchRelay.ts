// Watching a session's browser on ANOTHER of your machines.
//
// connectBrowserWatch (browserWatch.ts) dials the daemon's loopback socket,
// which only the machine this browser runs on can answer. When the agent runs
// somewhere else, this is the transport: a lease on a Convex row
// (convex/browserStream.ts) that the far daemon fills with the newest frame,
// the tab and the agent's recent actions. It speaks the same WatchHandlers and
// returns the same WatchConnection, so the stream component only chooses
// which one to dial. Contract: packages/shared/contracts/browserStream.ts.

import type { ConvexReactClient } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import {
  BROWSER_RELAY_RENEW_MS,
  BROWSER_RELAY_START_TIMEOUT_MS,
} from "@codecast/shared/contracts";
import { parseWatchAction, type WatchConnection, type WatchHandlers, type WatchInputEvent } from "./browserWatch";

export interface BrowserRelaySource {
  convex: ConvexReactClient;
  deviceId: string;
  sessionUuid?: string | null;
  tmuxSession?: string | null;
  /** For the sentence when the machine never answers. */
  machineName?: string | null;
}

interface RelayRow {
  frame: string | null;
  frame_w: number;
  frame_h: number;
  seq: number;
  tab: { id: string; title: string; url: string } | null;
  control: boolean;
  actions: unknown[];
  end: { kind: "error" | "exit"; code: string; message?: string } | null;
  streamer_seen_at: number | null;
}

/** A viewer that sent input within this window renews as "driving", which
 *  keeps the far loop collecting input every 200ms. */
const DRIVING_WINDOW_MS = 10_000;

/** Input is gathered this long before one send: a click is a press and a
 *  release, and they should cost one write, not two. */
const INPUT_COALESCE_MS = 50;

/** The relay row a session's stream lives under: its uuid, else its tmux
 *  session. Null when there is neither, and nothing to watch. */
export function browserRelayKey(s: { sessionUuid?: string | null; tmuxSession?: string | null }): string | null {
  return s.sessionUuid || s.tmuxSession || null;
}

export function connectBrowserWatchRelay(src: BrowserRelaySource, handlers: WatchHandlers): WatchConnection {
  const key = browserRelayKey(src)!;
  const base = { device_id: src.deviceId, key };
  let done = false;
  let lastInputAt = 0;
  let readyTab: string | null = null;
  let lastTab: { title: string; url: string } | null = null;
  let lastSeq = -1;
  let lastActionAt = 0;
  let unsubscribe: (() => void) | null = null;

  const finish = (fn: () => void) => {
    if (done) return;
    done = true;
    teardown();
    fn();
  };

  const renew = async () => {
    if (done) return;
    try {
      const res = await src.convex.mutation(api.browserStream.watchBrowser, {
        ...base,
        ...(src.sessionUuid ? { session_uuid: src.sessionUuid } : {}),
        ...(src.tmuxSession ? { tmux_session: src.tmuxSession } : {}),
        interactive: Date.now() - lastInputAt < DRIVING_WINDOW_MS,
      });
      if (res && res.ok === false) {
        finish(() => handlers.onError("unknown-device", "that machine isn't registered to your account"));
      }
    } catch (err) {
      finish(() => handlers.onError("relay", err instanceof Error ? err.message : "could not reach the relay"));
    }
  };

  const apply = (row: RelayRow) => {
    if (row.tab && row.streamer_seen_at) {
      if (row.tab.id !== readyTab) {
        readyTab = row.tab.id;
        lastTab = { title: row.tab.title, url: row.tab.url };
        handlers.onReady(row.tab, row.control);
      } else if (lastTab && (lastTab.title !== row.tab.title || lastTab.url !== row.tab.url)) {
        lastTab = { title: row.tab.title, url: row.tab.url };
        handlers.onTab(row.tab);
      }
    }
    if (readyTab && row.frame && row.seq !== lastSeq) {
      lastSeq = row.seq;
      handlers.onFrame(`data:image/jpeg;base64,${row.frame}`, row.frame_w, row.frame_h);
    }
    if (readyTab && handlers.onAction) {
      for (const raw of row.actions) {
        const a = parseWatchAction(raw);
        if (!a || a.at <= lastActionAt) continue;
        lastActionAt = a.at;
        handlers.onAction(a);
      }
    }
    if (row.end) {
      const end = row.end;
      finish(() =>
        end.kind === "error" ? handlers.onError(end.code, end.message ?? "") : handlers.onExit(end.code),
      );
    }
  };

  const startTimer = setTimeout(() => {
    if (readyTab) return;
    const where = src.machineName ?? "the agent's machine";
    finish(() =>
      handlers.onError("no-answer", `${where} didn't answer. It may be asleep or offline, or its cast may need an update.`),
    );
  }, BROWSER_RELAY_START_TIMEOUT_MS);
  const renewTimer = setInterval(() => void renew(), BROWSER_RELAY_RENEW_MS);

  // Subscribe only after the first renewal lands: that renewal clears a
  // previous stream's ending and picture, so the first answer read here can
  // never be a stale "tab closed".
  void renew().then(() => {
    if (done) return;
    const watch = src.convex.watchQuery(api.browserStream.getBrowser, base, {});
    unsubscribe = watch.onUpdate(() => {
      if (done) return;
      let row: RelayRow | null | undefined;
      try {
        row = watch.localQueryResult() as RelayRow | null | undefined;
      } catch (err) {
        // A web build ahead of its convex deploy: say so, don't throw into
        // React.
        finish(() => handlers.onError("relay", err instanceof Error ? err.message : "relay unavailable"));
        return;
      }
      if (row) apply(row);
    });
  });

  // Input batches go strictly in order: two sends in flight could land in
  // either order and transpose a click and a keystroke.
  let chain: Promise<unknown> = Promise.resolve();
  let outbox: WatchInputEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    flushTimer = null;
    if (done || outbox.length === 0) return;
    const batches: WatchInputEvent[][] = [];
    for (let i = 0; i < outbox.length; i += 64) batches.push(outbox.slice(i, i + 64));
    outbox = [];
    for (const events of batches) {
      chain = chain
        .then(() => src.convex.mutation(api.browserStream.sendBrowserInput, { ...base, events }))
        .catch(() => {});
    }
  };

  function teardown() {
    clearTimeout(startTimer);
    if (flushTimer) clearTimeout(flushTimer);
    clearInterval(renewTimer);
    unsubscribe?.();
    unsubscribe = null;
  }

  return {
    close() {
      done = true;
      teardown();
    },
    sendInput(events: WatchInputEvent[]) {
      if (done || !readyTab || events.length === 0) return;
      const wasDriving = Date.now() - lastInputAt < DRIVING_WINDOW_MS;
      lastInputAt = Date.now();
      // The first input after a pause renews at once as "driving", so the far
      // loop speeds up now rather than at the next timed renewal.
      if (!wasDriving) void renew();
      for (const ev of events) {
        // A run of pointer moves only matters where it ends.
        const prev = outbox[outbox.length - 1];
        if (ev.kind === "mouse" && ev.type === "mouseMoved" && prev?.kind === "mouse" && prev.type === "mouseMoved") {
          outbox[outbox.length - 1] = ev;
        } else {
          outbox.push(ev);
        }
      }
      if (!flushTimer) flushTimer = setTimeout(flush, INPUT_COALESCE_MS);
    },
  };
}
