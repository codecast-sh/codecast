// The /evals bridge over a STANDALONE loopback server on port 0 with a fixed
// token, against throwaway checkouts and EVALS_HOMEs in a temp dir. The
// "checkout" is a scratch git repo whose packages/evals/src/index.ts is a fake
// api child: it records each exec in a marker file and echoes requests back,
// so the bridge's real argv (`bun <entry> api --stdio`) is what runs. Never
// touches the daemon, the real EVALS_HOME or the real eval tool.

import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { agentSpawnPath } from "../agentSpawnPath.js";
import { EVALS_ENTRY, EVALS_SCRIPT_HEADER, createEvalsBridge, evalsHomeDir, type EvalsBridge, type EvalsBridgeDeps } from "./evalsBridge.js";
import { handleEvalsHttp } from "./evalsServer.js";

// Every test spawns git and bun children; at a load average in the hundreds a
// cold bun start alone can pass bun's 5 s default.
setDefaultTimeout(90_000);

const TOKEN = "0123456789abcdef0123456789abcdef";
const ORIGIN = "http://localhost:3000";

const FAKE_CHILD = `
import { appendFileSync } from "fs";
appendFileSync(process.env.FAKE_MARKER, process.pid + " " + process.argv.slice(2).join(" ") + "\\n");
let carry = "";
process.stdin.on("data", (chunk) => {
  const parts = (carry + chunk).split("\\n");
  carry = parts.pop();
  for (const line of parts) {
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.query.crash) {
      process.stderr.write("loading surfaces\\nboom: cannot find module ./meta.ts\\n");
      setTimeout(() => process.exit(3), 30);
      return;
    }
    const answer = () => process.stdout.write(JSON.stringify({ id: req.id, status: 200, body: { pid: process.pid, args: process.argv.slice(2), cwd: process.cwd(), req } }) + "\\n");
    if (req.query.slow) setTimeout(answer, Number(req.query.slow));
    else answer();
  }
});
process.stdin.on("end", () => process.exit(0));
`;

let tmp = "";
let goodRoot = "";
let rigCount = 0;
const rigs: { bridge: EvalsBridge; server: http.Server }[] = [];

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

/** A scratch checkout. `header: false` writes a foreign `evals` script, `entry: false` leaves out the child's entry. */
function makeCheckout(name: string, opts: { header?: boolean; entry?: boolean; gitInit?: boolean } = {}): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, path.dirname(EVALS_ENTRY)), { recursive: true });
  const header = opts.header === false ? ["#!/bin/sh", "# some other tool", "exec true"] : [...EVALS_SCRIPT_HEADER];
  fs.writeFileSync(path.join(root, "evals"), `${header.join("\n")}\nroot="$(cd "$(dirname "$0")" && pwd)"\n`);
  if (opts.entry !== false) fs.writeFileSync(path.join(root, EVALS_ENTRY), FAKE_CHILD);
  if (opts.gitInit !== false) git(root, "init", "-q");
  return fs.realpathSync(root);
}

/** An EVALS_HOME whose checkout.json names `root` (or holds nothing when root is null). */
function makeHome(name: string, root: string | null): string {
  const home = path.join(tmp, `home-${name}`);
  fs.mkdirSync(home, { recursive: true });
  if (root !== null) pointAt(home, root);
  return home;
}

const pointAt = (home: string, root: string) =>
  fs.writeFileSync(path.join(home, "checkout.json"), JSON.stringify({ root, at: new Date().toISOString() }));

type Auth = { token?: string | null; origin?: string };

/**
 * One test's own world: a bridge, a loopback server bound to that bridge
 * alone, and a marker file only its children write. Nothing is shared with
 * other tests, so a request or child left over from an earlier test (one that
 * timed out under load, say) can never answer or count in this one.
 */
async function use(home: string, deps: Partial<EvalsBridgeDeps> = {}) {
  const marker = path.join(tmp, `execs-${++rigCount}.log`);
  const bridge = createEvalsBridge({
    evalsHome: () => home,
    repoRootOverride: () => undefined,
    env: () => ({ ...process.env, PATH: agentSpawnPath(path.dirname(process.execPath)), FAKE_MARKER: marker }),
    crashBackoffMs: 0,
    ...deps,
  });
  const server = http.createServer((req, res) => {
    if (!handleEvalsHttp(req, res, { token: TOKEN, log: () => {} }, bridge)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  rigs.push({ bridge, server });
  const port = (server.address() as AddressInfo).port;
  const api = (pathAndQuery: string, init: RequestInit = {}, auth: Auth = {}): Promise<Response> => {
    const token = auth.token === undefined ? TOKEN : auth.token;
    return fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
      ...init,
      headers: { Origin: auth.origin ?? ORIGIN, ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
  };
  const execs = () => (fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean) : []);
  return { bridge, api, execs };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (cond: () => boolean, ms = 30_000) => {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  return cond();
};

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "evals-bridge-")));
  goodRoot = makeCheckout("good");
});

afterEach(() => {
  for (const { bridge, server } of rigs.splice(0)) {
    bridge.stop();
    server.closeAllConnections();
    server.close();
  }
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("/evals envelope", () => {
  test("a missing token or a foreign origin gets 403 and execs nothing", async () => {
    const { api, execs } = await use(makeHome("auth", goodRoot));
    expect((await api("/evals/health", {}, { token: null })).status).toBe(403);
    expect((await api("/evals/health", {}, { token: "f".repeat(32) })).status).toBe(403);
    const foreign = await api("/evals/health", {}, { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    expect(await foreign.json()).toEqual({ error: "forbidden", reason: "forbidden" });
    expect(execs()).toEqual([]);
  });

  test("a path outside the contract is 404 and never starts the child", async () => {
    const { api, execs } = await use(makeHome("routes", goodRoot));
    expect((await api("/evals/nope")).status).toBe(404);
    expect((await api("/evals/health", { method: "POST", body: "{}" })).status).toBe(404);
    expect(execs()).toEqual([]);
  });

  test("the preflight answers with CORS for an allowed origin", async () => {
    const { api } = await use(makeHome("preflight", goodRoot));
    const res = await api("/evals/overview", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });
});

describe("checkout validation, before any exec", () => {
  const refused = async (home: string, reason: string, deps: Partial<EvalsBridgeDeps> = {}) => {
    const { api, execs } = await use(home, deps);
    const res = await api("/evals/health");
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.reason).toBe(reason);
    expect(typeof body.error).toBe("string");
    expect(execs()).toEqual([]);
    return body;
  };

  test("no checkout.json", async () => {
    const body = await refused(makeHome("missing", null), "no-checkout");
    expect(body.error).toContain("no codecast checkout has run ./evals");
  });

  test("checkout.json naming a folder that is gone", async () => {
    await refused(makeHome("gone", path.join(tmp, "deleted-checkout")), "no-checkout");
  });

  test("a checkout another user owns", async () => {
    await refused(makeHome("owner", goodRoot), "checkout-not-owned", { uid: () => (process.getuid?.() ?? 0) + 1 });
  });

  test("an evals script without the known header", async () => {
    await refused(makeHome("header", makeCheckout("foreign", { header: false })), "checkout-bad-header");
  });

  test("a folder that is not a git top level", async () => {
    await refused(makeHome("nogit", makeCheckout("nogit", { gitInit: false })), "checkout-not-toplevel");
  });

  test("a folder nested inside a git checkout", async () => {
    const nested = path.join(goodRoot, "nested");
    fs.mkdirSync(path.join(nested, path.dirname(EVALS_ENTRY)), { recursive: true });
    fs.writeFileSync(path.join(nested, "evals"), `${EVALS_SCRIPT_HEADER.join("\n")}\n`);
    fs.writeFileSync(path.join(nested, EVALS_ENTRY), FAKE_CHILD);
    await refused(makeHome("nested", nested), "checkout-not-toplevel");
  });

  test("a checkout without the child's entry", async () => {
    await refused(makeHome("entry", makeCheckout("noentry", { entry: false })), "checkout-no-entry");
  });

  test("no bun on PATH", async () => {
    const { api } = await use(makeHome("nobun", goodRoot), { command: () => ({ cmd: "codecast-test-no-such-bun", args: [] }) });
    const res = await api("/evals/health");
    expect(res.status).toBe(503);
    expect((await res.json()).reason).toBe("no-bun");
  });

  test("CODECAST_EVALS_REPO_ROOT names the checkout in place of checkout.json", async () => {
    const { api } = await use(makeHome("override", null), { repoRootOverride: () => goodRoot });
    expect((await api("/evals/health")).status).toBe(200);
  });
});

describe("the api child", () => {
  test("starts on demand in the checkout, once, and forwards method, path, query and body", async () => {
    const { api, execs } = await use(makeHome("happy", goodRoot));
    const first = await (await api("/evals/surface/settle?from=2026-09-01&model=x")).json();
    expect(first.cwd).toBe(goodRoot);
    expect(first.args).toEqual(["api", "--stdio"]);
    expect(first.req).toMatchObject({ method: "GET", path: "/surface/settle", query: { from: "2026-09-01", model: "x" } });
    const posted = await (await api("/evals/bisect/plan", { method: "POST", body: JSON.stringify({ surface: "settle", good: "a", bad: "b" }) })).json();
    expect(posted.req).toMatchObject({ method: "POST", path: "/bisect/plan", body: { surface: "settle", good: "a", bad: "b" } });
    expect(posted.pid).toBe(first.pid);
    expect(execs()).toHaveLength(1);
  });

  test("concurrent first requests start one child", async () => {
    const { api, execs } = await use(makeHome("burst", goodRoot));
    const bodies = await Promise.all([1, 2, 3, 4].map(async () => (await api("/evals/health")).json()));
    expect(new Set(bodies.map((b) => b.pid)).size).toBe(1);
    expect(execs()).toHaveLength(1);
  });

  test("a POST with a body that is not JSON is 400 before the child", async () => {
    const { api, execs } = await use(makeHome("badjson", goodRoot));
    const res = await api("/evals/bisect", { method: "POST", body: "{nope" });
    expect(res.status).toBe(400);
    expect(execs()).toEqual([]);
  });

  test("a crashed child answers 502 with its stderr, and the next request restarts it", async () => {
    const { bridge, api, execs } = await use(makeHome("crash", goodRoot));
    const ok = await (await api("/evals/health")).json();
    const res = await api("/evals/overview?crash=1");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.reason).toBe("child-crashed");
    expect(body.stderr).toEqual(["loading surfaces", "boom: cannot find module ./meta.ts"]);
    expect(bridge.pid()).toBeNull();
    const again = await (await api("/evals/health")).json();
    expect(again.pid).not.toBe(ok.pid);
    expect(execs()).toHaveLength(2);
  });

  test("inside the crash backoff the crash comes back without a fresh exec", async () => {
    const { api, execs } = await use(makeHome("backoff", goodRoot), { crashBackoffMs: 600_000 });
    expect((await api("/evals/overview?crash=1")).status).toBe(502);
    const res = await api("/evals/health");
    expect(res.status).toBe(502);
    expect((await res.json()).stderr).toContain("boom: cannot find module ./meta.ts");
    expect(execs()).toHaveLength(1);
  });

  test("the child is killed after the idle window, and a later request starts a new one", async () => {
    const { bridge, api } = await use(makeHome("idle", goodRoot), { idleMs: 150 });
    const { pid } = await (await api("/evals/health")).json();
    expect(alive(pid)).toBe(true);
    expect(await waitFor(() => !alive(pid))).toBe(true);
    expect(bridge.pid()).toBeNull();
    const next = await (await api("/evals/health")).json();
    expect(next.pid).not.toBe(pid);
  });

  test("a request in flight holds off the idle kill", async () => {
    const { api } = await use(makeHome("busy", goodRoot), { idleMs: 100 });
    const res = await api("/evals/health?slow=400");
    expect(res.status).toBe(200);
  });

  test("a child that never answers gets a 504 at the request timeout", async () => {
    const { api } = await use(makeHome("timeout", goodRoot), { requestTimeoutMs: 150 });
    const res = await api("/evals/health?slow=5000");
    expect(res.status).toBe(504);
  });

  test("stop ends the child", async () => {
    const { bridge, api } = await use(makeHome("stop", goodRoot));
    const { pid } = await (await api("/evals/health")).json();
    bridge.stop();
    expect(await waitFor(() => !alive(pid))).toBe(true);
  });
});

describe("a checkout.json that moves under a running child", () => {
  test("concurrent requests all restart once on the new root", async () => {
    const home = makeHome("moved", goodRoot);
    const other = makeCheckout("other");
    const { api, execs } = await use(home);
    const first = await (await api("/evals/health")).json();
    expect(first.cwd).toBe(goodRoot);
    pointAt(home, other);
    const replies = await Promise.all([1, 2, 3].map(() => api("/evals/health")));
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200]);
    const bodies = await Promise.all(replies.map((r) => r.json()));
    expect(new Set(bodies.map((b) => b.cwd))).toEqual(new Set([other]));
    expect(new Set(bodies.map((b) => b.pid)).size).toBe(1);
    expect(execs()).toHaveLength(2);
    expect(await waitFor(() => !alive(first.pid))).toBe(true);
  });

  test("a child that ends while the pointer is read is replaced, not dereferenced", async () => {
    let bridge!: EvalsBridge;
    let endMidRead = false;
    ({ bridge } = await use(makeHome("midread", null), {
      repoRootOverride: () => {
        if (endMidRead) {
          endMidRead = false;
          bridge.stop();
        }
        return goodRoot;
      },
    }));
    const first = await bridge.request({ method: "GET", path: "/health", query: {} });
    expect(first.status).toBe(200);
    endMidRead = true;
    const next = await bridge.request({ method: "GET", path: "/health", query: {} });
    expect(next.status).toBe(200);
    expect((next.body as { pid: number }).pid).not.toBe((first.body as { pid: number }).pid);
  });
});

describe("the handler never blocks", () => {
  test("a fast request overtakes a slow one, and the loop keeps turning", async () => {
    const { api } = await use(makeHome("async", goodRoot));
    await api("/evals/health");
    const order: string[] = [];
    const slow = api("/evals/health?slow=2000").then(() => order.push("slow"));
    const fast = api("/evals/overview").then(() => order.push("fast"));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    await Promise.all([slow, fast]);
    clearInterval(timer);
    expect(order).toEqual(["fast", "slow"]);
    expect(ticks).toBeGreaterThan(10);
  });

  test("handleEvalsHttp returns before the bridge answers, and answers once it does", async () => {
    let release!: () => void;
    const pending = new Promise<void>((r) => (release = r));
    const bridge: EvalsBridge = { request: async () => (await pending, { status: 200, body: {} }), stop: () => {}, pid: () => null };
    const req = Object.assign(new http.IncomingMessage(null as never), { url: "/evals/health", method: "GET", headers: { origin: ORIGIN, authorization: `Bearer ${TOKEN}` } });
    let status = 0;
    let ended!: () => void;
    const done = new Promise<void>((r) => (ended = r));
    const res = {
      headersSent: false,
      writeHead: (s: number) => ((status = s), res),
      end: () => ended(),
    } as unknown as http.ServerResponse;
    expect(handleEvalsHttp(req, res, { token: TOKEN, log: () => {} }, bridge)).toBe(true);
    expect(status).toBe(0);
    release();
    await done;
    expect(status).toBe(200);
  });

  test("neither file makes a synchronous call", () => {
    for (const file of ["evalsBridge.ts", "evalsServer.ts"]) {
      const src = fs.readFileSync(path.join(import.meta.dir, file), "utf8").replace(/^\s*(\/\/|\*).*$/gm, "");
      expect(src.match(/\b\w+Sync\s*\(/g) ?? []).toEqual([]);
    }
  });
});
describe("agreement with the eval tool", () => {
  test("the header matches the repo's own evals script", () => {
    const script = fs.readFileSync(path.join(import.meta.dir, "..", "..", "..", "..", "evals"), "utf8");
    expect(script.split("\n").slice(0, 3)).toEqual([...EVALS_SCRIPT_HEADER]);
  });

  test("the default EVALS_HOME is the one packages/evals/src/paths.ts resolves", async () => {
    const pathsFile = path.join(import.meta.dir, "..", "..", "..", "evals", "src", "paths.ts");
    const { evalsHome } = (await import(pathsFile)) as { evalsHome: () => string };
    const saved = process.env.CODECAST_EVALS_HOME;
    try {
      delete process.env.CODECAST_EVALS_HOME;
      expect(evalsHomeDir()).toBe(evalsHome());
      process.env.CODECAST_EVALS_HOME = path.join(tmp, "custom-home");
      expect(evalsHomeDir()).toBe(evalsHome());
    } finally {
      if (saved === undefined) delete process.env.CODECAST_EVALS_HOME;
      else process.env.CODECAST_EVALS_HOME = saved;
    }
  });
});
