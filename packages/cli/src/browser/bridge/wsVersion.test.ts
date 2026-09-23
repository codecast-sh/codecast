// The bridge host runs a WebSocket server on the loopback for the extension
// and CDP clients, so the ws copy it actually loads is what matters, not the
// range in package.json. GHSA-96hv-2xvq-fx4p (fragment memory exhaustion) is
// fixed in 8.21.0. This test reads the resolved module, so it is red until
// `bun install` has brought the lock's version into node_modules.
import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";

const MIN = [8, 21, 0] as const;

function atLeast(version: string, min: readonly [number, number, number]): boolean {
  const parts = version.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((parts[i] ?? 0) > min[i]) return true;
    if ((parts[i] ?? 0) < min[i]) return false;
  }
  return true;
}

describe("ws resolution", () => {
  it("loads a ws at or above 8.21.0 from the CLI's own dependency", () => {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve("ws");
    const { version } = require("ws/package.json") as { version: string };
    expect(atLeast(version, MIN), `${resolved} is ws ${version}`).toBe(true);
    // The declared dependency is what the lock resolves; the two must agree.
    const declared = (require("../../../package.json") as { dependencies: Record<string, string> }).dependencies.ws;
    expect(declared).toBe(version);
  });
});
