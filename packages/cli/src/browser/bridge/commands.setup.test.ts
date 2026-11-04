import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_EXTENSION_ID, BRIDGE_STORE_URL } from "./protocol";

let lastState: Record<string, any> | null = null;

/** What the profile reader answers: Alex's layout by default, the extension only in a profile Chrome did not use last. */
const ONE_PROFILE = {
  known: true,
  all: [
    { dir: "Default", name: "Personal", email: null, lastUsed: true },
    { dir: "Profile 2", name: "Work", email: "a@work.com", lastUsed: false },
  ],
  withExtension: [{ dir: "Profile 2", name: "Work", email: "a@work.com", lastUsed: false }],
};

async function setup(args: string[], connected = false, profiles: unknown = ONE_PROFILE, initialState?: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "cast-store-setup-"));
  const modulePath = (name: string) => JSON.stringify(join(import.meta.dir, name));
  const script = `
    import { mock } from "bun:test";
    import { Command } from "commander";
    const host = await import(${modulePath("host.ts")});
    mock.module(${modulePath("host.ts")}, () => ({
      ...host,
      ensureBridgeHost: async () => ({ ...host.ensureBridgeConfig(), proven: true }),
      waitForExtension: async () => ({ extensionConnected: ${connected}, extensionVersion: "0.1.3", extensionProtocol: 4 }),
    }));
    const chrome = await import(${modulePath("realChrome.ts")});
    mock.module(${modulePath("realChrome.ts")}, () => ({
      ...chrome,
      openInRealChrome: (url, profileArgs = []) => {
        console.log("OPENED_EXTENSION_ID=" + new URL(url).host);
        console.log("OPENED_URL=" + url.split("#")[0] + " PROFILE_ARGS=" + JSON.stringify(profileArgs));
        return true;
      },
      settlePairingPage: () => {},
    }));
    const profiles = await import(${modulePath("chromeProfiles.ts")});
    mock.module(${modulePath("chromeProfiles.ts")}, () => ({ ...profiles, extensionProfiles: () => (${JSON.stringify(profiles)}) }));
    ${initialState ? `host.writeBridgeState({ port: 41999, token: "a".repeat(64), ...${JSON.stringify(initialState)} });` : ""}
    const { registerBridgeCommands } = await import(${modulePath("commands.ts")});
    const program = new Command();
    registerBridgeCommands(program.command("browser"), { me: () => null });
    await program.parseAsync(["bun", "cast", "browser", "extension", "setup", ...${JSON.stringify(args)}]);
  `;
  try {
    const stdout = join(dir, "stdout.log");
    const stderr = join(dir, "stderr.log");
    writeFileSync(stdout, "");
    writeFileSync(stderr, "");
    const proc = Bun.spawn([process.execPath, "--eval", script], {
      cwd: import.meta.dir,
      env: { ...process.env, CODECAST_DIR: dir, NO_COLOR: "1" },
      stdout: Bun.file(stdout), stderr: Bun.file(stderr),
    });
    const code = await proc.exited;
    expect(code, readFileSync(stderr, "utf8")).toBe(0);
    const statePath = join(dir, "browser", "bridge.json");
    lastState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
    return readFileSync(stdout, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("setup without an installed extension points to the store without exposing its token", async () => {
  const out = await setup([]);
  expect(out).toContain(`OPENED_EXTENSION_ID=${BRIDGE_EXTENSION_ID}`);
  expect(out).toContain(BRIDGE_STORE_URL);
  expect(out).toContain("Chrome Web Store");
  expect(out).not.toMatch(/Load unpacked|Developer mode|packages\/browser-extension/);
  expect(out).not.toMatch(/[a-f0-9]{64}|#token=/);
});

test("machine-readable setup returns the store identity without opening Chrome or exposing the token", async () => {
  const out = await setup(["--json"]);
  const result = JSON.parse(out);
  expect(result.extensionId).toBe(BRIDGE_EXTENSION_ID);
  expect(result.storeUrl).toBe(BRIDGE_STORE_URL);
  expect(result.tokenFile).toEndWith("bridge.json");
  expect(result.token).toBeUndefined();
  expect(result.url).toBeUndefined();
});

test("explicit manual pairing returns a URL for the store extension", async () => {
  const result = JSON.parse(await setup(["--json", "--show-token"]));
  const url = new URL(result.url);
  expect(url.host).toBe(BRIDGE_EXTENSION_ID);
  expect(new URLSearchParams(url.hash.slice(1)).get("token")).toBe(result.token);
});

test("successful pairing reports connection without falling back to install instructions", async () => {
  const out = await setup([], true);
  expect(out).toContain(`OPENED_EXTENSION_ID=${BRIDGE_EXTENSION_ID}`);
  expect(out).toContain("extension connected (v0.1.3, protocol 4)");
  expect(out).not.toContain("did not connect");
});

// 2026-10-29: Chrome opened the pairing page in its last-used profile, which
// had no extension, and showed chrome-extension://invalid.
test("pairing opens in the profile that has the extension, not Chrome's last-used one", async () => {
  const out = await setup([], true);
  expect(out).toContain(`OPENED_URL=chrome-extension://${BRIDGE_EXTENSION_ID}/options.html PROFILE_ARGS=["--profile-directory=Profile 2"]`);
  expect(out).toContain(`Chrome profile: "Work" (a@work.com, Profile 2)`);
  expect(lastState?.profile).toBe("Profile 2");
});

test("with no profile holding the extension, setup opens the Web Store and never an extension page", async () => {
  const out = await setup([], false, { ...ONE_PROFILE, withExtension: [] });
  expect(out).not.toContain("OPENED_URL=chrome-extension://");
  expect(out).toContain(`OPENED_URL=${BRIDGE_STORE_URL} PROFILE_ARGS=["--profile-directory=Default"]`);
  expect(out).toContain("not installed in any Chrome profile");
});

test("--profile naming a profile without the extension sends that profile to the store", async () => {
  const out = await setup(["--profile", "personal"], false);
  expect(out).not.toContain("OPENED_URL=chrome-extension://");
  expect(out).toContain(`OPENED_URL=${BRIDGE_STORE_URL} PROFILE_ARGS=["--profile-directory=Default"]`);
});

test("several profiles: the pinned one is paired and the others are named", async () => {
  const both = {
    ...ONE_PROFILE,
    withExtension: ONE_PROFILE.all,
  };
  const out = await setup([], true, both, { profile: "Profile 2", extensionSeenAt: 1 });
  expect(out).toContain(`PROFILE_ARGS=["--profile-directory=Profile 2"]`);
  expect(out).toContain(`also installed in "Personal" (Default)`);
  expect(out).not.toContain("new token: the pairing moves");
});

test("moving the pairing to another profile rotates the token so the old profile stops connecting", async () => {
  const both = { ...ONE_PROFILE, withExtension: ONE_PROFILE.all };
  const out = await setup(["--profile", "Personal"], true, both, { profile: "Profile 2", extensionSeenAt: 1 });
  expect(out).toContain(`PROFILE_ARGS=["--profile-directory=Default"]`);
  expect(out).toContain("new token: the pairing moves");
  expect(lastState?.token).not.toBe("a".repeat(64));
  expect(lastState?.profile).toBe("Default");
});
