import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { devServices, ensureService, expandVars, isAlive, portNameOf, readyProbe, serviceStatus, stopService } from "./dev.js";
import { detectProject } from "./detect.js";
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
