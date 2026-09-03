import { describe, expect, it } from "bun:test";
import crypto from "node:crypto";
import * as fs from "node:fs";
import http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import {
  TERM_SESSION_PREFIX,
  authorizeLocalRequest,
  corsHeaders,
  handleTerminalHttp,
  killTerminalSession,
  listTerminalSessions,
  originAllowed,
  parseTerminalSessionRows,
  staleTerminalSessions,
  tokenMatches,
  type TerminalServerOptions,
} from "./terminalServer.js";
import { hasTmux, tmuxExecSync } from "../tmux.js";

const TOKEN = "a".repeat(64);
const opts = (extra: Partial<TerminalServerOptions> = {}): TerminalServerOptions => ({ token: TOKEN, log: () => {}, ...extra });

describe("originAllowed", () => {
  it("accepts the product origins and local dev servers", () => {
    for (const o of [
      "https://codecast.sh",
      "https://local.codecast.sh",
      "https://local.3200.codecast.sh",
      "http://localhost:3000",
      "http://127.0.0.1:5173",
    ]) expect(originAllowed(o, opts())).toBe(true);
  });

  it("refuses plain http on the product host, lookalike hosts, and no origin", () => {
    for (const o of ["http://codecast.sh", "https://codecast.sh.evil.com", "https://evil.com", undefined, ""]) {
      expect(originAllowed(o, opts())).toBe(false);
    }
  });

  it("consults allowOrigin only after the built in list refuses", () => {
    const seen: string[] = [];
    const o = opts({ allowOrigin: (origin) => { seen.push(origin); return origin === "https://dev.example"; } });
    expect(originAllowed("https://codecast.sh", o)).toBe(true);
    expect(seen).toEqual([]);
    expect(originAllowed("https://dev.example", o)).toBe(true);
    expect(originAllowed("https://other.example", o)).toBe(false);
    expect(seen).toEqual(["https://dev.example", "https://other.example"]);
  });
});

describe("tokenMatches and authorizeLocalRequest", () => {
  it("matches the same string only", () => {
    expect(tokenMatches(TOKEN, opts())).toBe(true);
    expect(tokenMatches(TOKEN.slice(1), opts())).toBe(false);
    expect(tokenMatches("b".repeat(64), opts())).toBe(false);
    expect(tokenMatches(undefined, opts())).toBe(false);
    expect(tokenMatches(42, opts())).toBe(false);
  });

  it("needs an allowed origin and the bearer token together", () => {
    const req = (headers: Record<string, string>) => ({ headers }) as unknown as http.IncomingMessage;
    expect(authorizeLocalRequest(req({ origin: "https://codecast.sh", authorization: `Bearer ${TOKEN}` }), opts())).toBe(true);
    expect(authorizeLocalRequest(req({ origin: "https://codecast.sh" }), opts())).toBe(false);
    expect(authorizeLocalRequest(req({ authorization: `Bearer ${TOKEN}` }), opts())).toBe(false);
    expect(authorizeLocalRequest(req({ origin: "https://evil.com", authorization: `Bearer ${TOKEN}` }), opts())).toBe(false);
    expect(authorizeLocalRequest(req({ origin: "https://codecast.sh", authorization: TOKEN }), opts())).toBe(false);
  });

  // The daemon's token is state now: it loads from disk early in boot, so a
  // caller can reach these options before it exists. A constant-time compare of
  // two zero-length buffers reports a match, so an unconfigured server would
  // otherwise authorize a request that presents no token at all.
  it("authenticates nobody when the server has no token yet", () => {
    const unset = opts({ token: "" });
    expect(tokenMatches("", unset)).toBe(false);
    expect(tokenMatches(TOKEN, unset)).toBe(false);
    const req = (headers: Record<string, string>) => ({ headers }) as unknown as http.IncomingMessage;
    expect(authorizeLocalRequest(req({ origin: "https://codecast.sh" }), unset)).toBe(false);
    expect(authorizeLocalRequest(req({ origin: "https://codecast.sh", authorization: "Bearer " }), unset)).toBe(false);
  });
});

describe("corsHeaders", () => {
  it("is empty for a refused origin", () => {
    expect(corsHeaders("https://evil.com", opts())).toEqual({});
    expect(corsHeaders(undefined, opts())).toEqual({});
  });

  it("echoes an allowed origin and lists the vault write guard headers", () => {
    const h = corsHeaders("https://local.codecast.sh", opts());
    expect(h["Access-Control-Allow-Origin"]).toBe("https://local.codecast.sh");
    expect(h["Access-Control-Allow-Headers"]).toContain("If-Match");
    expect(h["Access-Control-Allow-Headers"]).toContain("X-Vault-Base-Mtime");
    expect(h["Access-Control-Allow-Private-Network"]).toBe("true");
    expect(h["Vary"]).toBe("Origin");
  });
});

describe("parseTerminalSessionRows", () => {
  it("reads one list-sessions call with the pane command inline", () => {
    const stdout = [
      "cast-term-b2|1700000200|1|zsh|/Users/me/odd|name",
      "",
      "cc-claude-abc123|1700000100|0|claude|/Users/me/src",
      "cast-term-a1|1700000100|0||/Users/me/src",
      "cast-term-c3|1700000300|2|vim|/tmp",
    ].join("\n");
    const rows = parseTerminalSessionRows(stdout);
    expect(rows.map((r) => r.name)).toEqual(["cast-term-a1", "cast-term-b2", "cast-term-c3"]);
    expect(rows[0]).toEqual({ name: "cast-term-a1", path: "/Users/me/src", command: "", created: 1700000100 * 1000, attached: 0 });
    expect(rows[1].path).toBe("/Users/me/odd|name");
    expect(rows[1].command).toBe("zsh");
    expect(rows[1].attached).toBe(1);
    expect(rows[2].attached).toBe(2);
  });

  it("returns nothing for empty output", () => {
    expect(parseTerminalSessionRows("")).toEqual([]);
    expect(parseTerminalSessionRows("\n\n")).toEqual([]);
  });
});

describe("staleTerminalSessions", () => {
  it("picks detached panel sessions idle past three days", () => {
    const now = 1_800_000_000_000;
    const sec = (ms: number) => Math.floor(ms / 1000);
    const stdout = [
      `cast-term-old|0|${sec(now - 4 * 24 * 3_600_000)}`,
      `cast-term-attached|1|${sec(now - 4 * 24 * 3_600_000)}`,
      `cast-term-fresh|0|${sec(now - 3_600_000)}`,
      `cc-claude-old|0|${sec(now - 10 * 24 * 3_600_000)}`,
    ].join("\n");
    const stale = staleTerminalSessions(stdout, now);
    expect(stale.map((s) => s.name)).toEqual(["cast-term-old"]);
    expect(Math.round(stale[0].idleMs / 3_600_000)).toBe(96);
  });
});

// The router on a real loopback server; no tmux session is needed for these.
describe("handleTerminalHttp", () => {
  async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
    const o = opts();
    const server = http.createServer((req, res) => {
      if (handleTerminalHttp(req, res, o)) return;
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as { port: number };
    try {
      await fn(`http://127.0.0.1:${addr.port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  const authed = { Origin: "https://codecast.sh", Authorization: `Bearer ${TOKEN}` };

  it("answers OPTIONS with the CORS envelope and refuses a missing token", async () => {
    await withServer(async (base) => {
      const pre = await fetch(`${base}/term/sessions`, { method: "OPTIONS", headers: { Origin: "https://codecast.sh" } });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-origin")).toBe("https://codecast.sh");
      expect(pre.headers.get("access-control-allow-private-network")).toBe("true");

      const noToken = await fetch(`${base}/term/sessions`, { headers: { Origin: "https://codecast.sh" } });
      expect(noToken.status).toBe(403);
      expect(await noToken.json()).toEqual({ error: "forbidden" });

      const unknown = await fetch(`${base}/term/x`, { headers: authed });
      expect(unknown.status).toBe(404);
    });
  }, 30_000);

  it("lists sessions off the loop and refuses to kill a session it does not own", async () => {
    await withServer(async (base) => {
      const list = await fetch(`${base}/term/sessions`, { headers: authed });
      expect(list.status).toBe(200);
      const body = (await list.json()) as { sessions: unknown[]; tmux: boolean };
      expect(Array.isArray(body.sessions)).toBe(true);
      expect(typeof body.tmux).toBe("boolean");
      for (const s of body.sessions as Array<{ name: string }>) expect(s.name.startsWith(TERM_SESSION_PREFIX)).toBe(true);

      const kill = await fetch(`${base}/term/kill?name=cc-claude-nope`, { method: "POST", headers: authed });
      expect(kill.status).toBe(400);
      expect(await kill.json()).toEqual({ ok: false });
    });
  }, 30_000);
});

// A leftover cast-term-test session would sit in the user's terminal panel
// until the three day reaper, so the kill in finally is not optional.
describe("listTerminalSessions and killTerminalSession with tmux", () => {
  it.skipIf(!hasTmux())("sees a panel session with its path and command, then kills it", async () => {
    const name = `${TERM_SESSION_PREFIX}test-${crypto.randomBytes(3).toString("hex")}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "term-server-"));
    try {
      tmuxExecSync(["new-session", "-d", "-s", name, "-c", dir]);
      const rows = await listTerminalSessions();
      const mine = rows.find((r) => r.name === name);
      expect(mine).toBeDefined();
      // tmux reports the path as it was given or resolved; both are the dir.
      expect([dir, fs.realpathSync(dir)]).toContain(mine!.path);
      expect(mine!.command.length).toBeGreaterThan(0);
      expect(mine!.created).toBeGreaterThan(0);
      expect(mine!.attached).toBe(0);

      expect(await killTerminalSession(name)).toBe(true);
      expect((await listTerminalSessions()).some((r) => r.name === name)).toBe(false);
    } finally {
      try { tmuxExecSync(["kill-session", "-t", name]); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
