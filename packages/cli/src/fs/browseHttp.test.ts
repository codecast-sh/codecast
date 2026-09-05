// The disk-browse routes over a STANDALONE loopback server on port 0 with a
// fixed token, against a throwaway home in a temp dir. Never touches the
// daemon running on this machine.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import {
  createProjectDir,
  defaultBrowseDeps,
  handleFsBrowseHttp,
  listDirectories,
  resolveBrowsePath,
  type BrowseDeps,
  type DirListing,
} from "./browseHttp.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const ORIGIN = "http://localhost:3000";

let home = "";
let server: http.Server;
let port = 0;
const gitInits: string[] = [];

function deps(): BrowseDeps {
  return { ...defaultBrowseDeps, home: () => home, gitInit: async (p) => { gitInits.push(p); } };
}

function api(pathAndQuery: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
    ...init,
    headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browse-"));
  fs.mkdirSync(path.join(home, "src", "codecast", ".git"), { recursive: true });
  fs.mkdirSync(path.join(home, "src", "notes"), { recursive: true });
  fs.mkdirSync(path.join(home, "src", ".hidden"), { recursive: true });
  fs.writeFileSync(path.join(home, "src", "README.md"), "not a dir\n");
  server = http.createServer((req, res) => {
    if (handleFsBrowseHttp(req, res, { token: TOKEN, log: () => {} }, deps())) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("resolveBrowsePath", () => {
  test("expands ~ and normalizes; bare names are refused", () => {
    expect(resolveBrowsePath("~", "/h")).toBe("/h");
    expect(resolveBrowsePath("~/src/", "/h")).toBe("/h/src");
    expect(resolveBrowsePath("/a//b/../c", "/h")).toBe("/a/c");
    expect(resolveBrowsePath("src", "/h")).toBeNull();
    expect(resolveBrowsePath("", "/h")).toBeNull();
  });
});

describe("listDirectories", () => {
  test("lists only directories, hides dot dirs, marks repos", async () => {
    const l = (await listDirectories("~/src", false, deps()))!;
    expect(l.home).toBe(home);
    expect(l.exists).toBe(true);
    expect(l.dirs).toEqual([
      { name: "codecast", path: path.join(home, "src", "codecast"), repo: true },
      { name: "notes", path: path.join(home, "src", "notes"), repo: false },
    ]);
  });

  test("hidden=true includes dot directories", async () => {
    const l = (await listDirectories("~/src", true, deps()))!;
    expect(l.dirs.map((d) => d.name)).toEqual([".hidden", "codecast", "notes"]);
  });

  test("a missing directory reports exists=false rather than failing", async () => {
    const l = (await listDirectories("~/nope", false, deps()))!;
    expect(l).toEqual({ home, path: path.join(home, "nope"), exists: false, dirs: [] });
  });
});

describe("createProjectDir", () => {
  test("creates the folder and git-inits it once; a second call is a no-op", async () => {
    const made = (await createProjectDir("~/src/fresh", deps()))!;
    expect(made).toEqual({ path: path.join(home, "src", "fresh"), created: true });
    expect(fs.statSync(made.path).isDirectory()).toBe(true);
    expect(gitInits).toEqual([made.path]);
    expect(await createProjectDir("~/src/fresh", deps())).toEqual({ path: made.path, created: false });
    expect(gitInits.length).toBe(1);
  });

  test("refuses to 'create' home or root", async () => {
    expect(await createProjectDir("~", deps())).toBeNull();
    expect(await createProjectDir("/", deps())).toBeNull();
    expect(await createProjectDir("relative", deps())).toBeNull();
  });
});

describe("HTTP", () => {
  test("GET /fs/dirs lists a directory", async () => {
    const res = await api(`/fs/dirs?path=${encodeURIComponent("~/src")}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DirListing;
    expect(body.dirs.map((d) => d.name)).toContain("codecast");
    expect(body.home).toBe(home);
  });

  test("GET /fs/dirs with a bare name is a 400", async () => {
    expect((await api("/fs/dirs?path=src")).status).toBe(400);
  });

  test("POST /fs/mkdir creates a folder", async () => {
    const res = await api("/fs/mkdir", { method: "POST", body: JSON.stringify({ path: "~/src/via-http" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: path.join(home, "src", "via-http"), created: true });
  });

  test("missing token or foreign origin is refused", async () => {
    const noToken = await fetch(`http://127.0.0.1:${port}/fs/dirs?path=~`, { headers: { Origin: ORIGIN } });
    expect(noToken.status).toBe(403);
    const badOrigin = await fetch(`http://127.0.0.1:${port}/fs/dirs?path=~`, {
      headers: { Origin: "https://evil.example", Authorization: `Bearer ${TOKEN}` },
    });
    expect(badOrigin.status).toBe(403);
  });

  test("unrelated paths are not handled", async () => {
    expect((await api("/other")).status).toBe(404);
  });
});
