/**
 * `eval` and `grant`, spoken straight to Chrome over CDP.
 *
 * `eval` used to pass through to the engine, which cost agents three real
 * capabilities and a silent failure:
 *
 *   - The engine binary is spawned with stdin ignored (engine.ts), so
 *     `eval --stdin` forwarded the flag but dropped the heredoc — every
 *     multi-line script "returned" null with no error.
 *   - The engine does not await promises, so `fetch(...)`, `enumerateDevices()`
 *     or any `await` came back null and pushed agents into write-a-global-
 *     then-poll workarounds.
 *   - There was no way to run a script file.
 *
 * Owning the verb here fixes all three in one move: `Runtime.evaluate` with
 * `awaitPromise` + `replMode` gives top-level await and settled promise
 * values, and the CLI reads stdin/files itself. `grant` rides the same
 * connection: `Browser.grantPermissions` answers a permission prompt the
 * agent cannot see (camera, mic, clipboard…) without restarting the browser —
 * a restart would close every other session's tabs.
 */

import { browserSocketUrl, CdpConnection, CdpError, CdpTimeout, type CdpClient } from "./cdp.js";
import { readState } from "./instance.js";
import { readBoundTarget } from "./pinnedTab.js";
import { engineTabs, type EngineOptions } from "./engine.js";

/** This session and the browser it drives (cliEngine.ts ctx). A bare
 *  session string is never accepted: runEngine would then guess the browser
 *  from the managed state file, and for a real session that guess makes the
 *  daemon rebind the session to the wrong Chrome. */
export type PageCtx = EngineOptions & { session: string };

/** This session's tab and a browser socket, or a human-readable refusal. */
export async function connectToTab(o: PageCtx): Promise<
  { conn: CdpConnection; sessionId: string; url: string; targetId: string; browserUrl: string } | { error: string; hint?: string }
> {
  // A real session carries the bridge's browser socket (engineBrowserFor);
  // the managed clone is found through its state file.
  const state = o.cdp ? null : readState();
  if (!o.cdp && !state) return { error: "no managed browser is running", hint: "cast browser start" };
  // The tab listing rides the engine daemon and can transiently answer empty
  // right after another command; one short retry absorbs that.
  let tab = null as { targetId: string; url?: string } | null | undefined;
  for (let attempt = 0; attempt < 2 && !tab?.targetId; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 500));
    const tabs = engineTabs(o);
    // The session's own pinned tab first: `active` is the browser-wide
    // foreground tab, which another agent may be driving right now.
    const bound = o.session ? readBoundTarget(o.session) : null;
    tab = (bound ? tabs.find((t) => t.targetId === bound) : undefined) ?? tabs.find((t) => t.active) ?? tabs[0];
  }
  if (!tab?.targetId) {
    return { error: "this session has no tab", hint: "cast browser open <url> first" };
  }
  const browserUrl = o.cdp ?? state!.wsUrl ?? (await browserSocketUrl(state!.port, 8000));
  const conn = await CdpConnection.connect(browserUrl, 8000);
  try {
    const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: tab.targetId,
      flatten: true,
    });
    return { conn, sessionId, url: tab.url ?? "", targetId: tab.targetId, browserUrl };
  } catch (err) {
    conn.close();
    const message = (err as Error).message;
    // Chrome refused the debugger on the tab: a fresh tab is the way out.
    const hint = /Cannot attach to this target/i.test(message) ? "`cast browser stop`, then `cast browser open <url>` starts on a fresh tab" : undefined;
    return { error: `could not attach to this session's tab: ${message}`, hint };
  }
}

export interface EvalOutcome {
  ok: boolean;
  /** The JSON value exactly (what parsers and `--json` read), or the page's exception text. */
  output: string;
  /** The value as a person reads it (renderEvalForReading); absent on failure. */
  display?: string;
  hint?: string;
}

/** Render the settled value the way the engine did: JSON, one line unless big. */
export function renderEvalValue(result: { type?: string; value?: unknown; description?: string }): string {
  if (result.type === "undefined") return "undefined";
  if (result.value === undefined) {
    // Not serializable by value (a DOM node, a function): show its description.
    return result.description ?? String(result.value);
  }
  const json = JSON.stringify(result.value, null, undefined);
  return json ?? "undefined";
}

/**
 * The value as an agent reads it: a string prints as itself, so
 * `document.body.innerText` keeps its newlines and `JSON.stringify(x)` prints
 * the JSON once instead of quoted with every quote escaped. Anything else is
 * JSON, indented once it is too long to scan on one line. `--json` keeps the
 * exact encoding (renderEvalValue) for a caller that parses it.
 */
export function renderEvalForReading(result: { type?: string; value?: unknown; description?: string }): string {
  if (typeof result.value === "string") return result.value;
  const exact = renderEvalValue(result);
  if (result.value === null || typeof result.value !== "object" || exact.length <= 100) return exact;
  return JSON.stringify(result.value, null, 2);
}

/**
 * Run a script in this session's page and print its settled value. Promises
 * are awaited; `replMode` allows top-level `await` and re-declaring the same
 * `const` across calls (the DevTools-console semantics agents expect).
 */
export async function evalInPage(
  script: string,
  o: PageCtx,
  timeoutMs = 15_000,
): Promise<EvalOutcome> {
  const at = await connectToTab(o);
  if ("error" in at) return { ok: false, output: at.error, hint: at.hint };
  const { conn, sessionId } = at;
  try {
    return await evaluateOn(conn, sessionId, script, timeoutMs);
  } finally {
    conn.close();
  }
}

/**
 * The evaluate itself, against an attached page session. Shared by the
 * managed-browser path above and by `cast app`, which attaches to the desktop
 * app's own CDP port instead of a session tab.
 */
export async function evaluateOn(
  conn: CdpClient,
  sessionId: string,
  script: string,
  timeoutMs = 15_000,
): Promise<EvalOutcome> {
  try {
    const res = await conn.send<{
      result: { type?: string; value?: unknown; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      "Runtime.evaluate",
      {
        expression: script,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
        replMode: true,
        timeout: timeoutMs,
      },
      sessionId,
      timeoutMs + 5000,
    );
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails;
      return { ok: false, output: ex.exception?.description ?? ex.text ?? "the script threw" };
    }
    return { ok: true, output: renderEvalValue(res.result), display: renderEvalForReading(res.result) };
  } catch (err) {
    if (err instanceof CdpTimeout) {
      return {
        ok: false,
        output: `the script did not settle within ${timeoutMs}ms`,
        hint: "an unresolved promise or a blocked page — raise --timeout, or check what it awaits",
      };
    }
    return { ok: false, output: (err as CdpError).message };
  }
}

/**
 * The whole scroll height of this session's page as a PNG, through CDP's
 * captureBeyondViewport (no scroll-and-stitch, which double-fires lazy
 * loaders). What `shot --full` falls back to when the engine's own full-page
 * capture writes nothing, as it does over the extension bridge.
 */
export async function captureFullPage(o: PageCtx, timeoutMs = 30_000): Promise<{ png: Buffer } | { error: string }> {
  const at = await connectToTab(o);
  if ("error" in at) return { error: at.error };
  try {
    const res = await at.conn.send<{ data: string }>(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: true },
      at.sessionId,
      timeoutMs,
    );
    return res?.data ? { png: Buffer.from(res.data, "base64") } : { error: "the browser returned no image" };
  } catch (err) {
    return { error: (err as Error).message };
  } finally {
    at.conn.close();
  }
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/** The names agents write → CDP PermissionType. Unknown names pass through,
 *  so new CDP types work without a release. */
export const PERMISSION_NAMES: Record<string, string[]> = {
  camera: ["videoCapture"],
  microphone: ["audioCapture"],
  mic: ["audioCapture"],
  clipboard: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  notifications: ["notifications"],
  geolocation: ["geolocation"],
  midi: ["midi"],
};

export function toCdpPermissions(names: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) for (const p of PERMISSION_NAMES[n.toLowerCase()] ?? [n]) out.add(p);
  return [...out];
}

/**
 * Grant (or reset) permissions for an origin, browser-wide, no restart. The
 * prompt an agent cannot see simply never appears; `getUserMedia` resolves
 * with the real device. Machines without a camera/mic still need fake devices
 * at launch (`start --fake-media`).
 */
export async function grantPermissions(
  names: string[],
  o: PageCtx,
  opts: { origin?: string; reset?: boolean } = {},
): Promise<{ ok: boolean; output: string; hint?: string }> {
  const at = await connectToTab(o);
  if ("error" in at) return { ok: false, output: at.error, hint: at.hint };
  const { conn, url } = at;
  try {
    const origin = opts.origin ?? (url ? new URL(url).origin : undefined);
    if (opts.reset) {
      await conn.send("Browser.resetPermissions", {});
      return { ok: true, output: "permissions reset to defaults (all origins)" };
    }
    if (!origin) return { ok: false, output: "no origin to grant to", hint: "open a page first, or pass --origin" };
    const permissions = toCdpPermissions(names.length ? names : ["camera", "microphone"]);
    await conn.send("Browser.grantPermissions", { permissions, origin });
    return { ok: true, output: `granted ${permissions.join(", ")} for ${origin}` };
  } catch (err) {
    return { ok: false, output: (err as Error).message };
  } finally {
    conn.close();
  }
}
