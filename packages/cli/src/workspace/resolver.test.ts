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

  test("staged manifest and copy list override inputs while real repo drives toolchain detection", () => {
    write("package.json", '{"scripts":{"codegen":"true"}}');
    write("bun.lock", "");
    write(".env", "base-only");
    write(MANIFEST_REL_PATH, '[setup]\ninstall = ["exit 99"]\n');
    write("inputs/package-lock.json", "{}");
    write("inputs/.wt-setup-files", "secrets/key\n");
    write(`inputs/${MANIFEST_REL_PATH}`, '[env]\nSNAPSHOT = "local"\n');
    const m = resolveManifest(tmpDir, path.join(tmpDir, "inputs"));
    expect(m.detected).toBe("bun");
    expect(m.setup.install).toEqual(["bun install"]);
    expect(m.setup.generate).toEqual(["bun run codegen"]);
    expect(m.setup.copy).toEqual(["secrets/key"]);
    expect(m.env.SNAPSHOT).toBe("local");
  });

  test("staged env defaults do not pick up base secrets or base manifest when no override exists", () => {
    write("package.json", "{}");
    write("bun.lock", "");
    write(".env", "base-only");
    write(MANIFEST_REL_PATH, '[setup]\ninstall = ["exit 99"]\n');
    write("inputs/.env.local", "snapshot-only");
    const m = resolveManifest(tmpDir, path.join(tmpDir, "inputs"));
    expect(m.setup.copy).toEqual([".env.local"]);
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

// ---------------------------------------------------------------------------
// withAgentConfigCopies — project-level untracked agent config at FILE granularity
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { AGENT_CONFIG_COPY_CANDIDATES, withAgentConfigCopies } from "./resolver.js";

describe("withAgentConfigCopies", () => {
  let repo: string;
  const warnings: string[] = [];
  const warn = (m: string) => { warnings.push(m); };

  function git(...args: string[]): string {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8", stdio: "pipe" }).trim();
  }
  function write(rel: string, content = "x\n") {
    const p = path.join(repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  function commit(rel: string, content = "tracked\n") {
    write(rel, content);
    git("add", rel);
    git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  }
  function copyOf(m: WorkspaceManifest) {
    return m.setup.copy;
  }

  beforeEach(() => {
    warnings.length = 0;
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ws-agent-copy-")));
    git("init", "-q", "-b", "main");
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("tracked files stay out; untracked and gitignored ones ride along, one file each, beside a tracked sibling", () => {
    commit("CLAUDE.md");
    commit(".gitignore", "CLAUDE.local.md\n.env\n");
    commit(".claude/skills/a/SKILL.md");
    write("CLAUDE.local.md", "personal\n");
    write(".claude/settings.local.json", "{}");
    write(".claude/skills/b/SKILL.md", "untracked skill\n");
    write(".claude/skills/b/helper.py");
    write(".env", "SECRET\n");
    write("AGENTS.md", "untracked agents\n");
    write(".mcp.json", "{}");
    const m = resolveManifest(repo);
    expect(copyOf(m)).toEqual([".env", ".claude/settings.local.json", ".claude/skills/b/SKILL.md", ".claude/skills/b/helper.py", ".mcp.json", "AGENTS.md", "CLAUDE.local.md"]);
    expect(copyOf(m)).not.toContain("CLAUDE.md");
    expect(copyOf(m)).not.toContain(".claude/skills/a/SKILL.md");
    expect(copyOf(m)).toContain(".mcp.json");
  });

  test("a file under a symlinked component is skipped with a warning; the rest still ships", () => {
    commit("README.md");
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), "ws-shared-"));
    fs.writeFileSync(path.join(shared, "SKILL.md"), "shared\n");
    fs.mkdirSync(path.join(repo, ".claude/skills"), { recursive: true });
    fs.symlinkSync(shared, path.join(repo, ".claude/skills/linked"));
    write(".claude/skills/local/SKILL.md");
    try {
      const m = withAgentConfigCopies(emptyManifest(), repo, { isInputRoot: false, warn });
      expect(copyOf(m)).toEqual([".claude/skills/local/SKILL.md"]);
      expect(warnings.some((w) => w.includes(".claude/skills/linked") && w.includes("symlink"))).toBe(true);
    } finally {
      fs.rmSync(shared, { recursive: true, force: true });
    }
  });

  test("more than 200 context files are retained instead of silently dropping the directory", () => {
    commit("README.md");
    for (let i = 0; i < 210; i++) write(`.claude/skills/big/f${i}.md`);
    write(".claude/commands/c.md");
    const m = withAgentConfigCopies(emptyManifest(), repo, { isInputRoot: false, warn });
    expect(copyOf(m)).toHaveLength(211);
    expect(copyOf(m)).toContain(".claude/commands/c.md");
    expect(warnings).toEqual([]);
  });

  test("explicit setup.copy in workspace.toml is appended to, not replaced; a covering entry is not duplicated", () => {
    commit("README.md");
    write(".codecast/workspace.toml", '[setup]\ncopy = ["secrets", ".claude/skills"]\n');
    write("secrets/key");
    write(".claude/skills/x/SKILL.md");
    write("CLAUDE.local.md");
    const m = resolveManifest(repo);
    expect(copyOf(m)).toEqual(["secrets", ".claude/skills", "CLAUDE.local.md"]);
  });

  test("an input root lists every present candidate file without git; a non-repo root does the same", () => {
    const inputs = path.join(repo, ".codecast/workspaces/cloud-1/inputs");
    fs.mkdirSync(inputs, { recursive: true });
    fs.writeFileSync(path.join(inputs, "CLAUDE.local.md"), "staged\n");
    fs.mkdirSync(path.join(inputs, ".claude/skills/s"), { recursive: true });
    fs.writeFileSync(path.join(inputs, ".claude/skills/s/SKILL.md"), "staged\n");
    fs.writeFileSync(path.join(inputs, ".mcp.json"), "{}");
    commit("CLAUDE.md");
    const m = resolveManifest(repo, inputs);
    expect(copyOf(m)).toEqual([".claude/skills/s/SKILL.md", ".mcp.json", "CLAUDE.local.md"]);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "ws-plain-"));
    try {
      fs.writeFileSync(path.join(plain, "AGENTS.md"), "a\n");
      expect(copyOf(withAgentConfigCopies(emptyManifest(), plain, { isInputRoot: false }))).toEqual(["AGENTS.md"]);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  test("noise under a candidate never ships; existing .env detection is unchanged", () => {
    commit("README.md");
    write(".claude/skills/x/node_modules/dep/index.js");
    write(".claude/skills/x/.DS_Store");
    write(".claude/skills/x/SKILL.md");
    write(".env");
    const m = resolveManifest(repo);
    expect(copyOf(m)).toEqual([".env", ".claude/skills/x/SKILL.md"]);
    expect(AGENT_CONFIG_COPY_CANDIDATES).toContain(".mcp.json");
  });
});
