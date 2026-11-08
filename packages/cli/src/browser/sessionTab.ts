/**
 * This session's tab over raw CDP, for the verbs that speak to Chrome
 * themselves (type-secret, flight), under whichever driver `cast browser`
 * registered:
 *
 *   - the engine (the usual case): the same browser choice the engine verbs
 *     make (the human's Chrome through the extension bridge by default, the
 *     desktop pane when chosen, the agent browser otherwise), then pageEval's
 *     attach to the session's pinned tab; refs belong to the engine, so it
 *     focuses them.
 *   - the built-in driver (no engine installed): the human's Chrome through
 *     the bridge, on the tab bridge/real.ts remembers for this session; its
 *     refs are backend node ids, focused with DOM.focus.
 */

import type { PublishDeps } from "../castApi.js";
import { browserSocketUrl, CdpConnection } from "./cdp.js";
import { engineFitness, engineSession, realSessionKey, runEngine } from "./engine.js";
import { engineBrowserFor, isPaneMode, isRealMode, listRealTargets, requireRealBridge, resolveRealTarget } from "./bridge/real.js";
import { bridgeEndpoint } from "./bridge/host.js";
import { desktopPaneCtx } from "./desktopPane.js";
import { ownerKey } from "./owner.js";
import { connectToTab, type PageCtx } from "./pageEval.js";
import { ensurePinnedTab } from "./pinnedTab.js";
import { engineRef, type TargetChoice } from "./cliEngine.js";
import { focus as focusRefIn } from "./actions.js";

export interface SessionTab {
  /** The session key the recorder is filed under. */
  session: string;
  conn: CdpConnection;
  sessionId: string;
  targetId: string;
  url: string;
  /** The browser socket, for a process of its own to attach again (it can carry the bridge token: never argv). */
  browserUrl: string;
  /** Focus a snapshot ref (#e12) the way the driver that made it reads it. */
  focusRef(ref: string): Promise<void>;
}

/** The driver `cast browser` registered (cli.ts useEngine): the engine when a usable copy is installed. */
const enginePath = () => process.env.CAST_BROWSER_LEGACY !== "1" && engineFitness().ok;

/** The browser this session drives, as the engine verbs choose it (cliEngine ctx). */
async function pageCtx(choice: TargetChoice, deps: PublishDeps): Promise<PageCtx> {
  const session = engineSession(deps.detectCurrentSessionId);
  const owner = ownerKey(deps.detectCurrentSessionId);
  if (isPaneMode(choice, owner)) return desktopPaneCtx(owner);
  if (!isRealMode(choice, owner)) return { session };
  return engineBrowserFor(realSessionKey(session), await requireRealBridge());
}

async function engineTab(choice: TargetChoice, deps: PublishDeps): Promise<SessionTab> {
  const ctx = await pageCtx(choice, deps);
  await ensurePinnedTab(ctx.session);
  const tab = await connectToTab(ctx);
  if ("error" in tab) throw Object.assign(new Error(tab.error), { hint: tab.hint });
  return {
    session: ctx.session,
    ...tab,
    focusRef: async (ref) => {
      const res = runEngine(["focus", engineRef(ref)], { ...ctx, timeoutMs: 20_000 });
      if (res.status !== 0) throw new Error((res.stderr || res.stdout || `could not focus ${ref}`).trim());
    },
  };
}

async function builtInTab(choice: TargetChoice, deps: PublishDeps): Promise<SessionTab> {
  const owner = ownerKey(deps.detectCurrentSessionId);
  if (!isRealMode(choice, owner)) throw new Error("without the browser engine, this verb drives the human's Chrome only");
  const bridge = await requireRealBridge();
  const target = resolveRealTarget(await listRealTargets(bridge), undefined, owner);
  const browserUrl = await browserSocketUrl(bridgeEndpoint(bridge), 8000);
  const conn = await CdpConnection.connect(browserUrl, 8000);
  try {
    const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    return {
      session: owner ?? "default",
      conn,
      sessionId,
      targetId: target.targetId,
      url: target.url,
      browserUrl,
      focusRef: async (ref) => {
        await conn.send("DOM.getDocument", { depth: 0 }, sessionId);
        // A ref from inside a cross-origin frame focuses there (oopif.ts).
        await focusRefIn({ conn, sessionId, targetId: target.targetId }, parseInt(ref.replace(/^#?e/i, ""), 10)).catch(() => {
          throw new Error(`${ref} is gone from the page: take a fresh snapshot`);
        });
      },
    };
  } catch (err) {
    conn.close();
    throw err;
  }
}

/** Attach to this session's tab, or throw the reason it has none. */
export function openSessionTab(choice: TargetChoice, deps: PublishDeps): Promise<SessionTab> {
  return enginePath() ? engineTab(choice, deps) : builtInTab(choice, deps);
}
