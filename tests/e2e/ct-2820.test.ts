/**
 * E2E Test for ct-2820: HTTP hook server handles permission_blocked events
 *
 * Tests that the daemon's HTTP hook server correctly receives and processes
 * permission_blocked status events, including URL-encoded transcript paths
 * and messages with special characters.
 */

import { test, expect } from "@playwright/test";
import * as http from "http";

const HOOK_PORT_FILE = `${process.env.HOME}/.codecast/hook-port`;

function readHookPort(): number | null {
  try {
    const fs = require("fs");
    const port = parseInt(fs.readFileSync(HOOK_PORT_FILE, "utf-8").trim(), 10);
    return isNaN(port) ? null : port;
  } catch {
    return null;
  }
}

function hookGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

test.describe("HTTP hook server permission_blocked (ct-2820)", () => {
  let port: number;

  test.beforeAll(() => {
    const p = readHookPort();
    if (!p) {
      test.skip();
    }
    port = p!;
  });

  test("health endpoint responds", async () => {
    const res = await hookGet(port, "/health");
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });

  test("rejects requests missing required params", async () => {
    const res = await hookGet(port, "/hook/status?session_id=test123");
    expect(res.status).toBe(400);
    expect(res.body).toContain("missing params");
  });

  test("accepts permission_blocked status via HTTP", async () => {
    const sessionId = `test-perm-${Date.now()}`;
    const ts = Math.floor(Date.now() / 1000);
    const message = encodeURIComponent("Bash: rm -rf /tmp/test file (1).txt");
    const transcriptPath = encodeURIComponent("/Users/test user/.claude/projects/My App/abc123.jsonl");

    const path = `/hook/status?session_id=${sessionId}&status=permission_blocked&ts=${ts}&message=${message}&transcript_path=${transcriptPath}&permission_mode=default`;
    const res = await hookGet(port, path);
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });

  test("accepts working status via HTTP", async () => {
    const sessionId = `test-work-${Date.now()}`;
    const ts = Math.floor(Date.now() / 1000);
    const res = await hookGet(port, `/hook/status?session_id=${sessionId}&status=working&ts=${ts}`);
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });

  test("returns 404 for unknown paths", async () => {
    const res = await hookGet(port, "/unknown");
    expect(res.status).toBe(404);
  });
});
