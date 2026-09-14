/**
 * The desktop pane as a `cast browser` target.
 *
 * Three browsers can stand behind a session's verbs: the human's Chrome
 * through the extension bridge (bridge/real.ts), the managed clone, and — on
 * a machine running the codecast desktop app — the pane the human opened for
 * this session, driven over the app's own CDP port. This module is the third
 * one's policy, and it is the strictest of the three: a session may act only
 * on a pane the human opened FOR it (the offer, `cast browser pane <url>`),
 * and it may never open one. The registry (desktopPaneRegistry.ts) says which
 * pane that is; the engine drives it under a `-pane` session key
 * (engine.ts) pinned to the pane's exact target.
 */

import { CdpConnection, browserSocketUrl } from "./cdp.js";
import { engineSessionKey, engineStateDir, paneSessionKey, type EngineOptions } from "./engine.js";
import { attachToTarget, type InstanceState, type PageSession } from "./instance.js";
import { armRecorder } from "./observe.js";
import { readBoundTarget, sessionDaemonPid, writeBoundTarget } from "./pinnedTab.js";
import { detachSessionDaemon } from "./engineReap.js";
import { explicitTarget, forgetDesktopPane, rememberDesktopPane, rememberedDesktopPane, setStickyTarget } from "./bridge/real.js";
import {
  findDesktopPane, liveDesktopPaneRegistry, liveDesktopPanes, paneOwnerIds, type DesktopPaneRegistry, type LiveDesktopPane,
} from "./desktopPaneRegistry.js";

/** The one way a session gets a pane, said the same everywhere. */
export const PANE_HOW_TO =
  "offer one with `cast browser pane <url>` and wait for the human to open it — an agent never opens a pane itself";

/** Appended to a tab line when the tab is the desktop app's pane. */
export const PANE_TAB_NOTE = " (desktop pane, driven over the app's CDP port)";

export type DesktopPaneReason = "no-app" | "no-pane" | "closed";

export class DesktopPaneUnavailable extends Error {
  constructor(
    public readonly reason: DesktopPaneReason,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "DesktopPaneUnavailable";
  }
}

export interface ResolvedDesktopPane {
  registry: DesktopPaneRegistry;
  pane: LiveDesktopPane;
}

/** Test seams: the registry and the app's target list. */
export interface DesktopPaneDeps {
  registry?: () => DesktopPaneRegistry | null;
  live?: (reg: DesktopPaneRegistry) => Promise<LiveDesktopPane[]>;
  env?: NodeJS.ProcessEnv;
}

/**
 * The pane this session may drive, or why it may not. Three answers, each
 * its own sentence, because an agent acts on them differently:
 *
 *   no-app   the desktop app is not running with a CDP port; nothing to drive
 *   no-pane  the session never had a pane: offer one and wait
 *   closed   the session had one and the human closed it; said once, then
 *            the session's ordinary browser takes over (ctx in cliEngine.ts)
 *
 * "Closed" is remembered per session in real.json (bridge/real.ts): the last
 * pane a session drove. The memory is cleared as it is reported, which is
 * what makes the report happen once; the sticky `target pane` choice goes
 * with it, or every later verb would report the same closed pane again.
 */
export async function resolveDesktopPane(
  sessionKey: string | null,
  opts: { pane?: string } = {},
  deps: DesktopPaneDeps = {},
): Promise<ResolvedDesktopPane> {
  const registry = (deps.registry ?? liveDesktopPaneRegistry)();
  if (!registry) {
    throw new DesktopPaneUnavailable(
      "no-app",
      "the desktop app is not running with its CDP port, so there is no pane to drive",
      "from source the port is on by default; a packaged app needs CODECAST_CDP_PORT set",
    );
  }
  let live: LiveDesktopPane[];
  try {
    live = await (deps.live ?? liveDesktopPanes)(registry);
  } catch (err) {
    throw new DesktopPaneUnavailable("no-app", `the desktop app's CDP port ${registry.port} did not answer: ${(err as Error).message}`);
  }
  const pane = findDesktopPane(live, paneOwnerIds(sessionKey, deps.env), opts.pane);
  if (!pane) {
    const before = rememberedDesktopPane(sessionKey);
    if (before) {
      forgetDesktopPane(sessionKey);
      if (explicitTarget(sessionKey) === "pane") setStickyTarget(sessionKey, "real");
      throw new DesktopPaneUnavailable("closed", "the pane was closed", PANE_HOW_TO);
    }
    throw new DesktopPaneUnavailable("no-pane", `this session has no desktop pane: ${PANE_HOW_TO}`);
  }
  rememberDesktopPane(sessionKey, pane.paneId);
  return { registry, pane };
}

/** The session's pane if it has one right now, else null. Never throws:
 *  for status lines, not for acting. */
export async function ownedDesktopPane(sessionKey: string | null, deps: DesktopPaneDeps = {}): Promise<ResolvedDesktopPane | null> {
  try {
    return await resolveDesktopPane(sessionKey, {}, deps);
  } catch {
    return null;
  }
}

/**
 * The engine options that drive the pane: a `-pane` session key on the app's
 * browser socket, pinned to the pane's target (pinnedTab.ts writes the same
 * file the engine daemon adopts at attach). A pane is not a tab the engine
 * opened, so when the target changed under the key — the human closed the
 * pane and opened a fresh offer — the daemon holding the old one is detached
 * before the new binding is written, or it would keep driving a view that no
 * longer exists and never adopt this one.
 */
export async function desktopPaneCtx(
  sessionKey: string | null,
  opts: { pane?: string } = {},
  deps: DesktopPaneDeps & { detach?: (session: string) => boolean; stateDir?: string; socket?: (port: number) => Promise<string> } = {},
): Promise<EngineOptions & { session: string }> {
  const { registry, pane } = await resolveDesktopPane(sessionKey, opts, deps);
  // The same key engineSession() derives from the owner, with the pane suffix.
  const session = paneSessionKey(sessionKey ? engineSessionKey(sessionKey) : "default");
  const stateDir = deps.stateDir ?? engineStateDir();
  if (readBoundTarget(session, stateDir) !== pane.targetId) {
    if (sessionDaemonPid(session, stateDir)) (deps.detach ?? detachSessionDaemon)(session);
    writeBoundTarget(session, pane.targetId, stateDir, pane.url ?? "about:blank");
  }
  const cdp = await (deps.socket ?? ((port: number) => browserSocketUrl(port)))(registry.port);
  return { session, cdp };
}

/** The built-in driver's counterpart of bridge/real.ts withRealPage, for a
 *  machine without the engine. Throws; the caller renders. */
export async function withDesktopPanePage<T>(
  opts: { pane?: string },
  fn: (page: PageSession, state: InstanceState, conn: CdpConnection) => Promise<T>,
  sessionKey: string | null,
): Promise<T> {
  const { registry, pane } = await resolveDesktopPane(sessionKey, opts);
  const conn = await CdpConnection.fromPort(registry.port);
  try {
    const page = await attachToTarget(conn, pane.targetId);
    await armRecorder(page);
    return await fn(page, paneStateStub(registry), conn);
  } finally {
    conn.close();
  }
}

/** InstanceState for the command bodies that read one; there is no managed
 *  process behind a pane, which is what the zeros say. */
export function paneStateStub(registry: DesktopPaneRegistry): InstanceState {
  return {
    pid: registry.pid ?? 0,
    port: registry.port,
    userDataDir: "",
    headless: false,
    sourceProfile: "desktop app pane",
    channel: "chrome",
    startedAt: registry.updatedAt,
    activeTargetId: null,
  };
}
