// LOCAL-01. An attachment URL used to carry the daemon's loopback bearer — the
// same secret that spawns shells on /term/ws — and an SVG served from a vault
// is repository content: opened as a document it runs at the daemon's origin
// and can read its own URL. Two things close that: the URL carries a
// vault-read capability instead, and active document types are served under a
// response sandbox so nothing runs in the first place.
//
// Driven through the REAL handlers on a standalone loopback server, with the
// terminal routes mounted beside them so "this capability cannot reach a
// shell" is asserted against the real terminal admission.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { handleTerminalHttp } from "../terminal/terminalServer.js";
import { addVault } from "./vaultRegistry.js";
import { handleVaultHttp, type VaultServerOptions } from "./vaultServer.js";
import { mintVaultCapability, redactVaultUrl, vaultCapabilityAllows } from "./vaultCapability.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const ORIGIN = "http://localhost:3000";
// A marker that would run if the browser ever executed this document.
const ACTIVE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/term/ws?stolen="+location.href)</script></svg>`;

let base = "";
let configDir = "";
let vaultId = "";
let otherVaultId = "";
let server: http.Server;
let port = 0;

function opts(): VaultServerOptions {
  return { token: TOKEN, log: () => {}, configDir };
}

function url(p: string): string {
  return `http://127.0.0.1:${port}${p}`;
}

/** A request shaped like an <img> load: no Origin, no Authorization, just the
 *  URL. Exactly what an attachment URL has to stand on. */
function bare(p: string): Promise<Response> {
  return fetch(url(p));
}

function authed(p: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url(p), {
    ...init,
    headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
}

async function mint(id: string): Promise<string> {
  const res = await authed(`/vault/cap?vault=${id}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { value: string }).value;
}

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "vault-attach-"));
  configDir = path.join(base, ".codecast");

  const root = path.join(base, "vault");
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.writeFileSync(path.join(root, "notes", "evil.svg"), ACTIVE_SVG);
  fs.writeFileSync(path.join(root, "notes", "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(root, "notes", "paper.pdf"), Buffer.from("%PDF-1.4\n"));
  fs.writeFileSync(path.join(root, "notes", "note.md"), "# note\n");
  vaultId = addVault(configDir, root, "Test Vault").id;

  const other = path.join(base, "other");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "secret.md"), "# secret\n");
  otherVaultId = addVault(configDir, other, "Other Vault").id;

  server = http.createServer((req, res) => {
    if (handleVaultHttp(req, res, opts())) return;
    if (handleTerminalHttp(req, res, opts())) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.closeAllConnections?.();
  server.close();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("attachment responses cannot become code", () => {
  test("an SVG is served under a sandbox with no script and no same-origin", async () => {
    const res = await authed(`/vault/file?vault=${vaultId}&path=notes%2Fevil.svg`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox");
    expect(csp).not.toContain("allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // Still served: an <img> renders it, which was always inert.
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(await res.text()).toBe(ACTIVE_SVG);
  });

  test("images, PDFs and notes keep rendering and are never sniffed into a document", async () => {
    for (const [rel, type] of [
      ["notes/shot.png", "image/png"],
      ["notes/paper.pdf", "application/pdf"],
      ["notes/note.md", "text/markdown; charset=utf-8"],
    ] as const) {
      const res = await authed(`/vault/file?vault=${vaultId}&path=${encodeURIComponent(rel)}`);
      expect(res.status, rel).toBe(200);
      expect(res.headers.get("content-type"), rel).toBe(type);
      expect(res.headers.get("x-content-type-options"), rel).toBe("nosniff");
      // A sandbox on these would break the PDF viewer for no gain: they are
      // not documents a browser runs script from.
      expect(res.headers.get("content-security-policy"), rel).toBeNull();
    }
  });
});

describe("the attachment capability is narrow", () => {
  test("it reads a file with no Origin and no bearer, the way an <img> does", async () => {
    const cap = await mint(vaultId);
    const res = await bare(`/vault/file?vault=${vaultId}&path=notes%2Fshot.png&cap=${encodeURIComponent(cap)}`);
    expect(res.status).toBe(200);
  });

  test("it is not the daemon bearer, and presenting it as one reaches nothing", async () => {
    const cap = await mint(vaultId);
    expect(cap).not.toContain(TOKEN);
    // This is the escalation the finding named: the URL used to carry TOKEN,
    // and TOKEN opens a shell.
    const asBearer = { headers: { Origin: ORIGIN, Authorization: `Bearer ${cap}` } };
    expect((await fetch(url("/term/sessions"), asBearer)).status).toBe(403);
    expect((await fetch(url(`/vault/roots`), asBearer)).status).toBe(403);
  });

  test("it cannot spawn a terminal", async () => {
    const cap = await mint(vaultId);
    for (const p of ["/term/sessions", `/term/sessions?cap=${encodeURIComponent(cap)}`, `/term/sessions?token=${encodeURIComponent(cap)}`]) {
      const res = await bare(p);
      expect(res.status, p).toBe(403);
    }
  });

  test("it cannot write, rename, trash or reveal anything", async () => {
    const cap = await mint(vaultId);
    const q = `vault=${vaultId}&cap=${encodeURIComponent(cap)}`;
    const put = await bare(`/vault/file?${q}&path=notes%2Fnote.md`);
    expect(put.status).toBe(200); // a GET is a read
    for (const init of [
      { method: "PUT", body: "owned" },
      { method: "POST", body: JSON.stringify({ op: "delete", path: "notes/note.md" }) },
    ] as RequestInit[]) {
      const route = init.method === "PUT" ? `/vault/file?${q}&path=notes%2Fnote.md` : `/vault/op?${q}`;
      const res = await fetch(url(route), init);
      expect(res.status, `${init.method} ${route}`).toBe(403);
    }
    expect(fs.readFileSync(path.join(base, "vault", "notes", "note.md"), "utf8")).toBe("# note\n");
  });

  test("it cannot list vaults, locate a directory or scan", async () => {
    const cap = await mint(vaultId);
    for (const p of [
      `/vault/roots?cap=${encodeURIComponent(cap)}`,
      `/vault/locate?path=%2Fetc&cap=${encodeURIComponent(cap)}`,
      `/vault/scan?vault=${vaultId}&cap=${encodeURIComponent(cap)}`,
      `/vault/cap?vault=${vaultId}&cap=${encodeURIComponent(cap)}`,
    ]) {
      expect((await bare(p)).status, p).toBe(403);
    }
  });

  test("it cannot read another vault", async () => {
    const cap = await mint(vaultId);
    const res = await bare(`/vault/file?vault=${otherVaultId}&path=secret.md&cap=${encodeURIComponent(cap)}`);
    expect(res.status).toBe(403);
  });

  test("a tampered or expired capability reads nothing", async () => {
    const cap = await mint(vaultId);
    const expired = mintVaultCapability(TOKEN, vaultId, { ttlMs: -1000 }).value;
    // Flip the last hex digit to a different one: overwriting it with a fixed
    // "0" left the capability intact whenever its signature already ended in 0.
    const tampered = cap.slice(0, -1) + (cap.endsWith("0") ? "1" : "0");
    for (const bad of [tampered, cap.replace("v1.", "v2."), expired, "", "junk"]) {
      const res = await bare(`/vault/file?vault=${vaultId}&path=notes%2Fshot.png&cap=${encodeURIComponent(bad)}`);
      expect(res.status, JSON.stringify(bad)).toBe(403);
    }
  });

  test("minting one needs the full envelope", async () => {
    expect((await bare(`/vault/cap?vault=${vaultId}`)).status).toBe(403);
    expect((await fetch(url(`/vault/cap?vault=${vaultId}`), { headers: { Origin: ORIGIN } })).status).toBe(403);
  });
});

describe("capability derivation", () => {
  test("it is bound to the vault, the expiry and the daemon secret", () => {
    const cap = mintVaultCapability(TOKEN, "vault-a").value;
    expect(vaultCapabilityAllows(cap, TOKEN, "vault-a")).toBe(true);
    expect(vaultCapabilityAllows(cap, TOKEN, "vault-b")).toBe(false);
    expect(vaultCapabilityAllows(cap, "another-secret", "vault-a")).toBe(false);
    expect(vaultCapabilityAllows(cap, "", "vault-a")).toBe(false);
    expect(vaultCapabilityAllows(cap, TOKEN, "")).toBe(false);
  });

  test("a rotated daemon token invalidates every outstanding capability", () => {
    const cap = mintVaultCapability(TOKEN, "vault-a").value;
    expect(vaultCapabilityAllows(cap, `${TOKEN}-rotated`, "vault-a")).toBe(false);
  });

  test("log lines never carry the capability or the bearer", () => {
    expect(redactVaultUrl("/vault/file?vault=v&path=a.png&cap=v1.123.abc")).toBe(
      "/vault/file?vault=v&path=a.png&cap=<redacted>",
    );
    expect(redactVaultUrl("/vault/file?token=sekret&path=a.png")).toBe("/vault/file?token=<redacted>&path=a.png");
  });
});
