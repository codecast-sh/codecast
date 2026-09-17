/**
 * The bridge's one recurring failure that is nobody's fault at the call
 * site: Chrome runs the extension's process at background priority, and on
 * a loaded Mac it is not scheduled for tens of seconds at a time. A request
 * that reaches it during such a freeze is answered the moment the process
 * runs again, so the right response to its timeout is to ask once more, not
 * to fail the command. Only failures from before the page was touched
 * qualify (a tab listing, a tab creation, an attach, a debugger step, a
 * storage read): running those again is safe. A timeout inside the page (an
 * eval, a wait) may have acted, and is not retried.
 */

import { fmt } from "../colors.js";

export function isStallFailure(output: string): boolean {
  if (!/did not answer within \d+m?s/.test(output)) return false;
  return /tabs\.list|tabs\.create|Target\.setDiscoverTargets|Target\.attachToTarget|Target\.createTarget|debugger\.attach|domain enable|storage\.session|Chrome tabs\.query|overlay install|\/grant|\battach\b/.test(output);
}

/**
 * The engine's own client gave up on its daemon while the daemon was waiting
 * on a frozen worker. The daemon may have carried the command out late, so
 * only a verb that changes nothing on the page is run again.
 */
export function isDaemonBusyFailure(output: string): boolean {
  return /daemon may be busy or unresponsive/.test(output);
}

export const READ_ONLY_VERBS = new Set(["open", "snapshot", "read", "get", "text", "find", "wait", "shot", "tabs", "tab", "url", "title", "diff", "status"]);

/** Whether a failed engine run of `verb` is safe and worth running once more. */
export function shouldRetryAfterStall(verb: string, output: string): boolean {
  return isStallFailure(output) || (isDaemonBusyFailure(output) && READ_ONLY_VERBS.has(verb));
}

/** How long to let the worker's process get scheduled before the one retry. */
export const STALL_RETRY_DELAY_MS = 3_000;

export const STALL_NOTE = "the Chrome extension did not answer in time (its process was not scheduled); trying once more…";

/**
 * Run `fn`; when it throws a stall failure, say so, wait, and run it once
 * more. Any other failure, and a second stall, propagate.
 */
export async function retryOnStall<T>(fn: () => Promise<T>, opts: { delayMs?: number; note?: (line: string) => void } = {}): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isStallFailure(String((err as Error)?.message ?? err))) throw err;
    (opts.note ?? ((line) => console.error(fmt.muted(`  ${line}`))))(STALL_NOTE);
    await new Promise((r) => setTimeout(r, opts.delayMs ?? STALL_RETRY_DELAY_MS));
    return await fn();
  }
}
