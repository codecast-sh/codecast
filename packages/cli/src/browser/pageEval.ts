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

import { CdpConnection, CdpError, CdpTimeout, type CdpClient } from "./cdp.js";
import { readState } from "./instance.js";
import { engineTabs, type EngineOptions } from "./engine.js";

/** This session and the browser it drives (cliEngine.ts ctx). A bare
 *  session string is never accepted: runEngine would then guess the browser
 *  from the managed state file, and for a real session that guess makes the
 *  daemon rebind the session to the wrong Chrome. */
export type PageCtx = EngineOptions & { session: string };

/** This session's tab and a browser socket, or a human-readable refusal. */
export async function connectToTab(o: PageCtx): Promise<
  { conn: CdpConnection; sessionId: string; url: string } | { error: string; hint?: string }
> {
  const state = readState();
  if (!state) return { error: "no managed browser is running", hint: "cast browser start" };
  // The tab listing rides the engine daemon and can transiently answer empty
  // right after another command; one short retry absorbs that.
  let tab = null as { targetId: string; url?: string } | null | undefined;
  for (let attempt = 0; attempt < 2 && !tab?.targetId; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 500));
    const tabs = engineTabs(o);
    tab = tabs.find((t) => t.active) ?? tabs[0];
  }
  if (!tab?.targetId) {
    return { error: "this session has no tab", hint: "cast browser open <url> first" };
  }
  const conn = state.wsUrl
    ? await CdpConnection.connect(state.wsUrl, 8000)
    : await CdpConnection.fromPort(state.port, 8000);
  try {
    const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: tab.targetId,
      flatten: true,
    });
    return { conn, sessionId, url: tab.url ?? "" };
  } catch (err) {
    conn.close();
    return { error: `could not attach to this session's tab: ${(err as Error).message}` };
  }
}

export interface EvalOutcome {
  ok: boolean;
  /** What to print: the JSON value, or the page's exception text. */
  output: string;
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
    return { ok: true, output: renderEvalValue(res.result) };
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
