import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { buildComputerHelper } from "../../scripts/build-with-native.js";

// Drives the real helper over its real socket: build it, unpack the embedded
// payload the way the CLI will, launch it against TextEdit, and run the loop.
// The tree half needs Accessibility, which only a human can grant, so it says
// so and stops rather than passing on a permission error.
describe.skipIf(process.platform !== "darwin")("computer helper", () => {
  const version = "0.0.0-e2e";
  let base: string;
  let app: string;
  let socketPath: string;
  let helper: ChildProcess;
  let client: Client;
  let accessibilityGranted = false;
  let startedTextEdit = false;
  let token: string;

  beforeAll(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-computer-e2e-")));
    const tar = path.join(base, "computer-helper.tar");
    expect(buildComputerHelper({ stage: path.join(base, "stage"), output: tar, universal: false, version })).toBeGreaterThan(0);

    // Unpack exactly as the CLI materializes it, so the test covers the payload
    // and not just the staged build directory.
    const materialized = path.join(base, "materialized");
    fs.mkdirSync(materialized, { recursive: true, mode: 0o700 });
    checked("/usr/bin/tar", ["-xf", tar, "-C", materialized]);
    app = path.join(materialized, "codecast computer.app");
    expect(fs.existsSync(path.join(app, "Contents/MacOS/codecast-computer"))).toBe(true);
    checked("/usr/bin/codesign", ["--verify", "--strict", app]);

    accessibilityGranted = readPermission("accessibility") === "granted";

    const document = path.join(base, "codecast computer e2e.txt");
    fs.writeFileSync(document, "before\n");
    startedTextEdit = spawnSync("/usr/bin/pgrep", ["-x", "TextEdit"]).status !== 0;
    checked("/usr/bin/open", ["-a", "TextEdit", document]);
    await settle(2000);

    const socketDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codecast-computer-")));
    fs.chmodSync(socketDir, 0o700);
    socketPath = path.join(socketDir, "helper.sock");
    const tokenPath = path.join(socketDir, "helper.token");
    token = randomBytes(32).toString("hex");
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    helper = spawn(path.join(app, "Contents/MacOS/codecast-computer"), ["--agent", socketPath, "--token-file", tokenPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    helper.stderr?.on("data", (chunk) => console.error(`helper: ${chunk}`));
    client = await connect(socketPath, token);
  }, 600_000);

  afterAll(() => {
    client?.close();
    helper?.kill();
    // Only tear down a TextEdit this test started, and take it down hard: the
    // set-value above leaves the document dirty, and a polite quit would ask the
    // human to save. A TextEdit that was already running is theirs, untouched.
    if (startedTextEdit) spawnSync("/usr/bin/pkill", ["-9", "-x", "TextEdit"]);
    fs.rmSync(base, { recursive: true, force: true });
  });

  test("the handshake reports this build and protocol version 1", async () => {
    const result = await client.call("handshake");

    expect(result.ok).toBe(true);
    expect(result.result.protocolVersion).toBe(1);
    expect(result.result.providerVersion).toBe(version);
    expect(result.result.provider).toBe("codecast-computer-macos");
    expect(result.result.supports.actions.drag).toBe(false);
    expect(result.result.supports.windows.focus).toBe(false);
  });

  test("a wrong token is refused", async () => {
    const result = await client.call("handshake", {}, "not-the-token");

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("permission_denied");
    expect(result.error.message).toBe("invalid computer agent token");
  });

  test("an unknown method names itself", async () => {
    const result = await client.call("nonsense");

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("invalid_argument");
    expect(result.error.message).toBe("unknown method 'nonsense'");
  });

  test("listApps finds the TextEdit this test opened", async () => {
    const result = await client.call("listApps");
    const textEdit = result.result.apps.find((entry: { bundleId: string | null }) => entry.bundleId === "com.apple.TextEdit");

    expect(textEdit.name).toBe("TextEdit");
    expect(textEdit.pid).toBeGreaterThan(0);
  });

  test("listWindows returns the document window", async () => {
    const result = await client.call("listWindows", { app: "com.apple.TextEdit" });

    expect(result.ok).toBe(true);
    expect(result.result.windows.length).toBeGreaterThan(0);
    expect(result.result.windows[0].id).toBeGreaterThan(0);
    expect(result.result.windows[0].width).toBeGreaterThan(0);
  });

  test("a password manager is refused before anything is read", async () => {
    const result = await client.call("getAppState", { app: "com.1password.1password" });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("app_blocked");
    expect(result.error.message).toBe("app 'com.1password.1password' is blocked for safety");
  });

  test("an unknown app is app_not_found", async () => {
    const result = await client.call("getAppState", { app: "com.example.NotRunning" });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("app_not_found");
  });

  test("get-app-state, set-value and read back", async () => {
    if (!accessibilityGranted) {
      // A human grants Accessibility; nothing here can. Assert the contract the
      // agent actually meets in that state rather than passing on silence.
      const denied = await client.call("getAppState", { app: "com.apple.TextEdit", noScreenshot: true });
      expect(denied.ok).toBe(false);
      expect(denied.error.code).toBe("permission_denied");
      expect(denied.error.message).toContain("cast computer permissions --id accessibility");
      console.warn("Accessibility is not granted to this build of the helper, so the tree half of the loop did not run.");
      return;
    }

    const state = await client.call("getAppState", { app: "com.apple.TextEdit", noScreenshot: true });
    expect(state.ok).toBe(true);
    expect(state.result.snapshot.coordinateSpace).toBe("window");
    expect(state.result.snapshot.treeText).toContain("App=com.apple.TextEdit");
    expect(state.result.snapshot.elementCount).toBeGreaterThan(0);
    expect(state.result.screenshotStatus.state).toBe("skipped");

    const textArea = elementIndexOf(state.result.snapshot.treeText, "text entry area");
    expect(textArea).not.toBeNull();

    const written = await client.call("setValue", {
      app: "com.apple.TextEdit",
      elementIndex: textArea,
      value: "written by the codecast computer e2e",
      noScreenshot: true,
    });
    expect(written.ok).toBe(true);
    expect(written.result.action.path).toBe("accessibility");
    expect(written.result.action.verification.state).toBe("verified");
    expect(written.result.action.verification.property).toBe("value");
    expect(written.result.snapshot.treeText).toContain("written by the codecast computer e2e");

    const stale = await client.call("setValue", {
      app: "com.apple.TextEdit",
      elementIndex: 9_999,
      value: "never",
      noScreenshot: true,
    });
    expect(stale.ok).toBe(false);
    expect(stale.error.code).toBe("element_not_found");
  }, 120_000);

  // Orca's helper exits on the last hang up. Codecast's CLI is a fresh process
  // per command, so exiting there would empty the element cache before the
  // next command could use an index it just handed out.
  test("a hang up leaves the helper running and the session reclaimable", async () => {
    client.close();
    await settle(3000);

    expect(helper.exitCode).toBeNull();

    client = await connect(socketPath, token);
    const result = await client.call("handshake");
    expect(result.ok).toBe(true);
  }, 30_000);

  test("terminate exits the helper", async () => {
    const result = await client.call("terminate");
    expect(result.ok).toBe(true);

    for (let attempt = 0; attempt < 50 && helper.exitCode === null && helper.signalCode === null; attempt += 1) {
      await settle(100);
    }
    expect(helper.exitCode ?? 0).toBe(0);
  }, 30_000);

  function readPermission(id: "accessibility" | "screenshots") {
    const statusFile = path.join(base, `${id}-status.json`);
    const probe = spawnSync(path.join(app, "Contents/MacOS/codecast-computer"), ["--permission-status-file", statusFile], { timeout: 30_000 });
    if (probe.status !== 0 || !fs.existsSync(statusFile)) return "unknown";
    return JSON.parse(fs.readFileSync(statusFile, "utf8"))[id];
  }
});

function checked(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || `${command} exited ${result.status}`);
  return result.stdout;
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The tree's first line whose role text matches, as its element index. */
function elementIndexOf(treeText: string, roleText: string): number | null {
  for (const line of treeText.split("\n")) {
    const match = line.trimStart().match(/^(\d+) (.+)$/);
    if (match && match[2].startsWith(roleText)) return Number(match[1]);
  }
  return null;
}

type Client = { call: (method: string, params?: object, token?: string) => Promise<any>; close: () => void };

async function connect(socketPath: string, token: string): Promise<Client> {
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const attempt = () => {
      const candidate = net.connect(socketPath);
      candidate.once("connect", () => resolve(candidate));
      candidate.once("error", (error) => {
        candidate.destroy();
        if (Date.now() > deadline) return reject(error);
        setTimeout(attempt, 100);
      });
    };
    attempt();
  });

  let id = 0;
  let buffer = "";
  const pending = new Map<number, (value: any) => void>();
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
      newline = buffer.indexOf("\n");
    }
  });

  return {
    call: (method, params = {}, override) =>
      new Promise((resolve, reject) => {
        id += 1;
        const requestId = id;
        pending.set(requestId, resolve);
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`${method} timed out`));
        }, 60_000);
        pending.set(requestId, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        socket.write(`${JSON.stringify({ id: requestId, method, params: { castBinary: process.execPath, ...params }, token: override ?? token })}\n`);
      }),
    close: () => socket.destroy(),
  };
}
