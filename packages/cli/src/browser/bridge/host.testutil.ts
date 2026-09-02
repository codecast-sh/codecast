/**
 * A bridge host for tests that need a PROVEN one: the pinned tab, the reaper
 * and the engine options all refuse a port that cannot answer the token
 * challenge (host.ts probeHost), so a written bridge.json alone is no longer
 * a reachable bridge. Writes the state file the code under test reads.
 */

import { freePort } from "../instance.js";
import { startBridgeHost, writeBridgeState, type RunningHost } from "./host.js";

export const TEST_TOKEN = "t".repeat(64);

export async function testBridgeHost(token = TEST_TOKEN): Promise<RunningHost & { token: string }> {
  const port = await freePort();
  const host = await startBridgeHost({ port, token });
  writeBridgeState({ port, token });
  return { ...host, token };
}
