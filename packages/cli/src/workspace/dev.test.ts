import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import {
  devServices, devStateDir, ensureService, expandVars, isAlive, parseProcNetTcp, pgidFromStat, portNameOf, readRecord, readyProbe, serviceStatus, stopService,
  type DevRecord, type DevService, type DevStatus,
} from "./dev.js";
import { detectProject } from "./detect.js";
import { isPortFree } from "./ports.js";
import { pollUntil } from "../test-helpers/pollUntil.js";
import type { ServiceSpec, WorkspaceManifest } from "./types.js";

let tmp: string;
const savedDir = process.env.CODECAST_DIR;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cast-dev-"));
  process.env.CODECAST_DIR = path.join(tmp, "state");
});
afterAll(() => {
  if (savedDir === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = savedDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function manifest(services: Record<string, ServiceSpec>, base = 47310): WorkspaceManifest {
  return {
    setup: { copy: [], share: [], install: [], generate: [], migrate: [] },
    ports: { web: { base, range: 1 } }, services, env: {}, teardown: { run: [] },
    browser: { enabled: false, headless: true, cdpPort: { base: 9222, range: 100 } }, backend: "local",
  };
}

const SERVER = `exec bun -e 'Bun.serve({ port: Number(process.env.PORT_WEB), fetch: () => new Response("ok") })'`;

describe("cast dev engine", () => {
  test("starts a server on a free port, reuses it, reports it, stops it", async () => {
    const checkout = fs.mkdtempSync(path.join(tmp, "repo-"));
    const m = manifest({ web: { mode: "isolated", start: SERVER, port: "web" } });
    const [svc] = devServices(m);
    const first = await ensureService(svc, { checkout, manifest: m, timeoutSec: 30 });
    expect(first.state).toBe("started");
    if (first.state !== "started") return;
    expect(first.record.port).toBeGreaterThanOrEqual(47310);
    expect(await (await fetch(first.record.url)).text()).toBe("ok");

    const again = await ensureService(svc, { checkout, manifest: m, timeoutSec: 30 });
    expect(again.state).toBe("running");
    if (again.state === "running") expect(again.record.pid).toBe(first.record.pid);
    expect((await serviceStatus(svc, checkout, m)).state).toBe("running");

    expect(await stopService(svc, checkout)).toBe(true);
    expect(isAlive(first.record.pid)).toBe(false);
    expect((await serviceStatus(svc, checkout, m)).state).toBe("stopped");
  }, 60_000);

  test("a server that exits is reported with its output", async () => {
    const checkout = fs.mkdtempSync(path.join(tmp, "repo-"));
    const m = manifest({ web: { mode: "isolated", start: "echo boom on $PORT_WEB; exit 3" } });
    const status = await ensureService(devServices(m)[0], { checkout, manifest: m, timeoutSec: 20 });
    expect(status.state).toBe("failed");
    if (status.state === "failed") expect(status.logTail).toContain("boom on 473");
  }, 30_000);

  test("the [vault] env reaches the server; a refusal fails the start before anything runs", async () => {
    const checkout = fs.mkdtempSync(path.join(tmp, "repo-"));
    const m = manifest({ web: { mode: "isolated", start: "echo key=$STRIPE_KEY; exit 3" } }, 47320);
    let asked = 0;
    const status = await ensureService(devServices(m)[0], { checkout, manifest: m, timeoutSec: 20, secretEnv: async () => (asked++, { STRIPE_KEY: "fake-value" }) });
    expect(asked).toBe(1);
    if (status.state === "failed") expect(status.logTail).toContain("key=fake-value");
    else throw new Error(`expected failed, got ${status.state}`);

    const refused = await ensureService(devServices(m)[0], { checkout, manifest: m, timeoutSec: 20, secretEnv: async () => { throw new Error("required in [vault]: STRIPE_KEY"); } });
    expect(refused).toEqual({ name: "web", state: "failed", reason: "required in [vault]: STRIPE_KEY" });
  }, 30_000);

  test("names, expansion and probes", () => {
    expect(portNameOf("web", { mode: "isolated", port: "$PORT_WEB" })).toBe("web");
    expect(portNameOf("api", { mode: "isolated" })).toBe("api");
    expect(expandVars("http:$PORT_WEB/health", { PORT_WEB: "3201" })).toBe("http:3201/health");
    expect(readyProbe({ mode: "isolated", readyCheck: "tcp:$PORT_DB" }, 1, { PORT_DB: "5432" })).toEqual({ kind: "tcp", port: 5432, path: "/" });
    expect(readyProbe({ mode: "isolated" }, 3201, {})).toEqual({ kind: "http", port: 3201, path: "/" });
  });
});

describe("dev server detection", () => {
  function repo(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(tmp, "detect-"));
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), body);
    }
    return root;
  }

  test("a vite app in packages/web with a dev script", () => {
    const root = repo({
      "bun.lock": "", "package.json": "{}",
      "packages/web/vite.config.ts": "", "packages/web/package.json": JSON.stringify({ scripts: { dev: "vite" } }),
    });
    expect(detectProject(root).services.web).toEqual({ mode: "isolated", start: `cd packages/web && bun run dev --port "$PORT_WEB"`, port: "web" });
  });

  test("a next app at the root under npm passes the port after --", () => {
    const root = repo({ "package-lock.json": "{}", "next.config.js": "", "package.json": JSON.stringify({ scripts: { dev: "next dev" } }) });
    expect(detectProject(root).services.web?.start).toBe(`npm run dev -- --port "$PORT_WEB"`);
  });

  test("no dev script, no service", () => {
    const root = repo({ "bun.lock": "", "vite.config.ts": "", "package.json": JSON.stringify({ scripts: { build: "vite build" } }) });
    expect(detectProject(root).services).toEqual({});
    expect(detectProject(root).browser.enabled).toBe(true);
  });
});

describe("cast dev never calls another checkout's server its own", () => {
  const running: ChildProcess[] = [];
  const started: Array<[DevService, string]> = [];
  afterAll(async () => {
    for (const [svc, checkout] of started) await stopService(svc, checkout);
    for (const child of running) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }
  });

  /** The first of `n` consecutive free ports, from a random start so concurrent runs do not collide. */
  async function freePorts(n: number): Promise<number> {
    for (let tries = 0; tries < 50; tries++) {
      const base = 41_000 + Math.floor(Math.random() * 18_000);
      const free = await Promise.all(Array.from({ length: n }, (_, i) => isPortFree(base + i)));
      if (!free.includes(false)) return base;
    }
    throw new Error(`no ${n} consecutive free ports`);
  }

  function gitRepo(): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(tmp, "checkout-")));
    execSync("git init -q", { cwd: root });
    return root;
  }

  /** A server answering `body` on `port`, run from `cwd` in its own process group like cast dev's. */
  async function serve(cwd: string, port: number, body: string, hostname = "0.0.0.0"): Promise<ChildProcess> {
    const child = spawn("bun", ["-e", `Bun.serve({ port: ${port}, hostname: "${hostname}", fetch: () => new Response("${body}") })`], { cwd, detached: true, stdio: "ignore" });
    running.push(child);
    const url = `http://${hostname.includes(":") ? `[${hostname}]` : "127.0.0.1"}:${port}/`;
    await pollUntil(() => fetch(url).then((r) => r.ok, () => false), `${body} server on ${port}`, { ms: 15_000, every: 100 });
    return child;
  }

  /** ensureService, with whatever it starts stopped after the suite even when an assertion fails. */
  function ensure(m: WorkspaceManifest, checkout: string, timeoutSec: number): Promise<DevStatus> {
    const svc = devServices(m)[0];
    started.push([svc, checkout]);
    return ensureService(svc, { checkout, manifest: m, timeoutSec });
  }

  function writeDevRecord(checkout: string, record: Partial<DevRecord> & { pid: number; port: number }): void {
    fs.mkdirSync(devStateDir(checkout), { recursive: true });
    fs.writeFileSync(path.join(devStateDir(checkout), "web.json"), JSON.stringify({
      name: "web", url: `http://localhost:${record.port}`, command: "", cwd: checkout, log: path.join(tmp, "none.log"), startedAt: "", ...record,
    }));
  }

  /** Our server, run from `checkout`, recorded on `port` while another checkout's server holds that port. */
  async function recordedOnTheirPort(port: number, ours: ChildProcess): Promise<string> {
    const checkout = gitRepo();
    writeDevRecord(checkout, { pid: ours.pid!, port });
    return checkout;
  }

  const text = async (url: string) => (await fetch(url)).text();
  const web = (base: number, env: Record<string, string> = {}) => ({ ...manifest({ web: { mode: "isolated", start: SERVER, port: "web" } }, base), env });

  test("a port another server holds only on ::1 is not free", async () => {
    const base = await freePorts(2);
    await serve(gitRepo(), base, "theirs", "::1");
    expect(await isPortFree(base)).toBe(false);
    const status = await ensure(web(base), gitRepo(), 30);
    if (status.state !== "started") throw new Error(`expected started, got ${JSON.stringify(status)}`);
    expect(status.record.port).toBe(base + 1);
    expect(await text(status.record.url)).toBe("ok");
  }, 60_000);

  test("a server that moves off its given port is reported where it listens", async () => {
    const base = await freePorts(3);
    const moves = `exec bun -e 'Bun.serve({ port: Number(process.env.PORT_WEB) + 2, fetch: () => new Response("moved") })'`;
    const m = manifest({ web: { mode: "isolated", start: moves, port: "web" } }, base);
    const status = await ensure(m, gitRepo(), 30);
    if (status.state !== "started") throw new Error(`expected started, got ${JSON.stringify(status)}`);
    expect(status.record.port).toBe(base + 2);
    expect(status.record.url).toBe(`http://localhost:${base + 2}`);
    expect(await text(status.record.url)).toBe("moved");
  }, 60_000);

  test("reuse: a recorded port another checkout answers on is not 'already running'", async () => {
    const base = await freePorts(2);
    const checkout = gitRepo();
    const nested = path.join(checkout, "nested-worktree");
    fs.mkdirSync(nested);
    execSync("git init -q", { cwd: nested });
    await serve(nested, base, "theirs");
    const ours = await serve(checkout, base + 1, "ours");
    writeDevRecord(checkout, { pid: ours.pid!, port: base });

    const status = await ensure(web(base), checkout, 10);
    if (status.state !== "running") throw new Error(`expected running, got ${JSON.stringify(status)}`);
    expect(status.record.port).toBe(base + 1);
    expect(await text(status.record.url)).toBe("ours");
    expect(readRecord(checkout, "web")?.port).toBe(base + 1);
  }, 60_000);

  test("reuse: our server listening nowhere while another checkout holds its port fails, naming that checkout", async () => {
    const base = await freePorts(1);
    const other = gitRepo();
    await serve(other, base, "theirs");
    const idle = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    running.push(idle);
    const checkout = await recordedOnTheirPort(base, idle);

    const status = await ensure(web(base), checkout, 3);
    expect(status.state).toBe("failed");
    if (status.state === "failed") expect(status.reason).toContain(`held by another checkout's server (${other}`);
    expect((await serviceStatus(devServices(web(base))[0], checkout, web(base))).state).toBe("failed");
  }, 30_000);

  test("an assigned port: another checkout's server fails, this checkout's own is external", async () => {
    const base = await freePorts(2);
    const other = gitRepo();
    await serve(other, base, "theirs");
    const checkout = gitRepo();
    const held = await ensure(web(base, { PORT_WEB: String(base) }), checkout, 10);
    expect(held.state).toBe("failed");
    if (held.state === "failed") expect(held.reason).toContain(other);

    fs.mkdirSync(path.join(checkout, "packages/web"), { recursive: true });
    await serve(path.join(checkout, "packages/web"), base + 1, "by hand");
    expect((await ensure(web(base + 1, { PORT_WEB: String(base + 1) }), checkout, 10)).state).toBe("external");
  }, 60_000);

  test.skipIf(process.platform === "linux")("an ordinary start and reuse ask lsof only about the server's own process group", async () => {
    const real = execSync("command -v lsof", { encoding: "utf-8" }).trim();
    const bin = fs.mkdtempSync(path.join(tmp, "bin-"));
    const calls = path.join(bin, "calls.log");
    fs.writeFileSync(path.join(bin, "lsof"), `#!/bin/sh\necho "$*" >> "${calls}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      const base = await freePorts(1);
      const checkout = gitRepo();
      expect((await ensure(web(base), checkout, 30)).state).toBe("started");
      expect((await ensure(web(base), checkout, 30)).state).toBe("running");
      const asked = fs.readFileSync(calls, "utf-8").trim().split("\n");
      expect(asked.length).toBeGreaterThan(0);
      // A query that walks every process on the machine took over 15s at a busy laptop's load.
      expect(asked.filter((args) => !args.includes(" -g "))).toEqual([]);
    } finally {
      process.env.PATH = savedPath;
    }
  }, 60_000);

  test.skipIf(process.platform === "linux")("when lsof cannot answer, no path calls the server on the port ours", async () => {
    const base = await freePorts(2);
    const other = gitRepo();
    await serve(other, base, "theirs");
    const ours = await serve(gitRepo(), base + 1, "ours");
    const checkout = await recordedOnTheirPort(base, ours);
    const bin = fs.mkdtempSync(path.join(tmp, "bin-"));
    fs.writeFileSync(path.join(bin, "lsof"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      const reuse = await ensure(web(base), checkout, 3);
      expect(reuse.state).toBe("failed");
      if (reuse.state === "failed") expect(reuse.reason).toContain("could not tell which process listens");
      expect((await serviceStatus(devServices(web(base))[0], checkout, web(base))).state).toBe("failed");
      const assigned = await ensure(web(base, { PORT_WEB: String(base) }), gitRepo(), 3);
      expect(assigned.state).toBe("failed");
    } finally {
      process.env.PATH = savedPath;
    }
  }, 60_000);
});

describe("reading listeners from /proc", () => {
  test("LISTEN rows of /proc/net/tcp, by socket inode", () => {
    const table = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:0C81 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41234 1 0000000000000000 100 0 0 10 0",
      "   1: 0100007F:0C82 0100007F:A1B2 01 00000000:00000000 00:00000000 00000000  1000        0 41299 1 0000000000000000 20 4 30 10 -1",
    ].join("\n");
    expect([...parseProcNetTcp(table)]).toEqual([["41234", 3201]]);
  });

  test("the process group from a stat line whose command holds spaces and parens", () => {
    expect(pgidFromStat("4242 (node (vite) dev) S 4200 4100 4100 0 -1 4194560 1203")).toBe(4100);
  });
});
