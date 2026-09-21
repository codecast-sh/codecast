// The installed hook script must present the hook secret on the HTTP push.
// Runs the REAL script through bash against a real loopback server, the way
// Claude Code runs it, and reads back what the server received.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { CODECAST_STATUS_HOOK } from "./statusHook.js";

const SESSION = "9f8c1e2a-4b6d-4f31-9c0a-1b2c3d4e5f60";
const TOKEN = "e".repeat(64);

let home: string;
let hookFile: string;
let server: http.Server;
let received: Array<{ url: string; authorization?: string }> = [];

function runHook(): void {
  execFileSync("bash", [hookFile], {
    input: JSON.stringify({ session_id: SESSION, hook_event_name: "Stop" }),
    env: { ...process.env, HOME: home },
  });
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-hookauth-"));
  fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
  hookFile = path.join(home, "codecast-status.sh");
  fs.writeFileSync(hookFile, CODECAST_STATUS_HOOK, { mode: 0o755 });

  server = http.createServer((req, res) => {
    received.push({ url: req.url ?? "", authorization: req.headers.authorization });
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  fs.writeFileSync(path.join(home, ".codecast", "hook-port"), String(port));
});

afterAll(() => {
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("hook transport authentication", () => {
  test("presents the saved secret as a bearer header", () => {
    received = [];
    fs.writeFileSync(path.join(home, ".codecast", "hook-token"), TOKEN, { mode: 0o600 });
    runHook();
    expect(received.length).toBe(1);
    expect(received[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(received[0]!.url).toContain(`session_id=${SESSION}`);
  });

  test("keeps the secret out of the URL", () => {
    expect(received[0]!.url).not.toContain(TOKEN);
  });

  test("with no secret file it posts nothing that claims one, and still falls back to disk", () => {
    received = [];
    fs.rmSync(path.join(home, ".codecast", "hook-token"), { force: true });
    runHook();
    expect(received.length).toBe(1);
    expect(received[0]!.authorization).toBeUndefined();
  });
});
