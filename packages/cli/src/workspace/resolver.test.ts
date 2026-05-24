import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mergeManifests, resolveManifest, MANIFEST_REL_PATH } from "./resolver.js";
import type { WorkspaceManifest } from "./types.js";

const emptyManifest = (): WorkspaceManifest => ({
  setup: { copy: [], install: [], generate: [], migrate: [] },
  ports: {},
  services: {},
  env: {},
  teardown: { run: [] },
  browser: { enabled: false, headless: true, cdpPort: { base: 9222, range: 100 } },
  backend: "local",
});

// ---------------------------------------------------------------------------
// mergeManifests — pure merge semantics
// ---------------------------------------------------------------------------

describe("mergeManifests", () => {
  test("null override returns base unchanged", () => {
    const base: WorkspaceManifest = {
      ...emptyManifest(),
      setup: { copy: [".env"], install: ["bun install"], generate: [], migrate: [] },
      detected: "bun",
    };
    expect(mergeManifests(base, null)).toBe(base);
  });

  test("non-empty override array replaces detection", () => {
    const base: WorkspaceManifest = {
      ...emptyManifest(),
      setup: { copy: [], install: ["bun install"], generate: [], migrate: [] },
    };
    const override: WorkspaceManifest = {
      ...emptyManifest(),
      setup: {
        copy: [],
        install: ["bun install", "bun run setup"],
        generate: [],
        migrate: [],
      },
    };
    expect(mergeManifests(base, override).setup.install).toEqual([
      "bun install",
      "bun run setup",
    ]);
  });

  test("absent (empty) override array keeps detection's value", () => {
    const base: WorkspaceManifest = {
      ...emptyManifest(),
      setup: { copy: [".env"], install: ["bun install"], generate: [], migrate: [] },
    };
    const override: WorkspaceManifest = {
      ...emptyManifest(),
      // copy and install both empty (absent in TOML)
      setup: { copy: [], install: [], generate: ["bun run codegen"], migrate: [] },
    };
    const merged = mergeManifests(base, override);
    expect(merged.setup.copy).toEqual([".env"]);
    expect(merged.setup.install).toEqual(["bun install"]);
    expect(merged.setup.generate).toEqual(["bun run codegen"]);
  });

  test("ports merge per-key (override wins for same key, others preserved)", () => {
    const base: WorkspaceManifest = {
      ...emptyManifest(),
      ports: {
        web: { base: 3000, range: 100 },
        api: { base: 3001, range: 100 },
      },
    };
    const override: WorkspaceManifest = {
      ...emptyManifest(),
      ports: {
        api: { base: 4001, range: 50 }, // override
        db: { base: 5432, range: 100 }, // new key
      },
    };
    const merged = mergeManifests(base, override);
    expect(merged.ports.web).toEqual({ base: 3000, range: 100 });
    expect(merged.ports.api).toEqual({ base: 4001, range: 50 });
    expect(merged.ports.db).toEqual({ base: 5432, range: 100 });
  });

  test("services merge per-key", () => {
    const base: WorkspaceManifest = {
      ...emptyManifest(),
      services: {
        redis: { mode: "shared", url: "redis://localhost:6379" },
      },
    };
    const override: WorkspaceManifest = {
      ...emptyManifest(),
      services: {
        postgres: { mode: "isolated", start: "pg_ctl start" },
      },
    };
    const merged = mergeManifests(base, override);
    expect(merged.services.redis?.mode).toBe("shared");
    expect(merged.services.postgres?.mode).toBe("isolated");
  });

  test("env merge per-key (override wins)", () => {
    const base: WorkspaceManifest = {
      ...emptyManifest(),
      env: { NODE_ENV: "development", DEBUG: "false" },
    };
    const override: WorkspaceManifest = {
      ...emptyManifest(),
      env: { DEBUG: "true", LOG_LEVEL: "info" },
    };
    const merged = mergeManifests(base, override);
    expect(merged.env).toEqual({
      NODE_ENV: "development",
      DEBUG: "true",
      LOG_LEVEL: "info",
    });
  });

  test("teardown.run: override replaces if non-empty, else keeps base", () => {
    const base: WorkspaceManifest = {
      ...emptyManifest(),
      teardown: { run: ["bun run cleanup"] },
    };
    const override1: WorkspaceManifest = {
      ...emptyManifest(),
      teardown: { run: [] }, // absent
    };
    expect(mergeManifests(base, override1).teardown.run).toEqual(["bun run cleanup"]);

    const override2: WorkspaceManifest = {
      ...emptyManifest(),
      teardown: { run: ["docker compose down"] },
    };
    expect(mergeManifests(base, override2).teardown.run).toEqual(["docker compose down"]);
  });

  test("detected: base wins unless override sets it explicitly", () => {
    const base: WorkspaceManifest = { ...emptyManifest(), detected: "bun" };
    const override1: WorkspaceManifest = { ...emptyManifest() };
    expect(mergeManifests(base, override1).detected).toBe("bun");

    const override2: WorkspaceManifest = { ...emptyManifest(), detected: "custom-runner" };
    expect(mergeManifests(base, override2).detected).toBe("custom-runner");
  });
});

// ---------------------------------------------------------------------------
// resolveManifest — wired against real filesystem
// ---------------------------------------------------------------------------

describe("resolveManifest", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-resolve-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(rel: string, content: string) {
    const p = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }

  test("detection-only yields a working manifest", () => {
    write("package.json", "{}");
    write("bun.lock", "");
    const m = resolveManifest(tmpDir);
    expect(m.detected).toBe("bun");
    expect(m.setup.install).toEqual(["bun install"]);
  });

  test("manifest file overrides install command", () => {
    write("package.json", "{}");
    write("bun.lock", "");
    write(
      MANIFEST_REL_PATH,
      `[setup]\ninstall = ["bun install", "bun run init:db"]\n`,
    );
    const m = resolveManifest(tmpDir);
    expect(m.setup.install).toEqual(["bun install", "bun run init:db"]);
    expect(m.detected).toBe("bun"); // detection label preserved
  });

  test("partial manifest fills missing fields from detection", () => {
    write("package.json", "{}");
    write("bun.lock", "");
    write(".env", "FOO=1");
    // manifest only declares ports; install + copy come from detection
    write(
      MANIFEST_REL_PATH,
      `[ports.web]\nbase = 3000\nrange = 100\n`,
    );
    const m = resolveManifest(tmpDir);
    expect(m.setup.install).toEqual(["bun install"]); // from detection
    expect(m.setup.copy).toEqual([".env"]); // from detection
    expect(m.ports.web).toEqual({ base: 3000, range: 100 }); // from file
  });

  test("manifest adds services where detection found none", () => {
    write("package.json", "{}");
    write("bun.lock", "");
    write(
      MANIFEST_REL_PATH,
      `[services.redis]\nmode = "shared"\nurl = "redis://localhost:6379"\n`,
    );
    const m = resolveManifest(tmpDir);
    expect(m.services.redis?.mode).toBe("shared");
    expect(m.services.redis?.url).toBe("redis://localhost:6379");
  });
});
