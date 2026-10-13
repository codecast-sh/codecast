/**
 * `ViewportCapture` for the agent-browser engine.
 *
 * The engine's own emulation verb (`set device`) covers eight phone names,
 * emulates no touch, and would make its preset list a second vocabulary next
 * to DEVICES. But the engine's Chrome still speaks CDP — `engineCdpEndpoint()`
 * finds the port Chrome wrote to DevToolsActivePort — so this adapter attaches
 * a page session over that port and reuses the built-in driver's capture
 * capability wholesale: identical DeviceProfile semantics (metrics, touch,
 * user agent), identical label chip, identical restore guarantee.
 *
 * The caller resolves the endpoint (that helper lives with the engine
 * transport) and passes the plain port + target id; this module owns only the
 * attach/release bracket around the capture.
 */

import { CdpConnection } from "./cdp.js";
import { attachToTarget } from "./instance.js";
import { pageViewportCapture, type ViewportCapture } from "./viewports.js";

export interface EngineTarget {
  /** Chrome's remote-debugging port, from DevToolsActivePort. */
  port: number;
  /** CDP target id of the tab to capture — the engine session's active tab. */
  targetId: string;
}

/**
 * Attach to the engine's tab and run `fn` with a `ViewportCapture` for it.
 * The connection closes when `fn` settles, success or not.
 */
export async function withEngineViewportCapture<T>(
  target: EngineTarget,
  fn: (cap: ViewportCapture) => Promise<T>,
): Promise<T> {
  const conn = await CdpConnection.fromPort(target.port);
  try {
    const page = await attachToTarget(conn, target.targetId);
    return await fn(pageViewportCapture(page));
  } finally {
    conn.close();
  }
}
