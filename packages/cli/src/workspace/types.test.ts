import { describe, test, expect } from "bun:test";
import * as workspace from "./index.js";
import {
  toWorktreeResult,
  type AcquireOptions,
  type ContractCheck,
  type ContractResult,
  type HookName,
  type PortSpec,
  type ServiceMode,
  type ServiceSpec,
  type SetupSpec,
  type TeardownSpec,
  type Workspace,
  type WorkspaceManifest,
  type WorkspaceState,
  type WorktreeResultCompat,
} from "./types.js";

describe("workspace types", () => {
  test("public API surface exists", () => {
    // Functions are exported and callable (will throw 'not implemented' for now)
    expect(typeof workspace.acquire).toBe("function");
    expect(typeof workspace.release).toBe("function");
    expect(typeof workspace.heal).toBe("function");
    expect(typeof workspace.validate).toBe("function");
    expect(typeof workspace.list).toBe("function");
    expect(typeof workspace.resolveManifest).toBe("function");
    expect(typeof workspace.toWorktreeResult).toBe("function");
  });

  test("WorkspaceManifest accepts a typical declarative shape", () => {
    const m: WorkspaceManifest = {
      setup: {
        copy: [".env", ".env.local", "credentials.json"],
        install: ["bun install"],
        generate: ["bun run codegen"],
        migrate: ["bun run db:migrate"],
      },
      ports: {
        web: { base: 3000, range: 100 },
        api: { base: 3001, range: 100 },
        convex: { base: 3210, range: 100 },
      },
      services: {
        postgres: {
          mode: "isolated",
          start: "pg_ctl start",
          stop: "pg_ctl stop",
          port: "$PORT_DB",
          readyCheck: "tcp:$PORT_DB",
          readyTimeoutSec: 30,
        },
        redis: {
          mode: "shared",
          url: "redis://localhost:6379",
        },
      },
      env: { NODE_ENV: "development" },
      teardown: { run: ["bun run db:reset"] },
      browser: { enabled: false, headless: true, cdpPort: { base: 9222, range: 100 } },
      backend: "local",
      detected: "bun",
    };
    expect(m.setup.install).toContain("bun install");
    expect(m.ports.web?.base).toBe(3000);
    expect(m.services.postgres?.mode).toBe("isolated");
    expect(m.services.redis?.mode).toBe("shared");
  });

  test("HookName covers the six lifecycle events", () => {
    const hooks: HookName[] = [
      "before-create",
      "after-create",
      "before-agent",
      "after-agent",
      "before-merge",
      "after-merge",
    ];
    expect(hooks).toHaveLength(6);
  });

  test("WorkspaceState covers all expected states", () => {
    const states: WorkspaceState[] = ["creating", "ready", "broken", "destroying"];
    expect(states).toHaveLength(4);
  });

  test("ContractResult shape supports per-check reasons", () => {
    const result: ContractResult = {
      ok: false,
      checks: [
        { name: "worktree-exists", ok: true },
        { name: "node_modules", ok: false, reason: "directory missing" },
      ],
    };
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === "node_modules")?.reason).toBe(
      "directory missing",
    );
  });

  test("toWorktreeResult projects Workspace to legacy shape", () => {
    const ws: Workspace = {
      name: "my-feat",
      path: "/repo/.codecast/worktrees/my-feat",
      branch: "codecast/my-feat",
      resourceIndex: 2,
      manifest: {
        setup: { copy: [], install: [], generate: [], migrate: [] },
        ports: {},
        services: {},
        env: {},
        teardown: { run: [] },
        browser: { enabled: false, headless: true, cdpPort: { base: 9222, range: 100 } },
        backend: "local",
      },
      ports: {},
      env: {},
      state: "ready",
    };
    const legacy: WorktreeResultCompat = toWorktreeResult(ws);
    expect(legacy.worktreePath).toBe(ws.path);
    expect(legacy.worktreeName).toBe(ws.name);
    expect(legacy.worktreeBranch).toBe(ws.branch);
    expect(legacy.portIndex).toBe(ws.resourceIndex);
  });

  test("AcquireOptions, ServiceMode, ServiceSpec etc are usable types", () => {
    const opts: AcquireOptions = { branch: "feat/x", resourceIndex: 3, skipSetup: true, skipHooks: false };
    const mode: ServiceMode = "shared";
    const service: ServiceSpec = { mode, url: "redis://localhost:6379" };
    const setup: SetupSpec = { copy: [], install: [], generate: [], migrate: [] };
    const td: TeardownSpec = { run: [] };
    const port: PortSpec = { base: 4000, range: 50 };
    const check: ContractCheck = { name: "x", ok: true };
    expect(opts.branch).toBe("feat/x");
    expect(service.mode).toBe("shared");
    expect(setup.copy).toEqual([]);
    expect(td.run).toEqual([]);
    expect(port.base).toBe(4000);
    expect(check.ok).toBe(true);
  });

  test("acquire stub rejects with not-implemented", async () => {
    await expect(workspace.acquire("/tmp", "x")).rejects.toThrow("not yet implemented");
  });
});
