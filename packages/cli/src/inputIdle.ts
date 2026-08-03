import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Pull HIDIdleTime (nanoseconds) out of `ioreg` output and convert to ms.
 * Exported for tests; readInputIdleMs is the real entry point.
 */
export function parseHidIdleMs(ioregOutput: string): number | null {
  const m = ioregOutput.match(/"HIDIdleTime"\s*=\s*(\d+)/);
  if (!m) return null;
  const ns = Number(m[1]);
  if (!Number.isFinite(ns)) return null;
  return Math.round(ns / 1e6);
}

/**
 * Milliseconds since the last keyboard/mouse event on this machine's console,
 * or null when the platform can't report it.
 *
 * macOS only: IOHIDSystem's HIDIdleTime resets on any HID event and keeps
 * counting while the screen is locked, which is exactly "is a human at this
 * keyboard". Linux daemons (headless boxes) have no equivalent, so they report
 * nothing and — by design — never count as the user being present.
 */
// Async on purpose: this runs on every 30s heartbeat, and a synchronous spawn
// would stall the daemon's event loop — session watching, sync, websockets — for
// however long ioreg takes to answer (normally ~30ms, but it contends with IOKit
// under load, and the timeout is the real worst case).
export async function readInputIdleMs(): Promise<number | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync(
      "/usr/sbin/ioreg",
      ["-c", "IOHIDSystem", "-d", "4", "-r"],
      { encoding: "utf8", timeout: 5000 },
    );
    return parseHidIdleMs(stdout);
  } catch {
    return null;
  }
}
