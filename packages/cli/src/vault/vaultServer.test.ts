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
import { createVaultFile, osTrashDir } from "./vaultFs.js";
import { addVault } from "./vaultRegistry.js";
import { clearRepoScopeCache } from "./vaultScope.js";
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
    expect(body.repo).toBe(false);
  });

  test("an unknown vault is a 404", async () => {
    expect((await api("/vault/scan?vault=deadbeef")).status).toBe(404);
  });

  test("GET /vault/locate names the vault for a local path, registering one when none holds it", async () => {
    const inside = await api(`/vault/locate?path=${encodeURIComponent(path.join(root, "notes", "one.md"))}`);
    expect(inside.status).toBe(200);
    expect(await inside.json()).toMatchObject({ vault: { id: vaultId }, rel: "notes/one.md" });

    const loose = path.join(base, "loose");
    fs.mkdirSync(loose, { recursive: true });
    fs.writeFileSync(path.join(loose, "pic.png"), "png");
    const outside = await api(`/vault/locate?path=${encodeURIComponent(path.join(loose, "pic.png"))}`);
    expect(outside.status).toBe(200);
    const body = await outside.json();
    expect(body).toMatchObject({ vault: { root: loose }, rel: "pic.png" });
    // The registered vault serves the file like any other.
    const served = await api(`/vault/file?vault=${body.vault.id}&path=pic.png`);
    expect(served.status).toBe(200);
    expect((await api("/vault/roots").then((r) => r.json())).vaults.some((v: any) => v.id === body.vault.id)).toBe(true);

    expect((await api(`/vault/locate?path=${encodeURIComponent(path.join(base, "nope.md"))}`)).status).toBe(404);
    expect((await api("/vault/locate?path=relative/nope.md")).status).toBe(404);
  });

  test("?ignored=1 lists a repo's hidden paths flagged, readable, writable only on opt-in", async () => {
    // Turn the fixture into a repo: a .git entry is the whole test.
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", "bundle.md"), "generated\n");
    fs.writeFileSync(path.join(root, "dist", "app.js"), "js\n");
    clearRepoScopeCache();

    const plain = (await (await api(`/vault/scan?vault=${vaultId}`)).json()) as VaultScanResponse;
    expect(plain.repo).toBe(true);
    expect(plain.files.map((f) => f.path)).not.toContain("dist/bundle.md");

    const res = await api(`/vault/scan?vault=${vaultId}&ignored=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as VaultScanResponse;
    expect(body.repo).toBe(true);
    expect(body.files.find((f) => f.path === "dist")).toMatchObject({ dir: true, ignored: true });
    expect(body.files.find((f) => f.path === "dist/app.js")).toMatchObject({ ignored: true });
    expect(body.files.find((f) => f.path === "index.md")?.ignored).toBeUndefined();
    // A generated .md is not a note: the count matches the default scan.
    expect(body.vault.note_count).toBe(plain.vault.note_count);

    // The row can be opened...
    const read = await api(filePath("dist/bundle.md"));
    expect(read.status).toBe(200);
    expect(await read.text()).toBe("generated\n");
    // ...but not written or trashed unless the request opts in.
    expect((await api(filePath("dist/bundle.md"), { method: "PUT", body: "edited" })).status).toBe(400);
    expect((await postOp({ op: "delete", path: "dist/bundle.md" })).status).toBe(400);
    expect(fs.readFileSync(path.join(root, "dist", "bundle.md"), "utf-8")).toBe("generated\n");
  });

  test("a plain vault reports repo:false and lists the same tree either way", async () => {
    const plain = (await (await api(`/vault/scan?vault=${stableVaultId}`)).json()) as VaultScanResponse;
    const withFlag = (await (await api(`/vault/scan?vault=${stableVaultId}&ignored=1`)).json()) as VaultScanResponse;
    expect(plain.repo).toBe(false);
    expect(withFlag.files.map((f) => f.path)).toEqual(plain.files.map((f) => f.path));
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

  test("two PUTs carrying the same If-Match: exactly one lands, the other is a 409", async () => {
    const etag = (await api(filePath("notes/one.md"))).headers.get("ETag")!;
    const put = (body: string) =>
      api(filePath("notes/one.md"), { method: "PUT", body, headers: { "If-Match": etag } });
    const results = await Promise.all([put("from tab A\n"), put("from tab B\n")]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);

    const loser = results.find((r) => r.status === 409)!;
    const onDisk = fs.readFileSync(path.join(root, "notes/one.md"), "utf-8");
    expect(["from tab A\n", "from tab B\n"]).toContain(onDisk);
    // The loser sees the winner's bytes and their identity, ready to merge.
    expect(await loser.text()).toBe(onDisk);
    const winner = (await results.find((r) => r.status === 200)!.json()) as VaultWriteResponse;
    expect(loser.headers.get("ETag")).toBe(winner.etag);
    expect(Number(loser.headers.get("X-Vault-Mtime"))).toBe(winner.mtime);
  });

  test("writes a source file byte for byte, CRLF and BOM included", async () => {
    const bytes = Buffer.from("\uFEFFconst a = 1;\r\nconst b = 2;\r\n\n", "utf8");
    const res = await api(filePath("src/mixed.ts"), { method: "PUT", body: bytes });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "src/mixed.ts")).equals(bytes)).toBe(true);
    // An extensionless script is source too.
    expect((await api(filePath("bin/run"), { method: "PUT", body: "#!/bin/sh\n" })).status).toBe(200);
  });

  test("a save keeps the file's mode bits", async () => {
    const script = path.join(root, "notes/build.sh");
    fs.writeFileSync(script, "#!/bin/sh\necho one\n");
    fs.chmodSync(script, 0o750);
    const res = await api(filePath("notes/build.sh"), { method: "PUT", body: "#!/bin/sh\necho two\n" });
    expect(res.status).toBe(200);
    expect(fs.statSync(script).mode & 0o777).toBe(0o750);
    expect(fs.readFileSync(script, "utf-8")).toBe("#!/bin/sh\necho two\n");
    // No temp file is left behind.
    expect(fs.readdirSync(path.join(root, "notes")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("a save to a hard-linked file keeps the link", async () => {
    const a = path.join(root, "notes/shared.txt");
    const b = path.join(root, "notes/shared-link.txt");
    fs.writeFileSync(a, "old\n");
    fs.linkSync(a, b);
    expect((await api(filePath("notes/shared.txt"), { method: "PUT", body: "new\n" })).status).toBe(200);
    expect(fs.readFileSync(b, "utf-8")).toBe("new\n");
    expect(fs.statSync(a).ino).toBe(fs.statSync(b).ino);
  });

  test("refuses binary bodies and binary extensions for source paths", async () => {
    const nul = await api(filePath("src/a.ts"), { method: "PUT", body: "a\u0000b" });
    expect(nul.status).toBe(415);
    expect((await nul.json()).error).toBe("binary");
    const badUtf8 = await api(filePath("src/b.ts"), { method: "PUT", body: Buffer.from([0x61, 0xff, 0xfe, 0x62]) });
    expect(badUtf8.status).toBe(415);
    expect((await api(filePath("lib/x.dylib"), { method: "PUT", body: "text" })).status).toBe(400);
    expect((await api(filePath("fonts/x.woff2"), { method: "PUT", body: "text" })).status).toBe(400);
    expect(fs.existsSync(path.join(root, "src"))).toBe(false);
    // Documents are unchanged: an attachment is binary on purpose.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0xff]);
    expect((await api(filePath("notes/new.png"), { method: "PUT", body: png })).status).toBe(200);
    expect(fs.readFileSync(path.join(root, "notes/new.png")).equals(png)).toBe(true);
  });

  test("a repo-ignored path is writable with ignored=1, the always-ignored set never", async () => {
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules/pkg"), { recursive: true });
    fs.writeFileSync(path.join(root, ".gitignore"), "generated\n");
    clearRepoScopeCache();
    const putIgnored = (rel: string, body: string) =>
      api(`${filePath(rel)}&ignored=1`, { method: "PUT", body });

    for (const rel of [".env", "dist/app.js", "generated/schema.ts"]) {
      expect((await api(filePath(rel), { method: "PUT", body: "x\n" })).status).toBe(400);
      expect((await putIgnored(rel, "x\n")).status).toBe(200);
      expect(fs.readFileSync(path.join(root, rel), "utf-8")).toBe("x\n");
    }
    for (const rel of [".git/config", "node_modules/pkg/index.js", ".obsidian/app.json"]) {
      expect((await putIgnored(rel, "x\n")).status).toBe(400);
      expect(fs.existsSync(path.join(root, rel))).toBe(false);
    }
  });

  test("the always-ignored set holds in any letter case", async () => {
    fs.mkdirSync(path.join(root, ".git/hooks"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules/x"), { recursive: true });
    fs.writeFileSync(path.join(root, ".gitignore"), "secrets.env\n");
    clearRepoScopeCache();
    for (const rel of [".GIT/hooks/pre-commit", "Node_Modules/x/a.js", ".Obsidian/app.json"]) {
      expect((await api(filePath(rel), { method: "PUT", body: "x\n" })).status).toBe(400);
      expect((await api(`${filePath(rel)}&ignored=1`, { method: "PUT", body: "x\n" })).status).toBe(400);
    }
    expect(fs.readdirSync(path.join(root, ".git/hooks"))).toEqual([]);
    expect(fs.readdirSync(path.join(root, "node_modules/x"))).toEqual([]);
    // A .gitignore name cannot be dodged by case where the filesystem folds it.
    if (process.platform === "darwin" || process.platform === "win32") {
      expect((await api(filePath("SECRETS.env"), { method: "PUT", body: "x\n" })).status).toBe(400);
    }
  });

  test("a read-only file is refused unless the save forces it", async () => {
    const locked = path.join(root, "notes/generated.ts");
    fs.writeFileSync(locked, "old\n");
    fs.chmodSync(locked, 0o444);
    const refused = await api(filePath("notes/generated.ts"), { method: "PUT", body: "new\n" });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toBe("read-only");
    expect(fs.readFileSync(locked, "utf-8")).toBe("old\n");
    const forced = await api(`${filePath("notes/generated.ts")}&force=1`, { method: "PUT", body: "new\n" });
    expect(forced.status).toBe(200);
    expect(fs.readFileSync(locked, "utf-8")).toBe("new\n");
    expect(fs.statSync(locked).mode & 0o777).toBe(0o444);
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

  test("a binary file cannot be renamed or trashed", async () => {
    fs.writeFileSync(path.join(root, "notes/archive.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]));
    const renamed = await postOp({ op: "rename", path: "notes/archive.zip", to: "notes/moved.zip" });
    expect(renamed.status).toBe(400);
    expect((await renamed.json()).error).toBe("read-only");
    expect((await postOp({ op: "delete", path: "notes/archive.zip" })).status).toBe(400);
    expect((await postOp({ op: "create", path: "notes/new.zip", content: "x" })).status).toBe(400);
    expect(fs.existsSync(path.join(root, "notes/archive.zip"))).toBe(true);
  });

  test("create, rename and delete a source file", async () => {
    const created = await postOp({ op: "create", path: "src/foo.ts", content: "export const a = 1;\r\n" });
    expect(created.status).toBe(200);
    expect((await created.json()).file).toMatchObject({ path: "src/foo.ts", size: 21 });
    expect(fs.readFileSync(path.join(root, "src/foo.ts"), "utf-8")).toBe("export const a = 1;\r\n");
    expect((await postOp({ op: "create", path: "src/foo.ts", content: "clobber" })).status).toBe(409);
    expect((await postOp({ op: "create", path: "src/nul.ts", content: "a\u0000b" })).status).toBe(415);
    expect(fs.existsSync(path.join(root, "src/nul.ts"))).toBe(false);

    const renamed = await postOp({ op: "rename", path: "src/foo.ts", to: "src/bar.ts" });
    expect(renamed.status).toBe(200);
    expect(fs.existsSync(path.join(root, "src/foo.ts"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "src/bar.ts"), "utf-8")).toBe("export const a = 1;\r\n");

    const home = path.join(base, "home-src");
    const trash = osTrashDir(home)!;
    fs.mkdirSync(trash, { recursive: true });
    process.env.HOME = home;
    try {
      expect((await postOp({ op: "delete", path: "src/bar.ts" })).status).toBe(200);
    } finally {
      process.env.HOME = REAL_HOME;
    }
    expect(fs.existsSync(path.join(root, "src/bar.ts"))).toBe(false);
    expect(fs.readFileSync(path.join(trash, "bar.ts"), "utf-8")).toBe("export const a = 1;\r\n");
  });

  test("a file cannot be renamed to a binary name", async () => {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/a.ts"), "a\n");
    const res = await postOp({ op: "rename", path: "src/a.ts", to: "src/a.dylib" });
    expect(res.status).toBe(400);
    expect(fs.existsSync(path.join(root, "src/a.ts"))).toBe(true);
    expect(fs.existsSync(path.join(root, "src/a.dylib"))).toBe(false);
  });

  test("create never replaces a file another writer made first", async () => {
    // Another process (cast files, an outside editor) is invisible to the
    // daemon's path lock; createVaultFile's O_EXCL is what has to catch it.
    const abs = path.join(root, "src/race.ts");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "theirs\n");
    await expect(createVaultFile(abs, "mine\n")).rejects.toMatchObject({ code: "EEXIST" });
    expect(fs.readFileSync(abs, "utf-8")).toBe("theirs\n");
  });

  test("ops on a repo-ignored path need ignored=1; .git and node_modules never open", async () => {
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    clearRepoScopeCache();
    const opIgnored = (body: unknown) =>
      api(`/vault/op?vault=${vaultId}&ignored=1`, { method: "POST", body: JSON.stringify(body) });

    expect((await postOp({ op: "create", path: ".env", content: "A=1\n" })).status).toBe(400);
    expect((await opIgnored({ op: "create", path: ".env", content: "A=1\n" })).status).toBe(200);
    expect(fs.readFileSync(path.join(root, ".env"), "utf-8")).toBe("A=1\n");
    expect((await opIgnored({ op: "rename", path: ".env", to: "dist/.env" })).status).toBe(200);

    expect((await opIgnored({ op: "create", path: ".git/hooks/pre-commit", content: "x" })).status).toBe(400);
    expect((await opIgnored({ op: "create", path: "node_modules/x.js", content: "x" })).status).toBe(400);
    expect((await opIgnored({ op: "rename", path: "dist/.env", to: ".git/env" })).status).toBe(400);
    expect(fs.existsSync(path.join(root, ".git/hooks/pre-commit"))).toBe(false);
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
    const trash = osTrashDir(home)!;
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
