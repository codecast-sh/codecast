/**
 * This session's tab over raw CDP, for the verbs that speak to Chrome
 * themselves rather than through the engine (type-secret, flight): the same
 * browser choice the engine verbs make (the human's Chrome through the
 * extension bridge by default, the desktop pane when chosen, the agent
 * browser otherwise), then pageEval's attach to the session's pinned tab.
 */

import type { PublishDeps } from "../castApi.js";
import { engineSession, realSessionKey, runEngine } from "./engine.js";
import { engineBrowserFor, isPaneMode, isRealMode, requireRealBridge } from "./bridge/real.js";
import { desktopPaneCtx } from "./desktopPane.js";
import { ownerKey } from "./owner.js";
import { connectToTab, type PageCtx } from "./pageEval.js";
import { ensurePinnedTab } from "./pinnedTab.js";
import { engineRef, type TargetChoice } from "./cliEngine.js";
import type { CdpConnection } from "./cdp.js";

export interface SessionTab {
  ctx: PageCtx;
  conn: CdpConnection;
  sessionId: string;
  targetId: string;
  url: string;
  /** The browser socket, for a process of its own to attach again (it can carry the bridge token: never argv). */
  browserUrl: string;
  /** Focus a snapshot ref (#e12) or a CSS selector through the engine, which owns the refs. */
  focus(target: string): Promise<void>;
}

/** The browser this session drives, as the engine verbs choose it (cliEngine ctx). */
async function pageCtx(choice: TargetChoice, deps: PublishDeps): Promise<PageCtx> {
  const session = engineSession(deps.detectCurrentSessionId);
  const owner = ownerKey(deps.detectCurrentSessionId);
  if (isPaneMode(choice, owner)) return desktopPaneCtx(owner);
  if (!isRealMode(choice, owner)) return { session };
  return engineBrowserFor(realSessionKey(session), await requireRealBridge());
}

/** Attach to this session's tab, or throw the reason it has none. */
export async function openSessionTab(choice: TargetChoice, deps: PublishDeps): Promise<SessionTab> {
  const ctx = await pageCtx(choice, deps);
  await ensurePinnedTab(ctx.session);
  const tab = await connectToTab(ctx);
  if ("error" in tab) throw Object.assign(new Error(tab.error), { hint: tab.hint });
  return {
    ctx,
    ...tab,
    focus: async (target) => {
      const res = runEngine(["focus", engineRef(target)], { ...ctx, timeoutMs: 20_000 });
      if (res.status !== 0) throw new Error((res.stderr || res.stdout || `could not focus ${target}`).trim());
    },
  };
}
