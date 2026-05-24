import { describe, test, expect, afterEach } from "bun:test";
import { createServer, type Server } from "node:net";
import {
  allocatePorts,
  computePorts,
  isPortFree,
  portsToEnv,
  PortAllocationError,
} from "./ports.js";
import type { WorkspaceManifest } from "./types.js";

// Track sockets we open during tests so afterEach can close them all.
const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.map(
      (s) =>
        new Promise<void>((resolve) => {
          try {
            s.close(() => resolve());
          } catch {
            resolve();
          }
        }),
    ),
  );
  openServers.length = 0;
});

function holdPort(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    openServers.push(s);
    s.once("error", reject);
    s.once("listening", () => resolve(s));
    s.listen(port, "127.0.0.1");
  });
}

const sampleManifest = (): WorkspaceManifest => ({
  setup: { copy: [], install: [], generate: [], migrate: [] },
  ports: {
    web: { base: 33000, range: 100 },
    api: { base: 33001, range: 100 },
    db: { base: 33002, range: 100 },
  },
  services: {},
  env: {},
  teardown: { run: [] },
  browser: { enabled: false, headless: true, cdpPort: { base: 9222, range: 100 } },
  backend: "local",
});

// ---------------------------------------------------------------------------
// computePorts (pure arithmetic)
// ---------------------------------------------------------------------------

describe("computePorts", () => {
  test("returns base when index=0", () => {
    expect(computePorts(sampleManifest(), 0)).toEqual({
      web: 33000,
      api: 33001,
      db: 33002,
    });
  });

  test("base + index*range when index>0", () => {
    expect(computePorts(sampleManifest(), 2)).toEqual({
      web: 33200,
      api: 33201,
      db: 33202,
    });
  });

  test("empty ports → empty map", () => {
    const m = sampleManifest();
    m.ports = {};
    expect(computePorts(m, 5)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// portsToEnv
// ---------------------------------------------------------------------------

describe("portsToEnv", () => {
  test("uppercases names and stringifies port numbers", () => {
    expect(portsToEnv({ web: 3000, api: 3001, db: 3002 })).toEqual({
      PORT_WEB: "3000",
      PORT_API: "3001",
      PORT_DB: "3002",
    });
  });

  test("empty ports → empty env", () => {
    expect(portsToEnv({})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// allocatePorts (noProbe — purely arithmetic, fast)
// ---------------------------------------------------------------------------

describe("allocatePorts (noProbe)", () => {
  test("returns startIndex when noProbe=true", async () => {
    const m = sampleManifest();
    const alloc = await allocatePorts(m, { startIndex: 3, noProbe: true });
    expect(alloc.resourceIndex).toBe(3);
    expect(alloc.ports.web).toBe(33300);
    expect(alloc.env.PORT_WEB).toBe("33300");
  });

  test("five simultaneous workspaces get unique ports per name (sequential indices)", async () => {
    const m = sampleManifest();
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map((i) => allocatePorts(m, { startIndex: i, noProbe: true })),
    );
    const webPorts = results.map((r) => r.ports.web);
    const apiPorts = results.map((r) => r.ports.api);
    expect(new Set(webPorts).size).toBe(5);
    expect(new Set(apiPorts).size).toBe(5);
  });

  test("empty ports → empty allocation, startIndex preserved", async () => {
    const m = sampleManifest();
    m.ports = {};
    const alloc = await allocatePorts(m, { startIndex: 7 });
    expect(alloc).toEqual({ ports: {}, env: {}, resourceIndex: 7 });
  });
});

// ---------------------------------------------------------------------------
// allocatePorts (with TCP probe) — collision avoidance
// ---------------------------------------------------------------------------

describe("allocatePorts (live probe)", () => {
  test("happy path: ports free, returns first attempted index", async () => {
    const m = sampleManifest();
    const alloc = await allocatePorts(m, { startIndex: 0 });
    expect(alloc.resourceIndex).toBe(0);
    expect(alloc.ports.web).toBe(33000);
  });

  test("collision detected: bumps to next index", async () => {
    const m = sampleManifest();
    // Hold the 'web' port at index=0 so allocator must move to index=1.
    await holdPort(33000);
    const alloc = await allocatePorts(m, { startIndex: 0 });
    expect(alloc.resourceIndex).toBeGreaterThanOrEqual(1);
    // The chosen 'web' port should not be the held one.
    expect(alloc.ports.web).not.toBe(33000);
  });

  test("throws PortAllocationError when all attempts collide", async () => {
    const m: WorkspaceManifest = {
      ...sampleManifest(),
      ports: { web: { base: 34000, range: 1 } },
    };
    // Block 3 consecutive ports so all 3 attempted indices fail.
    await holdPort(34000);
    await holdPort(34001);
    await holdPort(34002);
    await expect(
      allocatePorts(m, { startIndex: 0, maxIndices: 3 }),
    ).rejects.toBeInstanceOf(PortAllocationError);
  });

  test("error carries the list of conflicting ports", async () => {
    const m: WorkspaceManifest = {
      ...sampleManifest(),
      ports: { web: { base: 34100, range: 1 } },
    };
    await holdPort(34100);
    try {
      await allocatePorts(m, { startIndex: 0, maxIndices: 1 });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(PortAllocationError);
      const pe = e as PortAllocationError;
      expect(pe.conflicts).toEqual([{ name: "web", port: 34100 }]);
    }
  });
});

// ---------------------------------------------------------------------------
// isPortFree
// ---------------------------------------------------------------------------

describe("isPortFree", () => {
  test("returns true for an unbound high port", async () => {
    // Pick a random high port that's almost certainly free.
    expect(await isPortFree(34900)).toBe(true);
  });

  test("returns false for a port we currently bind", async () => {
    await holdPort(34901);
    expect(await isPortFree(34901)).toBe(false);
  });
});
