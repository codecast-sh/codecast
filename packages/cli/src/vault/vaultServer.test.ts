// End-to-end over a STANDALONE loopback server: the vault handlers mounted on a
// bare http.Server on port 0 with a fixed token, against a throwaway vault in a
// temp dir. Deliberately never touches the daemon running on this machine.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import { VAULT_MAX_SERVE_BYTES } from "@codecast/shared/contracts";
import type { VaultScanResponse, VaultWriteResponse, VaultWsEvent } from "@codecast/shared/contracts";
import { attachTerminalServer } from "../terminal/terminalServer.js";
import { addVault } from "./vaultRegistry.js";
import { attachVaultServer, handleVaultHttp, type VaultServerOptions } from "./vaultServer.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const ORIGIN = "http://localhost:3000";
const REAL_HOME = process.env.HOME;

let base = "";
let configDir = "";
let root = "";
let vaultId = "";
// A second vault the per-test fixture reset never touches, so "nothing changed
// on disk" is actually true for it.
let stableVaultId = "";
let server: http.Server;
let handle: { close(): void };
let port = 0;

function opts(): VaultServerOptions {
  return { token: TOKEN, log: () => {}, configDir, watch: { reconcileMs: 200 } };
}

function api(pathAndQuery: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
    ...init,
    headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
}

function filePath(rel: string): string {
  return `/vault/file?vault=${vaultId}&path=${encodeURIComponent(rel)}`;
}

function postOp(body: unknown): Promise<Response> {
  return api(`/vault/op?vault=${vaultId}`, { method: "POST", body: JSON.stringify(body) });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "vault-server-"));
  configDir = path.join(base, ".codecast");
  root = path.join(base, "vault");
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  vaultId = addVault(configDir, root, "Test Vault").id;

  const stableRoot = path.join(base, "stable");
  fs.mkdirSync(path.join(stableRoot, "notes"), { recursive: true });
  fs.writeFileSync(path.join(stableRoot, "notes", "kept.md"), "kept\n");
  fs.writeFileSync(path.join(stableRoot, "index.md"), "# stable\n");
  stableVaultId = addVault(configDir, stableRoot, "Stable Vault").id;

  server = http.createServer((req, res) => {
    if (handleVaultHttp(req, res, opts())) return;
    res.writeHead(404);
    res.end();
  });
  handle = attachVaultServer(server, opts());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  handle.close();
  // fetch keeps its connections alive, so a plain close() would never settle.
  server.closeAllConnections?.();
  server.close();
  if (REAL_HOME) process.env.HOME = REAL_HOME;
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  // Reset the contents, never the root itself: a watcher may be holding fs.watch
  // on it, and deleting the watched directory out from under bun wedges it.
  for (const entry of fs.readdirSync(root)) {
    fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(root, "notes", "sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.md"), "# index\n");
  fs.writeFileSync(path.join(root, "notes", "one.md"), "one\n");
  fs.writeFileSync(path.join(root, "notes", "sub", "two.md"), "two\n");
  fs.writeFileSync(path.join(root, "notes", "pic.png"), "notreallyapng");
  fs.writeFileSync(path.join(root, "notes", "ignore.txt"), "txt\n");
});

describe("auth envelope", () => {
  test("rejects a missing token and a foreign origin", async () => {
    const noToken = await fetch(`http://127.0.0.1:${port}/vault/roots`, { headers: { Origin: ORIGIN } });
    expect(noToken.status).toBe(403);

    const badOrigin = await fetch(`http://127.0.0.1:${port}/vault/roots`, {
      headers: { Origin: "https://evil.example.com", Authorization: `Bearer ${TOKEN}` },
    });
    expect(badOrigin.status).toBe(403);
  });

  test("answers the CORS preflight with the private-network header", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/vault/file`, {
      method: "OPTIONS",
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-private-network")).toBe("true");
    expect(res.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(res.headers.get("access-control-allow-headers")).toContain("If-Match");
    expect(res.headers.get("access-control-expose-headers")).toContain("ETag");
  });
});

describe("token as a query param", () => {
  // An <img src> can carry neither an Authorization header nor an Origin, so a
  // file read accepts the token in the URL. Nothing else does.
  const bare = (p: string) => fetch(`http://127.0.0.1:${port}${p}`);

  test("serves a file read with no header envelope at all", async () => {
    const res = await bare(`/vault/file?vault=${vaultId}&path=notes%2Fpic.png&token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await res.text()).toBe("notreallyapng");
  });

  test("refuses a wrong or missing query token", async () => {
    expect((await bare(`/vault/file?vault=${vaultId}&path=notes%2Fpic.png&token=nope`)).status).toBe(403);
    expect((await bare(`/vault/file?vault=${vaultId}&path=notes%2Fpic.png`)).status).toBe(403);
  });

  test("does not extend to writes, ops, scans or roots", async () => {
    const put = await fetch(
      `http://127.0.0.1:${port}/vault/file?vault=${vaultId}&path=notes%2Fone.md&token=${TOKEN}`,
      { method: "PUT", body: "clobber\n" },
    );
    expect(put.status).toBe(403);
    expect(fs.readFileSync(path.join(root, "notes/one.md"), "utf-8")).toBe("one\n");

    const op = await fetch(`http://127.0.0.1:${port}/vault/op?vault=${vaultId}&token=${TOKEN}`, {
      method: "POST",
      body: JSON.stringify({ op: "delete", path: "notes/one.md" }),
    });
    expect(op.status).toBe(403);
    expect(fs.existsSync(path.join(root, "notes/one.md"))).toBe(true);

    expect((await bare(`/vault/scan?vault=${vaultId}&token=${TOKEN}`)).status).toBe(403);
    expect((await bare(`/vault/roots?token=${TOKEN}`)).status).toBe(403);
  });

  test("still refuses a path that escapes the vault", async () => {
    const res = await bare(`/vault/file?vault=${vaultId}&path=..%2F..%2Fetc%2Fpasswd&token=${TOKEN}`);
    expect(res.status).toBe(400);
  });
});

describe("GET /vault/roots and /vault/scan", () => {
  test("lists the registered vault", async () => {
    const res = await api("/vault/roots");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vaults.map((v: any) => v.id).sort()).toEqual([vaultId, stableVaultId].sort());
    expect(body.vaults.find((v: any) => v.id === vaultId)).toMatchObject({ root, name: "Test Vault" });
  });

  test("scans the tree and skips out-of-scope files", async () => {
    const res = await api(`/vault/scan?vault=${vaultId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as VaultScanResponse;
    const paths = body.files.map((f) => f.path);
    expect(paths).toContain("index.md");
    expect(paths).toContain("notes/sub/two.md");
    expect(paths).toContain("notes/pic.png");
    expect(paths).toContain("notes/sub");
    expect(paths).toContain("notes/ignore.txt");
    // Markdown only — the scan lists .txt and .png, but "notes" means notes.
    expect(body.vault.note_count).toBe(3);
    expect(body.scanned_at).toBeGreaterThan(0);
  });

  test("an unknown vault is a 404", async () => {
    expect((await api("/vault/scan?vault=deadbeef")).status).toBe(404);
  });
});

describe("GET /vault/file", () => {
  test("serves bytes with the mtime, size and etag headers", async () => {
    const res = await api(filePath("notes/one.md"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("one\n");
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("etag")).toMatch(/^[0-9a-f]{16}$/);
    expect(Number(res.headers.get("x-vault-mtime"))).toBeGreaterThan(0);
    expect(res.headers.get("x-vault-size")).toBe("4");
  });

  test("serves an attachment with a renderable content type", async () => {
    const res = await api(filePath("notes/pic.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  test("serves a code file as read-only text", async () => {
    const res = await api(filePath("notes/ignore.txt"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("txt\n");
  });

  test("refuses a file too large to read into memory", async () => {
    // Sparse: stat reports 33MB, the disk holds nothing. The route stats before
    // it reads, so this is the exact path a real multi-gigabyte file takes —
    // the one that could take the daemon down now that every file is readable.
    const big = path.join(root, "notes", "huge.bin");
    fs.writeFileSync(big, "");
    fs.truncateSync(big, VAULT_MAX_SERVE_BYTES + 1);
    const res = await api(filePath("notes/huge.bin"));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("too large");
  });

  test("refuses traversal, ignored paths and missing files", async () => {
    expect((await api(filePath("../../etc/passwd"))).status).toBe(400);
    expect((await api(filePath(".git/config"))).status).toBe(400);
    expect((await api(filePath("notes/missing.md"))).status).toBe(404);
  });
});

describe("PUT /vault/file", () => {
  test("writes a new file, creating parent directories", async () => {
    const res = await api(filePath("deep/new/note.md"), { method: "PUT", body: "hello\n" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as VaultWriteResponse;
    expect(body.path).toBe("deep/new/note.md");
    expect(body.size).toBe(6);
    expect(fs.readFileSync(path.join(root, "deep/new/note.md"), "utf-8")).toBe("hello\n");
  });

  test("accepts a write whose If-Match matches", async () => {
    const etag = (await api(filePath("notes/one.md"))).headers.get("etag")!;
    const res = await api(filePath("notes/one.md"), {
      method: "PUT",
      body: "edited\n",
      headers: { "If-Match": etag },
    });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "notes/one.md"), "utf-8")).toBe("edited\n");
  });

  test("a stale If-Match is a 409 carrying the current body", async () => {
    fs.writeFileSync(path.join(root, "notes/one.md"), "changed on disk\n");
    const res = await api(filePath("notes/one.md"), {
      method: "PUT",
      body: "clobber\n",
      headers: { "If-Match": "0".repeat(16) },
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe("changed on disk\n");
    expect(res.headers.get("etag")).toMatch(/^[0-9a-f]{16}$/);
    expect(fs.readFileSync(path.join(root, "notes/one.md"), "utf-8")).toBe("changed on disk\n");
  });

  test("a stale base mtime is a 409, a current one goes through", async () => {
    const head = await api(filePath("notes/one.md"));
    const mtime = head.headers.get("x-vault-mtime")!;

    const stale = await api(filePath("notes/one.md"), {
      method: "PUT",
      body: "clobber\n",
      headers: { "X-Vault-Base-Mtime": String(Number(mtime) - 5000) },
    });
    expect(stale.status).toBe(409);

    const fresh = await api(filePath("notes/one.md"), {
      method: "PUT",
      body: "ok\n",
      headers: { "X-Vault-Base-Mtime": mtime },
    });
    expect(fresh.status).toBe(200);
  });

  test("a guarded write to a file that has vanished is a conflict, not a create", async () => {
    const res = await api(filePath("notes/gone.md"), {
      method: "PUT",
      body: "x\n",
      headers: { "If-Match": "0".repeat(16) },
    });
    expect(res.status).toBe(409);
    expect(fs.existsSync(path.join(root, "notes/gone.md"))).toBe(false);
  });

  test("refuses a path outside the vault", async () => {
    const res = await api(filePath("../escape.md"), { method: "PUT", body: "x" });
    expect(res.status).toBe(400);
    expect(fs.existsSync(path.join(base, "escape.md"))).toBe(false);
  });
});

describe("POST /vault/op", () => {
  test("mkdir creates a folder", async () => {
    expect((await postOp({ op: "mkdir", path: "notes/fresh" })).status).toBe(200);
    expect(fs.statSync(path.join(root, "notes/fresh")).isDirectory()).toBe(true);
  });

  test("a code file cannot be written, renamed or trashed", async () => {
    // Code became visible so the tree tells the truth about the folder. Every
    // write path stays shut: read-only has to mean read-only, or the surface
    // trashes source files from a notes browser.
    const before = fs.readFileSync(path.join(root, "notes/ignore.txt"), "utf-8");

    expect((await postOp({ op: "create", path: "notes/new.ts", content: "x" })).status).toBe(400);
    expect(fs.existsSync(path.join(root, "notes/new.ts"))).toBe(false);

    const put = await api(filePath("notes/ignore.txt"), { method: "PUT", body: "clobbered" });
    expect(put.status).toBe(400);

    const renamed = await postOp({ op: "rename", path: "notes/ignore.txt", to: "notes/moved.txt" });
    expect(renamed.status).toBe(400);
    expect((await renamed.json()).error).toBe("read-only");

    const deleted = await postOp({ op: "delete", path: "notes/ignore.txt" });
    expect(deleted.status).toBe(400);

    expect(fs.readFileSync(path.join(root, "notes/ignore.txt"), "utf-8")).toBe(before);
  });

  test("a folder still renames, whatever it holds", async () => {
    // The read-only rule is about code FILES. Reorganising folders is an
    // ordinary vault operation, and blocking it would regress notes.
    fs.mkdirSync(path.join(root, "notes/src"), { recursive: true });
    fs.writeFileSync(path.join(root, "notes/src/a.ts"), "export {}\n");
    const res = await postOp({ op: "rename", path: "notes/src", to: "notes/source" });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(root, "notes/source/a.ts"))).toBe(true);
  });

  test("create writes a new note and refuses to overwrite", async () => {
    const res = await postOp({ op: "create", path: "notes/new.md", content: "# new\n" });
    expect(res.status).toBe(200);
    expect((await res.json()).file.path).toBe("notes/new.md");
    expect(fs.readFileSync(path.join(root, "notes/new.md"), "utf-8")).toBe("# new\n");

    const again = await postOp({ op: "create", path: "notes/new.md", content: "clobber" });
    expect(again.status).toBe(409);
    expect(fs.readFileSync(path.join(root, "notes/new.md"), "utf-8")).toBe("# new\n");
  });

  test("reveal is wired and refuses a path that isn't there", async () => {
    // The spawn itself is deliberately NOT exercised here — launching Finder
    // from a test is a side effect on the developer's desktop, and the argv
    // decision (the part with real logic) is covered in vaultScope.test.ts.
    // What this pins is the WIRING: that the op reaches its own branch, and
    // that a missing file is reported rather than handed to the OS.
    const missing = await postOp({ op: "reveal", path: "notes/nope.md" });
    expect(missing.status).toBe(404);

    // A path escaping the vault is refused before anything else looks at it.
    const escape = await postOp({ op: "reveal", path: "../../etc/passwd" });
    expect(escape.status).toBe(400);

    // An unknown mode is not a way to smuggle a different verb through.
    const badMode = await postOp({ op: "reveal", path: "notes/nope.md", mode: "rm" });
    expect(badMode.status).toBe(404);
  });

  test("rename moves a note and refuses an occupied target", async () => {
    const res = await postOp({ op: "rename", path: "notes/one.md", to: "notes/sub/renamed.md" });
    expect(res.status).toBe(200);
    expect((await res.json()).file.path).toBe("notes/sub/renamed.md");
    expect(fs.existsSync(path.join(root, "notes/one.md"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "notes/sub/renamed.md"), "utf-8")).toBe("one\n");

    const occupied = await postOp({ op: "rename", path: "index.md", to: "notes/sub/two.md" });
    expect(occupied.status).toBe(409);
    expect(fs.existsSync(path.join(root, "index.md"))).toBe(true);

    const missing = await postOp({ op: "rename", path: "notes/nope.md", to: "notes/x.md" });
    expect(missing.status).toBe(404);
  });

  test("delete moves the file to the OS trash instead of unlinking it", async () => {
    const home = path.join(base, "home");
    const trash = path.join(home, process.platform === "darwin" ? ".Trash" : ".local/share/Trash/files");
    fs.mkdirSync(trash, { recursive: true });
    process.env.HOME = home;
    try {
      const res = await postOp({ op: "delete", path: "notes/one.md" });
      expect(res.status).toBe(200);
      expect(fs.existsSync(path.join(root, "notes/one.md"))).toBe(false);
      expect(fs.readFileSync(path.join(trash, "one.md"), "utf-8")).toBe("one\n");
      expect((await postOp({ op: "delete", path: "notes/one.md" })).status).toBe(404);
    } finally {
      process.env.HOME = REAL_HOME;
    }
  });

  test("falls back to the vault's own .trash when the OS trash is unusable", async () => {
    process.env.HOME = "/vault-test-no-such-root/home";
    try {
      const res = await postOp({ op: "delete", path: "notes/sub/two.md" });
      expect(res.status).toBe(200);
      expect(fs.existsSync(path.join(root, "notes/sub/two.md"))).toBe(false);
      expect(fs.readFileSync(path.join(root, ".trash", "two.md"), "utf-8")).toBe("two\n");
    } finally {
      process.env.HOME = REAL_HOME;
    }
  });

  test("refuses an op that escapes the vault", async () => {
    expect((await postOp({ op: "delete", path: "../vault" })).status).toBe(400);
    expect((await postOp({ op: "mkdir", path: "../escape" })).status).toBe(400);
    expect(fs.existsSync(path.join(base, "escape"))).toBe(false);
  });
});

describe("WS /vault/ws", () => {
  async function connect(hello: unknown): Promise<{ ws: WebSocket; events: VaultWsEvent[]; closes: number[] }> {
    // The Origin must go through `headers`: bun's ws client drops the `origin`
    // option, and the server refuses an upgrade without an allowed origin.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/vault/ws`, { headers: { Origin: ORIGIN } });
    const events: VaultWsEvent[] = [];
    const closes: number[] = [];
    ws.on("message", (raw) => events.push(JSON.parse(raw.toString("utf8"))));
    ws.on("close", (code) => closes.push(code));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify(hello));
    return { ws, events, closes };
  }

  test("streams add, change and removed events for a watched vault", async () => {
    const { ws, events } = await connect({ type: "hello", token: TOKEN, vault: vaultId });
    try {
      expect(await waitFor(() => events.some((e) => e.type === "reset"))).toBe(true);

      const added = path.join(root, "notes", "live.md");
      fs.writeFileSync(added, "live\n");
      expect(
        await waitFor(() => events.some((e) => e.type === "add" && e.path === "notes/live.md")),
      ).toBe(true);

      fs.writeFileSync(added, "live edited, longer\n");
      expect(
        await waitFor(() => events.some((e) => e.type === "change" && e.path === "notes/live.md")),
      ).toBe(true);

      // The watcher has no delete events at all: this one can only come from the
      // reconcile scan, which is the point of testing it.
      fs.rmSync(added);
      expect(
        await waitFor(() => events.some((e) => e.type === "removed" && e.path === "notes/live.md")),
      ).toBe(true);
    } finally {
      ws.close();
    }
  }, 20_000);

  test("does not replay the whole vault as adds when a client connects", async () => {
    const { ws, events } = await connect({ type: "hello", token: TOKEN, vault: stableVaultId });
    try {
      expect(await waitFor(() => events.some((e) => e.type === "reset"))).toBe(true);
      // Several reconcile intervals: the client just scanned, so a file it
      // already knows about must not arrive again as an event.
      await new Promise((r) => setTimeout(r, 700));
      expect(events.filter((e) => e.type === "add" || e.type === "change")).toEqual([]);
    } finally {
      ws.close();
    }
  }, 10_000);

  test("closes a socket whose hello carries a bad token", async () => {
    const { ws, events, closes } = await connect({ type: "hello", token: "wrong", vault: vaultId });
    try {
      expect(await waitFor(() => closes.length > 0)).toBe(true);
      expect(events.some((e: any) => e.type === "error")).toBe(true);
    } finally {
      ws.close();
    }
  });

  test("shares the upgrade path with the terminal channel", async () => {
    // Both features mount WS endpoints on the one loopback server. Before the
    // shared upgrade router each installed its own listener, and the first one
    // destroyed the other's sockets — so this asserts the terminal still
    // connects while the vault endpoint is attached, and that an unclaimed path
    // is still refused.
    const terminal = attachTerminalServer(server, { token: TOKEN, log: () => {} });
    try {
      const opened = (wsPath: string) =>
        new Promise<boolean>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`, { headers: { Origin: ORIGIN } });
          ws.on("error", () => resolve(false));
          ws.on("open", () => {
            ws.close();
            resolve(true);
          });
        });
      expect(await opened("/term/ws")).toBe(true);
      expect(await opened("/vault/ws")).toBe(true);
      expect(await opened("/nothing/ws")).toBe(false);
    } finally {
      terminal.close();
    }
  });

  test("rejects the upgrade from a foreign origin", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/vault/ws`, {
      headers: { Origin: "https://evil.example.com" },
    });
    const failed = await new Promise<boolean>((resolve) => {
      ws.on("error", () => resolve(true));
      ws.on("open", () => resolve(false));
    });
    expect(failed).toBe(true);
    ws.close();
  });
});

// Case-only rename on a case-insensitive filesystem: existsSync(dest) is true
// because dest IS the source — the same-inode allowance must let it through,
// while a rename onto a genuinely different existing file still 409s.
test("rename: case-only rename succeeds; real collision still rejected", async () => {
  fs.writeFileSync(path.join(root, "casenote.md"), "# n\n");

  const caseOnly = await postOp({ op: "rename", path: "casenote.md", to: "CaseNote.md" });
  expect(caseOnly.status).toBe(200);
  expect(fs.readdirSync(root)).toContain("CaseNote.md");

  const collision = await postOp({ op: "rename", path: "CaseNote.md", to: "index.md" });
  expect(collision.status).toBe(409);
});
