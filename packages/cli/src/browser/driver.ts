/**
 * How a `cast browser` command reaches the built-in browser: this process
 * opens its own socket to Chrome and does the tab setup itself, as cheaply as
 * a fresh process can (see `openDriver`). Every verb of the built-in driver
 * runs against the one interface below.
 */

import { CdpConnection, listTargetsVia, type CdpClient, type CdpTarget } from "./cdp.js";
import {
  attachToTarget, probeLiveness, readState, type InstanceState, type PageSession,
} from "./instance.js";
import { armRecorder } from "./observe.js";
import { setViewport } from "./devices.js";
import { BrowserNotLive, isReachable } from "./recovery.js";
import { mark } from "./timing.js";

export interface BrowserDriver {
  conn: CdpClient;
  /** Instance state as of opening the driver. */
  state: InstanceState;
  /** Open page tabs. */
  targets(): Promise<CdpTarget[]>;
  /** A ready-to-use page: attached, domains on, recorder armed, viewport applied. */
  attach(targetId: string): Promise<PageSession>;
  /** Forget a tab's session (before closing the tab). */
  detach(targetId: string): Promise<void>;
  close(): void;
}

export interface OpenDriverOptions {
  /** How long to wait for a busy browser to answer before calling it unresponsive. */
  patienceMs?: number;
}

/**
 * Open a driver to the live managed browser, trimmed to what a fresh process
 * must do. Throws `BrowserNotLive` when there is no usable browser, with the
 * verdict the caller should relay.
 *
 * It used to be: probe /json/version (liveness), fetch /json/version again
 * (socket discovery), open the socket, fetch /json/list (tabs), attach, five
 * enables one after another, two recorder messages one after another. Every
 * verb, every time. Now the socket URL is remembered from `start` (it is fixed
 * for the browser's life), the connection itself is the liveness probe, tabs
 * come over that socket, and the per-tab setup overlaps its round trips
 * (recovery.ts / observe.ts). The HTTP probe is kept only for the failure
 * path, where "gone" vs "not answering" is the whole question.
 */
export async function openDriver(opts: OpenDriverOptions = {}): Promise<BrowserDriver> {
  const state = readState();
  if (!state) throw new BrowserNotLive("exited", state);
  let conn: CdpConnection;
  try {
    conn = state.wsUrl ? await CdpConnection.connect(state.wsUrl, 5000) : await CdpConnection.fromPort(state.port, 5000);
  } catch {
    // Could not connect: classify honestly before telling the agent anything,
    // because the wrong verdict here is what starts restart stampedes.
    const liveness = await probeLiveness(state, opts.patienceMs);
    if (!isReachable(liveness)) throw new BrowserNotLive(liveness, state);
    // Alive after all (a stale cached URL, or a transient) — one more try the
    // slow way. Discovery re-learns the URL if the browser was replaced.
    conn = await CdpConnection.fromPort(state.port);
  }
  mark("connect");
  return {
    conn,
    state,
    targets: () => listTargetsVia(conn).finally(() => mark("targets")),
    attach: async (targetId) => {
      const page = await attachToTarget(conn, targetId);
      // Re-arm every time: the previous process's registration died with its
      // session, so without this any navigation this command triggers would
      // land on a page with no console capture at all. Same for the viewport:
      // an emulated size is session-scoped and would evaporate between
      // commands. Both are independent of each other, so they overlap.
      const vp = readState()?.viewportByTab?.[targetId];
      await Promise.all([armRecorder(page), vp ? setViewport(page, vp).catch(() => {}) : undefined]);
      mark("attach");
      return page;
    },
    detach: async () => {},
    close: () => conn.close(),
  };
}
