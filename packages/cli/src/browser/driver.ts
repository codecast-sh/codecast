/**
 * How a `cast browser` command reaches the built-in browser.
 *
 * Two ways, one interface. The DIRECT driver is the working model: this
 * process opens its own socket to Chrome and does the tab setup itself, as
 * cheaply as a fresh process can (see `openDirect`). The RESIDENT driver talks
 * to a daemon-hosted connection instead (resident/host.ts); it is written but
 * NOT mounted in the daemon — a session-scoped resident engine (agent-browser)
 * is going underneath `cast browser`, so hosting a second one here would
 * duplicate it. It stays behind an explicit opt-in so the code can be revived
 * without an archaeology dig, and `cast browser` never depends on it.
 *
 * Callers never choose; `openDriver()` does, and every verb runs the same code
 * against whichever it got.
 */

import { CdpConnection, listTargetsVia, type CdpClient, type CdpTarget } from "./cdp.js";
import {
  attachToTarget, probeLiveness, readState, type InstanceState, type PageSession,
} from "./instance.js";
import { armRecorder } from "./observe.js";
import { setViewport } from "./actions.js";
import { BrowserNotLive } from "./recovery.js";
import { readHookPort, ResidentClient } from "./resident/client.js";
import { mark } from "./timing.js";

export type DriverKind = "resident" | "direct";

export interface BrowserDriver {
  kind: DriverKind;
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

/**
 * Which path to take. Pure, so the choice is testable without a daemon: the
 * resident path needs BOTH the explicit opt-in and a daemon port; anything
 * else, including any connect failure later, means direct.
 */
export function chooseDriver(input: { residentOptIn: boolean; hookPort: number | null }): DriverKind {
  return input.residentOptIn && input.hookPort ? "resident" : "direct";
}

export interface OpenDriverOptions {
  /** How long to wait for a busy browser to answer before calling it unresponsive. */
  patienceMs?: number;
}

/** Opt-in for the dormant daemon-resident path. */
export const RESIDENT_ENV = "CAST_BROWSER_RESIDENT";

/**
 * Open a driver to the live managed browser. Throws `BrowserNotLive` when
 * there is no usable browser, with the verdict the caller should relay.
 */
export async function openDriver(opts: OpenDriverOptions = {}): Promise<BrowserDriver> {
  const kind = chooseDriver({ residentOptIn: process.env[RESIDENT_ENV] === "1", hookPort: readHookPort() });
  if (kind === "resident") {
    try {
      return await openResident();
    } catch (err) {
      // The daemon answered and said the browser is not there: that verdict
      // stands. Anything else (no daemon, old daemon, slow daemon) means direct.
      if (err instanceof BrowserNotLive) throw err;
    }
  }
  return openDirect(opts);
}

async function openResident(): Promise<BrowserDriver> {
  const port = readHookPort();
  if (!port) throw new Error("no daemon port");
  const client = await ResidentClient.connect(port);
  const { liveness, state } = client.hello;
  if (liveness !== "live" || !state) {
    client.close();
    throw new BrowserNotLive(liveness, state);
  }
  return {
    kind: "resident",
    conn: client,
    state,
    targets: () => client.targets(),
    attach: async (targetId) => {
      const { sessionId } = await client.attach(targetId);
      return { conn: client, sessionId, targetId };
    },
    detach: async (targetId) => {
      await client.detach(targetId).catch(() => {});
    },
    close: () => client.close(),
  };
}

/**
 * The direct path, trimmed to what a fresh process must do.
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
async function openDirect(opts: OpenDriverOptions): Promise<BrowserDriver> {
  const state = readState();
  if (!state) throw new BrowserNotLive("dead", state);
  let conn: CdpConnection;
  try {
    conn = state.wsUrl ? await CdpConnection.connect(state.wsUrl, 5000) : await CdpConnection.fromPort(state.port, 5000);
  } catch {
    // Could not connect: classify honestly before telling the agent anything,
    // because the wrong verdict here is what starts restart stampedes.
    const liveness = await probeLiveness(state, opts.patienceMs);
    if (liveness !== "live") throw new BrowserNotLive(liveness, state);
    // Alive after all (a stale cached URL, or a transient) — one more try the
    // slow way. Discovery re-learns the URL if the browser was replaced.
    conn = await CdpConnection.fromPort(state.port);
  }
  mark("connect");
  return {
    kind: "direct",
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
