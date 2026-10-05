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
 *   - `share` from gitignored dependency directories (high confidence)
 *   - `generate` from package.json scripts or prisma (medium confidence)
 *   - `services.web` from a web framework app with a `dev` script (high
 *     confidence: every framework below takes `--port`)
 *   - `ports` / `env` / `teardown` left empty — these vary too much per
 *     project to guess.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_BROWSER } from "./manifest.js";
import { SHARE_CANDIDATES, resolveSharedDirectories } from "./share.js";
import type { ServiceSpec, WorkspaceManifest } from "./types.js";

export type JsPackageManager = "bun" | "pnpm" | "yarn" | "npm";

/**
 * The JavaScript package manager a repo uses, chosen by lockfile, with the
 * install command that respects that lockfile. Null when there is no
 * package.json at all.
 */
export function detectJsPackageManager(
  repoRoot: string,
): { name: JsPackageManager; install: string } | null {
  const has = (rel: string) => fs.existsSync(path.join(repoRoot, rel));
  if (has("bun.lock") || has("bun.lockb")) return { name: "bun", install: "bun install" };
  if (has("pnpm-lock.yaml")) return { name: "pnpm", install: "pnpm install --frozen-lockfile" };
  if (has("yarn.lock")) return { name: "yarn", install: "yarn install --immutable" };
  if (has("package-lock.json")) return { name: "npm", install: "npm ci" };
  // No lockfile — fall back to plain `npm install`.
  if (has("package.json")) return { name: "npm", install: "npm install" };
  return null;
}

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
  const js = detectJsPackageManager(repoRoot);
  if (js) {
    install.push(js.install);
    detected = js.name;
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

  // ---------------------------------------------------------------------
  // Share list: dependency directories a worktree can borrow from this
  // checkout instead of installing its own. Only what exists here, is
  // gitignored, and holds no workspace links back into the repo.
  // ---------------------------------------------------------------------
  const share = resolveSharedDirectories(repoRoot, SHARE_CANDIDATES);

  // Heuristic: web frameworks present → workspace likely needs a browser.
  // We don't auto-enable (could surprise users), but we record the suggestion
  // by setting `browser.enabled=true` so manifests inherit a sensible default.
  // Users can disable via manifest if undesired.
  const webApp = detectWebApp(repoRoot);
  const browserEnabled = webApp !== null;
  const devService = webApp !== null && js ? detectDevService(repoRoot, webApp, js.name) : null;

  return {
    setup: { copy, share, install, generate, migrate: [] },
    ports: {},
    services: devService ? { web: devService } : {},
    env: {},
    teardown: { run: [] },
    browser: { ...DEFAULT_BROWSER, enabled: browserEnabled },
    backend: "local",
    detected,
  };
}

/**
 * The directory (relative to the repo, "" for the root) of an app users would
 * visit in a browser (Next, Vite, Remix, SvelteKit, Astro, plain CRA, etc), or
 * null. Checks the root, then each package under packages/ and apps/.
 */
function detectWebApp(repoRoot: string): string | null {
  const probes = [
    "next.config.js", "next.config.ts", "next.config.mjs",
    "vite.config.js", "vite.config.ts", "vite.config.mjs",
    "remix.config.js", "remix.config.ts",
    "astro.config.mjs", "astro.config.ts",
    "svelte.config.js",
    "nuxt.config.js", "nuxt.config.ts",
    "angular.json",
    "vue.config.js",
  ];
  const isApp = (dir: string) => probes.some((p) => fs.existsSync(path.join(repoRoot, dir, p)));
  if (isApp("")) return "";
  // Workspaces: check sub-packages too (codecast itself has packages/web/vite.config.ts).
  for (const parent of ["packages", "apps"]) {
    const dir = path.join(repoRoot, parent);
    let subs: string[];
    try { subs = fs.readdirSync(dir).sort(); } catch { continue; }
    // A package named web/app/site/frontend is the likelier dev server when several qualify.
    const ranked = [...subs.filter((s) => /^(web|app|site|frontend|www|client)$/.test(s)), ...subs];
    for (const sub of ranked) {
      try {
        if (fs.statSync(path.join(dir, sub)).isDirectory() && isApp(path.join(parent, sub))) return path.join(parent, sub);
      } catch { /* ignore */ }
    }
  }
  return null;
}

/**
 * The web app's dev server as a service `cast dev` can start: its package's
 * `dev` script, given the workspace's web port. Every framework detectWebApp
 * knows accepts `--port`, and each package manager below forwards trailing
 * arguments to the script (npm needs the `--`).
 */
function detectDevService(repoRoot: string, appDir: string, pm: JsPackageManager): ServiceSpec | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, appDir, "package.json"), "utf-8")) as { scripts?: Record<string, string> };
    if (!pkg.scripts?.["dev"]) return null;
  } catch {
    return null;
  }
  const run = pm === "npm" ? "npm run dev --" : pm === "yarn" ? "yarn dev" : `${pm} run dev`;
  const cd = appDir ? `cd ${appDir} && ` : "";
  return { mode: "isolated", start: `${cd}${run} --port "$PORT_WEB"`, port: "web" };
}
