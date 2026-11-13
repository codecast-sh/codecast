// Attaches to a cast browser tab over the bridge, for the capture scripts
// (docs-shots.ts, app-element-shot.ts, readme-shots.ts). Page.captureScreenshot
// with a clip renders fresh at any scale, where `cast browser shot` reads the
// compositor's last frame at 1x, which a background tab stops producing.

import { CdpConnection, listTargetsVia } from "../../cli/src/browser/cdp";
import { readBridgeState } from "../../cli/src/browser/bridge/host";
import { bridgeEndpointIfConfigured } from "../../cli/src/browser/bridge/real";
import { engineSession } from "../../cli/src/browser/engine";

export type CastTab = {
  conn: CdpConnection;
  sessionId: string;
  send: <T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  /** Runs an expression in the page (awaiting a returned promise) and returns its value. */
  evaluate: <T = unknown>(expression: string, timeoutMs?: number) => Promise<T>;
  close: () => void;
};

/**
 * The tab whose URL satisfies `match`, this session's own tabs first (other
 * sessions may have the same page open). `ownOnly` never borrows another
 * session's tab: parallel capture workers each drive their own.
 */
export async function attachCastTab(match: string | ((url: string) => boolean), hint = String(match), { ownOnly = false } = {}): Promise<CastTab> {
  const test = typeof match === "string" ? (url: string) => url.includes(match) : match;
  const tabs = readBridgeState()?.sessionTabs ?? {};
  const mine = engineSession();
  const keys = Object.keys(tabs)
    .filter((k) => !ownOnly || k.replace(/-real$/, "") === mine)
    .sort((a, b) => Number(b.startsWith(mine)) - Number(a.startsWith(mine)));
  const session = keys.find((k) => tabs[k].some((t) => test(t.url)));
  if (!session) throw new Error(`no cast browser tab matching ${hint}`);
  const ep = await bridgeEndpointIfConfigured(session);
  if (!ep) throw new Error("the cast browser bridge is not running: check cast browser extension status");
  const conn = await CdpConnection.fromPort(ep);
  const target = (await listTargetsVia(conn)).find((t) => test(t.url));
  if (!target) {
    conn.close();
    throw new Error(`the tab matching ${hint} is not visible to this session`);
  }
  const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const send = <T,>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000) => conn.send<T>(method, params, sessionId, timeoutMs);
  const evaluate = async <T,>(expression: string, timeoutMs = 60_000) => {
    const res = await send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (res.exceptionDetails) throw new Error(`page threw: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    return res.result.value;
  };
  return { conn, sessionId, send, evaluate, close: () => conn.close() };
}
