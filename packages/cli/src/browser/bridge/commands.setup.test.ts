import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_EXTENSION_ID, BRIDGE_STORE_URL } from "./protocol";

let lastState: Record<string, any> | null = null;
let lastFragment: { keys: string[]; tokenIsState: boolean } | null = null;

/** What the profile reader answers: Alex's layout by default, the extension only in a profile Chrome did not use last. */
const ONE_PROFILE = {
  known: true,
  all: [
    { dir: "Default", name: "Personal", email: null, lastUsed: true },
    { dir: "Profile 2", name: "Work", email: "a@work.com", lastUsed: false },
  ],
  withExtension: [{ dir: "Profile 2", name: "Work", email: "a@work.com", lastUsed: false }],
};

/**
 * `connected`: the pairing completes (the profile shows up on the host). `live`: profiles already connected before setup runs.
 */
async function setup(args: string[], connected = false, profiles: unknown = ONE_PROFILE, initialState?: Record<string, unknown>, live: unknown[] = []) {
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
      bridgeStatus: async () => ({ extensionConnected: ${JSON.stringify(live)}.length > 0, profiles: ${JSON.stringify(live)} }),
      waitForPairedProfile: async () => (${connected} ? { id: "work-profile-2", name: "Work", dir: "Profile 2", default: true, legacy: false, version: "0.1.3", protocol: 4, connectedAt: 1, sessions: 0 } : null),
    }));
    const chrome = await import(${modulePath("realChrome.ts")});
    mock.module(${modulePath("realChrome.ts")}, () => ({
      ...chrome,
      openInRealChrome: (url, profileArgs = []) => {
        console.log("OPENED_EXTENSION_ID=" + new URL(url).host);
        console.log("OPENED_URL=" + url.split("#")[0] + " PROFILE_ARGS=" + JSON.stringify(profileArgs));
        const frag = new URLSearchParams(url.split("#")[1] ?? "");
        globalThis.__openedFragment = { keys: [...frag.keys()], tokenIsState: frag.get("token") === host.readBridgeState()?.token };
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
    if (globalThis.__openedFragment) (await import("node:fs")).writeFileSync(process.env.CODECAST_DIR + "/opened-fragment.json", JSON.stringify(globalThis.__openedFragment));
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
    const fragPath = join(dir, "opened-fragment.json");
    lastFragment = existsSync(fragPath) ? JSON.parse(readFileSync(fragPath, "utf8")) : null;
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

test("explicit manual pairing returns a one-time code and its URL, never the token", async () => {
  const result = JSON.parse(await setup(["--json", "--show-code"]));
  const url = new URL(result.url);
  expect(url.host).toBe(BRIDGE_EXTENSION_ID);
  expect(result.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  expect(new URLSearchParams(url.hash.slice(1)).get("code")).toBe(result.code);
  expect(result.token).toBeUndefined();
  expect(url.hash).not.toContain("token");
});

test("successful pairing reports connection without falling back to install instructions", async () => {
  const out = await setup([], true);
  expect(out).toContain(`OPENED_EXTENSION_ID=${BRIDGE_EXTENSION_ID}`);
  expect(out).toContain("paired work-profile-2 (v0.1.3, protocol 4)");
  expect(out).not.toContain("did not connect");
  expect(out).not.toMatch(/[a-f0-9]{64}|#token=/);
});

// 2026-10-29: Chrome opened the pairing page in its last-used profile, which
// had no extension, and showed chrome-extension://invalid.
test("pairing opens in the profile that has the extension, not Chrome's last-used one", async () => {
  const out = await setup([], true);
  expect(out).toContain(`OPENED_URL=chrome-extension://${BRIDGE_EXTENSION_ID}/options.html PROFILE_ARGS=["--profile-directory=Profile 2"]`);
  expect(out).toContain(`default Chrome profile: "Work" (a@work.com, Profile 2)`);
  expect(lastState?.profile).toBe("Profile 2");
});

test("with no profile holding the extension, setup opens the setup page for this machine and never an extension page", async () => {
  const out = await setup([], false, { ...ONE_PROFILE, withExtension: [] });
  expect(out).not.toContain("OPENED_URL=chrome-extension://");
  expect(out).toMatch(/OPENED_URL=https:\/\/[^ ]+\/setup\/browser\?device=[0-9a-f]+ PROFILE_ARGS=\["--profile-directory=Default"\]/);
  expect(out).toContain("not installed in any Chrome profile");
});

test("--profile naming a profile without the extension sends that profile to the setup page", async () => {
  const out = await setup(["--profile", "personal"], false);
  expect(out).not.toContain("OPENED_URL=chrome-extension://");
  expect(out).toMatch(/OPENED_URL=\S+\/setup\/browser\S* PROFILE_ARGS=\["--profile-directory=Default"\]/);
  expect(out).toContain('cast browser extension setup --profile "personal"');
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

test("pairing another profile makes it the default and leaves the first one paired (no token rotation)", async () => {
  const both = { ...ONE_PROFILE, withExtension: ONE_PROFILE.all };
  const out = await setup(["--profile", "Personal"], true, both, { profile: "Profile 2", extensionSeenAt: 1 });
  expect(out).toContain(`PROFILE_ARGS=["--profile-directory=Default"]`);
  expect(lastState?.token).toBe("a".repeat(64));
  expect(lastState?.profile).toBe("Default");
});

test("a profile that is already connected is only made the default; no pairing page opens", async () => {
  const both = { ...ONE_PROFILE, withExtension: ONE_PROFILE.all };
  const live = [{ id: "personal-default", name: "Personal", dir: "Default", default: false, legacy: false, connectedAt: 1, sessions: 0 }];
  const out = await setup(["--profile", "Personal"], false, both, { profile: "Profile 2", extensionSeenAt: 1 }, live);
  expect(out).not.toContain("OPENED_URL=");
  expect(out).toContain("personal-default is paired and connected; new sessions use it by default");
  expect(lastState?.profile).toBe("Default");
});

// The Chrome Web Store's 0.1.5 reads only #token=&port= (rig, 2026-11-07): the page opened in
// Chrome carries the shared token beside the code until no extension below code pairing connects.
test("the pairing page opened in Chrome carries the code and the legacy token; the terminal shows neither token", async () => {
  const out = await setup([], true);
  expect(lastFragment).toEqual({ keys: ["code", "token", "port"], tokenIsState: true });
  expect(out).not.toMatch(/[a-f0-9]{64}|#token=/);
});
