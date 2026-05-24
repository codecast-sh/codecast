/**
 * Project detection: zero-config inference of how to set up a worktree.
 *
 * Returns a partial WorkspaceManifest based on lockfiles, manifests, and
 * conventional files. The manifest resolver merges this with the user's
 * .codecast/workspace.toml (if any) — explicit overrides always win.
 *
 * Design rule: detection only sets fields it has high confidence in.
 *   - `install` from lockfile (very high confidence)
 *   - `copy` from .env presence (high confidence)
 *   - `generate` from package.json scripts or prisma (medium confidence)
 *   - `ports` / `services` / `env` / `teardown` left empty — these vary too
 *     much per project to guess.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_BROWSER } from "./manifest.js";
import type { WorkspaceManifest } from "./types.js";

/** Detect project type and synthesize a default manifest. */
export function detectProject(repoRoot: string): WorkspaceManifest {
  const has = (rel: string) => fs.existsSync(path.join(repoRoot, rel));

  const install: string[] = [];
  const generate: string[] = [];
  const copy: string[] = [];
  let detected: string | undefined;

  // ---------------------------------------------------------------------
  // JavaScript/TypeScript ecosystem — exactly one install command,
  // chosen by lockfile.
  // ---------------------------------------------------------------------
  if (has("bun.lock") || has("bun.lockb")) {
    install.push("bun install");
    detected = "bun";
  } else if (has("pnpm-lock.yaml")) {
    install.push("pnpm install --frozen-lockfile");
    detected = "pnpm";
  } else if (has("yarn.lock")) {
    install.push("yarn install --immutable");
    detected = "yarn";
  } else if (has("package-lock.json")) {
    install.push("npm ci");
    detected = "npm";
  } else if (has("package.json")) {
    // No lockfile — fall back to plain `npm install`.
    install.push("npm install");
    detected = "npm";
  }

  // ---------------------------------------------------------------------
  // Python — uv.lock takes precedence (modern), then poetry, then pip.
  // These are independent from JS detection (a repo can have both).
  // ---------------------------------------------------------------------
  if (has("uv.lock")) {
    install.push("uv sync");
    detected = detected ? `${detected}+uv` : "uv";
  } else if (has("poetry.lock")) {
    install.push("poetry install");
    detected = detected ? `${detected}+poetry` : "poetry";
  } else if (has("Pipfile.lock")) {
    install.push("pipenv sync");
    detected = detected ? `${detected}+pipenv` : "pipenv";
  } else if (has("requirements.txt")) {
    install.push("pip install -r requirements.txt");
    detected = detected ? `${detected}+pip` : "pip";
  } else if (has("pyproject.toml")) {
    install.push("pip install -e .");
    detected = detected ? `${detected}+pip` : "pip";
  }

  // ---------------------------------------------------------------------
  // Rust
  // ---------------------------------------------------------------------
  if (has("Cargo.toml")) {
    install.push("cargo fetch");
    detected = detected ? `${detected}+cargo` : "cargo";
  }

  // ---------------------------------------------------------------------
  // Go
  // ---------------------------------------------------------------------
  if (has("go.mod")) {
    install.push("go mod download");
    detected = detected ? `${detected}+go` : "go";
  }

  // ---------------------------------------------------------------------
  // Ruby
  // ---------------------------------------------------------------------
  if (has("Gemfile.lock") || has("Gemfile")) {
    install.push("bundle install");
    detected = detected ? `${detected}+bundler` : "bundler";
  }

  // ---------------------------------------------------------------------
  // Generators (compose with primary install).
  // ---------------------------------------------------------------------
  if (has("prisma/schema.prisma")) {
    // Pick the right runner based on detected pkg manager
    const runner = detected?.startsWith("bun")
      ? "bunx prisma generate"
      : detected?.startsWith("pnpm")
        ? "pnpm exec prisma generate"
        : detected?.startsWith("yarn")
          ? "yarn prisma generate"
          : "npx prisma generate";
    generate.push(runner);
  }

  // package.json `scripts.codegen` is a common convention.
  const pkgJsonPath = path.join(repoRoot, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
        scripts?: Record<string, string>;
      };
      const scriptName = pkg.scripts?.["codegen"]
        ? "codegen"
        : pkg.scripts?.["generate"]
          ? "generate"
          : null;
      if (scriptName) {
        const runner = detected?.startsWith("bun")
          ? `bun run ${scriptName}`
          : detected?.startsWith("pnpm")
            ? `pnpm run ${scriptName}`
            : detected?.startsWith("yarn")
              ? `yarn ${scriptName}`
              : `npm run ${scriptName}`;
        // Avoid duplicating with prisma above.
        if (!generate.includes(runner)) generate.push(runner);
      }
    } catch {
      // Malformed package.json — skip silently rather than fail detection.
    }
  }

  // ---------------------------------------------------------------------
  // Copy list: .env-family files that exist in the main worktree but would
  // be gitignored. Honor the existing .wt-setup-files convention if present.
  // ---------------------------------------------------------------------
  const wtSetupFile = path.join(repoRoot, ".wt-setup-files");
  if (fs.existsSync(wtSetupFile)) {
    // Existing convention from codecast: one pattern per line, # comments allowed.
    const lines = fs.readFileSync(wtSetupFile, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    for (const pat of lines) {
      if (!copy.includes(pat)) copy.push(pat);
    }
  } else {
    // No existing convention — auto-suggest .env-family files that exist.
    for (const env of [".env", ".env.local"]) {
      if (has(env) && !copy.includes(env)) copy.push(env);
    }
  }

  // Heuristic: web frameworks present → workspace likely needs a browser.
  // We don't auto-enable (could surprise users), but we record the suggestion
  // by setting `browser.enabled=true` so manifests inherit a sensible default.
  // Users can disable via manifest if undesired.
  const browserEnabled = detectWebFramework(repoRoot);

  return {
    setup: { copy, install, generate, migrate: [] },
    ports: {},
    services: {},
    env: {},
    teardown: { run: [] },
    browser: { ...DEFAULT_BROWSER, enabled: browserEnabled },
    backend: "local",
    detected,
  };
}

/**
 * True if the repo looks like it builds something users would visit in a
 * browser (Next, Vite, Remix, SvelteKit, Astro, plain CRA, etc). Used only to
 * pick a sensible default for browser.enabled in detection.
 */
function detectWebFramework(repoRoot: string): boolean {
  const probes = [
    "next.config.js", "next.config.ts", "next.config.mjs",
    "vite.config.js", "vite.config.ts",
    "remix.config.js", "remix.config.ts",
    "astro.config.mjs", "astro.config.ts",
    "svelte.config.js",
    "nuxt.config.js", "nuxt.config.ts",
    "angular.json",
    "vue.config.js",
  ];
  for (const p of probes) {
    if (fs.existsSync(path.join(repoRoot, p))) return true;
  }
  // Workspaces: check sub-packages too (codecast itself has packages/web/vite.config.ts).
  const pkgsDir = path.join(repoRoot, "packages");
  if (fs.existsSync(pkgsDir)) {
    try {
      for (const sub of fs.readdirSync(pkgsDir)) {
        const subPath = path.join(pkgsDir, sub);
        if (!fs.statSync(subPath).isDirectory()) continue;
        for (const p of probes) {
          if (fs.existsSync(path.join(subPath, p))) return true;
        }
      }
    } catch { /* ignore */ }
  }
  return false;
}
