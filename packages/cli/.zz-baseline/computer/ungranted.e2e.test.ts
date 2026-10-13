/**
 * `cast computer` against the REAL built helper, with nothing granted (A7,
 * ct-49523).
 *
 * This is the half that needs a Mac and a compiled bundle but no TCC grant, so
 * it is the half a CI runner can carry. What it proves that a fake helper
 * cannot: the bundle `build-with-native.ts` produces is the bundle
 * `materializeHelperApp` accepts, the two-rename swap survives being killed on a
 * bundle with a real signature, the version handshake refuses a mismatch, and
 * every verb that needs Accessibility says exactly what to do about not having
 * it.
 *
 * It self-skips unless `CODECAST_COMPUTER_HELPER_TAR` names a built payload:
 *
 *   bun scripts/computer-verify.ts build --out /tmp/helper.tar
 *   CODECAST_COMPUTER_HELPER_TAR=/tmp/helper.tar bun test src/computer/ungranted.e2e.test.ts
 *
 * Every test runs in a CODECAST_DIR of its own, rooted at /tmp. Not for tidiness:
 * macOS gives each user a temp directory six levels deep, and a helper socket
 * under one exceeds the 104-byte `sun_path` limit. A bundle at a temp path is
 * also a different app to TCC, which is what keeps "ungranted" true here even on
 * the machine that granted the real one.
 *
 * Timeouts are generous throughout. Launching the helper means a disclaimed
 * spawn, a universal binary's start and a socket handshake, and the prepare lock
 * serialises those across tests — seconds each, against bun's 5-second default.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "../proc.js";
import { ComputerClient } from "./client.js";
import {
  HELPER_APP_BASENAME,
  helperAppPath,
  helperExecutablePath,
  inspectSignature,
  readInstallStamp,
  repairHalfSwap,
  swapIntoPlace,
} from "./helperApp.js";
import { readInstance } from "./instance.js";
import { COMPUTER_PROTOCOL_VERSION } from "./types.js";
import { disclaimedHelperLaunch, probeHelperPermissions } from "../test-helpers/computerPermissionProbe.js";

const TAR = process.env.CODECAST_COMPUTER_HELPER_TAR;
const enabled = process.platform === "darwin" && !!TAR && fs.existsSync(TAR);
const e2e = enabled ? test : test.skip;
const LAUNCH_TIMEOUT_MS = 120_000;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

beforeAll(() => {
  if (!enabled) {
    console.log("computer ungranted e2e skipped: set CODECAST_COMPUTER_HELPER_TAR to a payload from `bun scripts/computer-verify.ts build`");
  }
});

/** A CODECAST_DIR of this test's own, restored afterwards. */
function isolatedHome(): string {
  const dir = fs.mkdtempSync(path.join("/tmp", "cast-computer-ungranted-"));
  const previous = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = dir;
  cleanups.push(() => {
    if (previous === undefined) delete process.env.CODECAST_DIR;
    else process.env.CODECAST_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Unpack the payload into a staging directory, the way materialization does. */
function stageBundle(root: string): { stagingDir: string; stagedApp: string } {
  const stagingDir = fs.mkdtempSync(path.join(root, "staging-"));
  const extract = spawnSync("/usr/bin/tar", ["-xf", TAR!, "-C", stagingDir], { encoding: "utf8", timeout: 120_000 });
  expect(extract.status, extract.stderr ?? "").toBe(0);
  return { stagingDir, stagedApp: path.join(stagingDir, HELPER_APP_BASENAME) };
}

function payloadSha(): string {
  return createHash("sha256").update(fs.readFileSync(TAR!)).digest("hex");
}

/**
 * A client pointed at the bundle at the current fixed path.
 *
 * `defaultHelperLaunch` cannot be used: it insists on a payload embedded in the
 * running CLI, which a from-source run does not carry, even with a valid helper
 * already installed (ct-49672). `disclaimedHelperLaunch` also resolves the
 * disclaim wrapper from the package rather than from argv, which under `bun
 * test` points at a file that does not exist (ct-49674).
 */
function clientForFixedPath(version?: string): ComputerClient {
  const client = new ComputerClient({
    version,
    helperLaunch: (socketPath, tokenPath) =>
      disclaimedHelperLaunch(helperExecutablePath(), ["--agent", socketPath, "--token-file", tokenPath]),
  });
  cleanups.push(() => {
    const state = readInstance();
    void client.shutdown();
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

function installAtFixedPath(root: string, version?: string): void {
  const { stagingDir, stagedApp } = stageBundle(root);
  swapIntoPlace(stagedApp, stagingDir, { sha256: payloadSha(), version });
  fs.rmSync(stagingDir, { recursive: true, force: true });
}

describe("the bundle the build produces", () => {
  e2e("is universal, identifies as sh.codecast.computer, and verifies strictly", () => {
    const root = isolatedHome();
    const { stagedApp } = stageBundle(root);
    const info = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", stagedApp], { encoding: "utf8" });
    expect(`${info.stderr ?? ""}${info.stdout ?? ""}`).toContain("Identifier=sh.codecast.computer");
    expect(spawnSync("/usr/bin/lipo", ["-archs", helperExecutablePath(stagedApp)], { encoding: "utf8" }).stdout).toContain("arm64");
    expect(spawnSync("/usr/bin/codesign", ["--verify", "--strict", stagedApp], { encoding: "utf8" }).status).toBe(0);
  });

  e2e("is accepted by the materialization that ships it", () => {
    // The regression test for ct-49662. `spctl --assess` rejects a Developer ID
    // bundle that was never notarized, and codecast notarizes nothing, so the
    // gate used to grade every release build `invalid` while the ad-hoc
    // from-source build passed on an earlier return. Only a Developer ID build
    // exercises it: run this lane's build with CODECAST_SIGN_IDENTITY set.
    const root = isolatedHome();
    const { stagedApp } = stageBundle(root);
    const verdict = inspectSignature(stagedApp);
    expect(verdict.signature, verdict.detail).not.toBe("invalid");
  });
});

describe("the swap, on a real bundle", () => {
  e2e(
    "survives being killed between the two renames, and the repaired helper still handshakes",
    async () => {
      const root = isolatedHome();
      installAtFixedPath(root);
      expect(fs.statSync(helperExecutablePath()).isFile()).toBe(true);

      // Reproduce the kill in the one window where the fixed path holds nothing.
      const { stagingDir, stagedApp } = stageBundle(root);
      expect(() =>
        swapIntoPlace(stagedApp, stagingDir, {
          sha256: payloadSha(),
          betweenRenames: () => {
            throw new Error("killed between the renames");
          },
        }),
      ).toThrow();
      expect(fs.existsSync(helperAppPath())).toBe(false);

      // The staged copy already passed verification, so repair rolls FORWARD.
      expect(repairHalfSwap()).toBe("completed");
      expect(fs.statSync(helperExecutablePath()).isFile()).toBe(true);
      // The stamp is deliberately dropped: this process never saw the payload
      // the staged bundle came from, and a wrong stamp costs a wrong bundle
      // forever.
      expect(readInstallStamp()).toBeNull();

      // The repaired bytes are a working helper, not just a directory of the
      // right shape. This is what a unit test with a fake bundle cannot say.
      const caps = await clientForFixedPath().capabilities();
      expect(caps.protocolVersion).toBe(COMPUTER_PROTOCOL_VERSION);
      expect(caps.provider).toBe("codecast-computer-macos");
    },
    LAUNCH_TIMEOUT_MS,
  );

  e2e("a matching stamp is what makes the next materialization a no-op", () => {
    const root = isolatedHome();
    installAtFixedPath(root);
    const before = fs.statSync(helperExecutablePath()).ino;
    // `materializeHelperApp` reads the EMBEDDED payload, which is empty from
    // source, so it cannot be called here (ct-49672). The comparison it makes
    // is the assertion: same hash, same bundle, nothing to do.
    expect(readInstallStamp()?.sha256).toBe(payloadSha());
    expect(fs.statSync(helperExecutablePath()).ino).toBe(before);
  });
});

describe("the helper, with nothing granted", () => {
  e2e(
    "answers both grants about itself",
    async () => {
      const root = isolatedHome();
      installAtFixedPath(root);
      const status = await probeHelperPermissions("disclaimed");
      // That both are ANSWERED is the point; which way depends on the machine.
      expect(["granted", "not-granted"]).toContain(status.accessibility);
      expect(["granted", "not-granted"]).toContain(status.screenshots);
    },
    LAUNCH_TIMEOUT_MS,
  );

  e2e(
    "refuses a helper from another release instead of driving it",
    async () => {
      const root = isolatedHome();
      installAtFixedPath(root);
      // The mismatch is made on the CLI's side, not the bundle's. Editing the
      // Info.plist would change the version AND invalidate the signature, and
      // the launch would then fail for the wrong reason.
      const failure = await clientForFixedPath("0.0.0-not-this-release")
        .capabilities()
        .then(
          () => null,
          (err) => err as { code: string; message: string },
        );
      expect(failure).not.toBeNull();
      expect(failure!.code).toBe("provider_incompatible");
      // Both versions in the message: an agent that only sees "incompatible"
      // cannot tell an old helper from a new one.
      expect(failure!.message).toContain("0.0.0-not-this-release");
      expect(failure!.message).toMatch(/reports version \d+\.\d+\.\d+/);
    },
    LAUNCH_TIMEOUT_MS,
  );

  e2e(
    "answers list-apps, which needs no Accessibility grant",
    async () => {
      const root = isolatedHome();
      installAtFixedPath(root);
      const apps = await clientForFixedPath().listApps();
      expect(apps.apps.length).toBeGreaterThan(0);
      expect(apps.apps.some((app) => typeof app.bundleId === "string" && app.pid > 0)).toBe(true);
    },
    LAUNCH_TIMEOUT_MS,
  );

  e2e(
    "blocks a password manager by bundle id before it looks at anything else",
    async () => {
      const root = isolatedHome();
      installAtFixedPath(root);
      const failure = await clientForFixedPath()
        .getAppState({ app: "com.1password.1password" })
        .then(
          () => null,
          (err) => err as { code: string; message: string },
        );
      expect(failure).not.toBeNull();
      expect(failure!.code).toBe("app_blocked");
      expect(failure!.message).toContain("blocked for safety");
    },
    LAUNCH_TIMEOUT_MS,
  );

  e2e(
    "tells an agent the exact fix on every verb that needs the grant",
    async () => {
      const root = isolatedHome();
      installAtFixedPath(root);
      const status = await probeHelperPermissions("disclaimed");
      if (status.accessibility === "granted") {
        // A bundle at a temp path is a different app to TCC, so this should not
        // happen — but a machine that granted this exact path would make the
        // assertions below meaningless rather than wrong.
        console.log("ungranted e2e: this copy is granted, so the refusal path cannot be exercised");
        return;
      }
      const client = clientForFixedPath();
      const attempts: Array<[string, () => Promise<unknown>]> = [
        ["getAppState", () => client.getAppState({ app: "com.apple.Finder" })],
        ["click", () => client.action("click", { app: "com.apple.Finder", elementIndex: 1 })],
        ["setValue", () => client.action("setValue", { app: "com.apple.Finder", elementIndex: 1, value: "x" })],
        ["typeText", () => client.action("typeText", { app: "com.apple.Finder", text: "x" })],
        ["pressKey", () => client.action("pressKey", { app: "com.apple.Finder", key: "Return" })],
        ["hotkey", () => client.action("hotkey", { app: "com.apple.Finder", key: "CmdOrCtrl+A" })],
        ["pasteText", () => client.action("pasteText", { app: "com.apple.Finder", text: "x" })],
        ["scroll", () => client.action("scroll", { app: "com.apple.Finder", direction: "down", elementIndex: 1 })],
        ["performSecondaryAction", () => client.action("performSecondaryAction", { app: "com.apple.Finder", elementIndex: 1, action: "AXPress" })],
      ];
      for (const [name, attempt] of attempts) {
        const failure = await attempt().then(
          () => null,
          (err) => err as { code: string; message: string },
        );
        expect(failure, `${name} should refuse without Accessibility`).not.toBeNull();
        expect(failure!.code, name).toBe("permission_denied");
        // The message has to carry the fix, not just the diagnosis. An agent
        // reading "permission_denied" with no next step retries unchanged.
        expect(failure!.message, name).toContain("Accessibility");
        expect(failure!.message, name).toContain("cast computer permissions");
      }
    },
    LAUNCH_TIMEOUT_MS,
  );
});
