import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_EXTENSION_ID, BRIDGE_STORE_URL } from "./protocol";

async function setup(args: string[], connected = false) {
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
      openInRealChrome: (url) => { console.log("OPENED_EXTENSION_ID=" + new URL(url).host); return true; },
      discardPairingPage: () => {},
    }));
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
