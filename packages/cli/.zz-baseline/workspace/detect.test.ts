import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectProject } from "./detect.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-detect-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function touch(rel: string, content = "") {
  const p = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// ---------------------------------------------------------------------------
// Single-language project types
// ---------------------------------------------------------------------------

describe("detectProject — JS/TS package managers", () => {
  test("bun (bun.lock present)", () => {
    touch("package.json", "{}");
    touch("bun.lock");
    const m = detectProject(tmpDir);
    expect(m.detected).toBe("bun");
    expect(m.setup.install).toEqual(["bun install"]);
  });

  test("pnpm (pnpm-lock.yaml present)", () => {
    touch("package.json", "{}");
    touch("pnpm-lock.yaml");
    const m = detectProject(tmpDir);
    expect(m.detected).toBe("pnpm");
    expect(m.setup.install).toEqual(["pnpm install --frozen-lockfile"]);
  });

  test("yarn (yarn.lock present)", () => {
    touch("package.json", "{}");
    touch("yarn.lock");
    const m = detectProject(tmpDir);
    expect(m.detected).toBe("yarn");
    expect(m.setup.install).toEqual(["yarn install --immutable"]);
  });

  test("npm (package-lock.json present)", () => {
    touch("package.json", "{}");
    touch("package-lock.json");
    const m = detectProject(tmpDir);
    expect(m.detected).toBe("npm");
    expect(m.setup.install).toEqual(["npm ci"]);
  });

  test("npm fallback (package.json only)", () => {
    touch("package.json", "{}");
    const m = detectProject(tmpDir);
    expect(m.detected).toBe("npm");
    expect(m.setup.install).toEqual(["npm install"]);
  });

  test("bun.lockb is also recognized", () => {
    touch("package.json", "{}");
    touch("bun.lockb");
    expect(detectProject(tmpDir).detected).toBe("bun");
  });
});

describe("detectProject — Python", () => {
  test("uv (uv.lock present)", () => {
    touch("pyproject.toml");
    touch("uv.lock");
    const m = detectProject(tmpDir);
    expect(m.detected).toBe("uv");
    expect(m.setup.install).toEqual(["uv sync"]);
  });

  test("poetry (poetry.lock present)", () => {
    touch("pyproject.toml");
    touch("poetry.lock");
    const m = detectProject(tmpDir);
    expect(m.detected).toBe("poetry");
    expect(m.setup.install).toEqual(["poetry install"]);
  });

  test("pipenv (Pipfile.lock)", () => {
    touch("Pipfile");
    touch("Pipfile.lock");
    expect(detectProject(tmpDir).setup.install).toEqual(["pipenv sync"]);
  });

  test("plain requirements.txt", () => {
    touch("requirements.txt");
    expect(detectProject(tmpDir).setup.install).toEqual([
      "pip install -r requirements.txt",
    ]);
  });

  test("pyproject.toml only (editable install)", () => {
    touch("pyproject.toml");
    expect(detectProject(tmpDir).setup.install).toEqual(["pip install -e ."]);
  });
});

describe("detectProject — Rust / Go / Ruby", () => {
  test("Rust (Cargo.toml)", () => {
    touch("Cargo.toml", "[package]\nname = \"x\"\n");
    const m = detectProject(tmpDir);
    expect(m.detected).toBe("cargo");
    expect(m.setup.install).toEqual(["cargo fetch"]);
  });

  test("Go (go.mod)", () => {
    touch("go.mod", "module x\n");
    const m = detectProject(tmpDir);
    expect(m.detected).toBe("go");
    expect(m.setup.install).toEqual(["go mod download"]);
  });

  test("Ruby (Gemfile)", () => {
    touch("Gemfile");
    expect(detectProject(tmpDir).setup.install).toEqual(["bundle install"]);
  });
});

// ---------------------------------------------------------------------------
// Composition: polyglot repos
// ---------------------------------------------------------------------------

describe("detectProject — polyglot composition", () => {
  test("bun + cargo together", () => {
    touch("package.json", "{}");
    touch("bun.lock");
    touch("Cargo.toml", "[package]\nname = \"x\"\n");
    const m = detectProject(tmpDir);
    expect(m.detected).toBe("bun+cargo");
    expect(m.setup.install).toEqual(["bun install", "cargo fetch"]);
  });

  test("npm + uv + go", () => {
    touch("package.json", "{}");
    touch("package-lock.json");
    touch("pyproject.toml");
    touch("uv.lock");
    touch("go.mod", "module x");
    const m = detectProject(tmpDir);
    expect(m.detected).toBe("npm+uv+go");
    expect(m.setup.install).toEqual([
      "npm ci",
      "uv sync",
      "go mod download",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

describe("detectProject — generators", () => {
  test("prisma schema with bun: uses bunx", () => {
    touch("package.json", "{}");
    touch("bun.lock");
    touch("prisma/schema.prisma", "datasource db { provider = \"postgresql\" url = env(\"DB\") }");
    const m = detectProject(tmpDir);
    expect(m.setup.generate).toEqual(["bunx prisma generate"]);
  });

  test("prisma schema with pnpm: uses pnpm exec", () => {
    touch("package.json", "{}");
    touch("pnpm-lock.yaml");
    touch("prisma/schema.prisma", "");
    expect(detectProject(tmpDir).setup.generate).toEqual(["pnpm exec prisma generate"]);
  });

  test("prisma schema with npm: uses npx", () => {
    touch("package.json", "{}");
    touch("package-lock.json");
    touch("prisma/schema.prisma", "");
    expect(detectProject(tmpDir).setup.generate).toEqual(["npx prisma generate"]);
  });

  test("package.json script 'codegen' picked up", () => {
    touch("package.json", JSON.stringify({ scripts: { codegen: "tsx scripts/gen.ts" } }));
    touch("bun.lock");
    expect(detectProject(tmpDir).setup.generate).toEqual(["bun run codegen"]);
  });

  test("package.json script 'generate' picked up as fallback", () => {
    touch("package.json", JSON.stringify({ scripts: { generate: "tsx scripts/gen.ts" } }));
    touch("pnpm-lock.yaml");
    expect(detectProject(tmpDir).setup.generate).toEqual(["pnpm run generate"]);
  });

  test("'codegen' beats 'generate' if both present", () => {
    touch("package.json", JSON.stringify({ scripts: { codegen: "a", generate: "b" } }));
    touch("bun.lock");
    expect(detectProject(tmpDir).setup.generate).toEqual(["bun run codegen"]);
  });

  test("malformed package.json doesn't crash detection", () => {
    touch("package.json", "{ NOT json");
    touch("bun.lock");
    const m = detectProject(tmpDir);
    // Install still detected; generate left empty.
    expect(m.setup.install).toEqual(["bun install"]);
    expect(m.setup.generate).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Copy list
// ---------------------------------------------------------------------------

describe("detectProject — copy list", () => {
  test(".wt-setup-files honored when present", () => {
    touch("package.json", "{}");
    touch("bun.lock");
    touch(".wt-setup-files", "# comment\n.env\n.env.local\ncredentials.json\n\n");
    const m = detectProject(tmpDir);
    expect(m.setup.copy).toEqual([".env", ".env.local", "credentials.json"]);
  });

  test(".env files auto-suggested when present and no .wt-setup-files", () => {
    touch("package.json", "{}");
    touch("bun.lock");
    touch(".env", "FOO=bar");
    touch(".env.local", "BAR=baz");
    expect(detectProject(tmpDir).setup.copy).toEqual([".env", ".env.local"]);
  });

  test("no copy entries when no .env files and no .wt-setup-files", () => {
    touch("package.json", "{}");
    touch("bun.lock");
    expect(detectProject(tmpDir).setup.copy).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Empty / unrecognized
// ---------------------------------------------------------------------------

describe("detectProject — browser auto-suggestion", () => {
  test("vite.config.ts at repo root → browser.enabled=true", () => {
    touch("package.json", "{}");
    touch("bun.lock");
    touch("vite.config.ts", "export default {};");
    const m = detectProject(tmpDir);
    expect(m.browser.enabled).toBe(true);
  });

  test("next.config.js → browser.enabled=true", () => {
    touch("package.json", "{}");
    touch("bun.lock");
    touch("next.config.js", "module.exports = {};");
    expect(detectProject(tmpDir).browser.enabled).toBe(true);
  });

  test("vite config nested under packages/web/ → also detected", () => {
    touch("package.json", "{}");
    touch("bun.lock");
    touch("packages/web/vite.config.ts", "");
    expect(detectProject(tmpDir).browser.enabled).toBe(true);
  });

  test("pure Rust project → browser.enabled=false", () => {
    touch("Cargo.toml", "[package]\nname = \"x\"\n");
    expect(detectProject(tmpDir).browser.enabled).toBe(false);
  });

  test("backend-only Node project (no web config) → browser.enabled=false", () => {
    touch("package.json", "{}");
    touch("bun.lock");
    expect(detectProject(tmpDir).browser.enabled).toBe(false);
  });
});

describe("detectProject — empty repo", () => {
  test("no files at all → empty manifest, undefined detected", () => {
    const m = detectProject(tmpDir);
    expect(m.detected).toBeUndefined();
    expect(m.setup.install).toEqual([]);
    expect(m.setup.copy).toEqual([]);
    expect(m.setup.generate).toEqual([]);
    expect(m.setup.migrate).toEqual([]);
    expect(m.ports).toEqual({});
    expect(m.services).toEqual({});
    expect(m.env).toEqual({});
    expect(m.teardown.run).toEqual([]);
  });
});
