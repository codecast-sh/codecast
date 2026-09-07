/**
 * The client against the REAL Swift helper (ct-49519).
 *
 * Skipped unless `CODECAST_COMPUTER_HELPER_APP` names a built bundle, because
 * the helper is compiled by a separate workstream and needs a macOS machine
 * with Accessibility granted to it:
 *
 *   CODECAST_COMPUTER_HELPER_APP="$HOME/.codecast/computer/codecast computer.app" \
 *     bun test src/computer/computer.e2e.test.ts
 *
 * What it proves that the fake helper cannot: the wire shapes agree, the
 * protocol version agrees, the socket path fits `sun_path`, and the helper
 * answers a real accessibility query.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ComputerClient } from "./client.js";
import { getPermissionStatus } from "./permissions.js";
import { helperAppPath, helperExecutablePath } from "./helperApp.js";
import { readInstance } from "./instance.js";
import { COMPUTER_PROTOCOL_VERSION } from "./types.js";
import { resolveCastInvocation } from "../castInvocation.js";

const HELPER_APP = process.env.CODECAST_COMPUTER_HELPER_APP;
const enabled = process.platform === "darwin" && !!HELPER_APP && fs.existsSync(HELPER_APP);
const e2e = enabled ? test : test.skip;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

/**
 * Point CODECAST_DIR at a temp home and install the built bundle at the fixed
 * path inside it, so the run touches the real materialization layout without
 * disturbing the machine's own grant.
 */
function isolatedHomeWithHelper(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-computer-e2e-"));
  const prev = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = dir;
  cleanups.push(() => {
    if (prev === undefined) delete process.env.CODECAST_DIR;
    else process.env.CODECAST_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.dirname(helperAppPath()), { recursive: true, mode: 0o700 });
  fs.cpSync(HELPER_APP!, helperAppPath(), { recursive: true, verbatimSymlinks: true });
}

function realClient(): ComputerClient {
  const cast = resolveCastInvocation();
  const client = new ComputerClient({
    helperLaunch: (socketPath, tokenPath) => ({
      cmd: cast.cmd,
      args: [...cast.prefixArgs, "_disclaimed", "--", helperExecutablePath(), "--agent", socketPath, "--token-file", tokenPath],
    }),
  });
  cleanups.push(() => {
    const state = readInstance();
    client.shutdown();
    if (state?.pid) {
      try {
        process.kill(state.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });
  return client;
}

beforeAll(() => {
  if (!enabled) console.log("computer e2e skipped: set CODECAST_COMPUTER_HELPER_APP to a built `codecast computer.app`");
});

describe("cast computer against the built helper", () => {
  e2e("handshakes at the protocol version this CLI requires", async () => {
    isolatedHomeWithHelper();
    const caps = await realClient().capabilities();
    expect(caps.protocolVersion).toBe(COMPUTER_PROTOCOL_VERSION);
    expect(caps.platform).toBe("darwin");
    // v1 ships no drag and no window focus verb, by design.
    expect(caps.supports.actions.drag).toBe(false);
    expect(caps.supports.windows.focus).toBe(false);
  });

  e2e("lists running apps with bundle ids", async () => {
    isolatedHomeWithHelper();
    const result = await realClient().listApps();
    expect(result.apps.length).toBeGreaterThan(0);
    expect(result.apps.some((app) => typeof app.bundleId === "string" && app.pid > 0)).toBe(true);
  });

  e2e("a second client reuses the helper the first one launched", async () => {
    isolatedHomeWithHelper();
    const first = realClient();
    await first.capabilities();
    const pid = readInstance()!.pid;
    first.shutdown();

    await realClient().capabilities();
    expect(readInstance()!.pid).toBe(pid);
  });

  e2e("reads its own permission state through the helper", async () => {
    isolatedHomeWithHelper();
    const status = await getPermissionStatus();
    expect(status.helperUnavailableReason).toBeNull();
    expect(status.permissions.map((p) => p.id)).toEqual(["accessibility", "screenshots"]);
    // Whether they are granted depends on the machine; that both are ANSWERED
    // is what proves the probe read the helper's own identity.
    for (const p of status.permissions) expect(["granted", "not-granted"]).toContain(p.status);
  });
});
