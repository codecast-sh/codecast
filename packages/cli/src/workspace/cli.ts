/**
 * `cast workspace` CLI subcommand wiring.
 *
 * Seven subcommands: init, acquire, path, status, heal, destroy, ls.
 * Registered via registerWorkspaceCommand(program) called from index.ts.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import {
  acquireWorkspace,
  healWorkspace,
  listWorkspaces,
  releaseWorkspace,
  validateWorkspace,
} from "./lifecycle.js";
import { detectProject } from "./detect.js";
import { MANIFEST_REL_PATH } from "./resolver.js";
import { readState } from "./contract.js";
import { defaultRegistry } from "./backends/registry.js";
import type { WorkspaceManifest } from "./types.js";

/**
 * Resolve the repo root for the current working directory.
 * Falls back to cwd if not in a git repo.
 */
function findRepoRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.cwd();
  }
}

export function registerWorkspaceCommand(program: Command): void {
  const ws = program
    .command("workspace")
    .alias("ws")
    .description("Manage isolated git worktrees for parallel agent work");

  // -----------------------------------------------------------------------
  // cast workspace init
  // -----------------------------------------------------------------------
  ws.command("init")
    .description("Generate .codecast/workspace.toml from project auto-detection")
    .option("--force", "Overwrite existing manifest")
    .action(async (opts: { force?: boolean }) => {
      const repoRoot = findRepoRoot();
      const manifestPath = path.join(repoRoot, MANIFEST_REL_PATH);
      if (fs.existsSync(manifestPath) && !opts.force) {
        console.error(`Manifest already exists at ${manifestPath}. Use --force to overwrite.`);
        process.exit(1);
      }
      const m = detectProject(repoRoot);
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      fs.writeFileSync(manifestPath, renderManifestToml(m));
      console.log(`Wrote ${manifestPath} (detected: ${m.detected ?? "none"})`);
    });

  // -----------------------------------------------------------------------
  // cast workspace acquire <name>
  // -----------------------------------------------------------------------
  ws.command("acquire <name>")
    .description("Create or attach to a workspace by name")
    .option("--branch <branch>", "Override branch name")
    .option("--backend <name>", "Sandbox backend to use (default: local)")
    .option("--skip-setup", "Skip install/generate/migrate commands")
    .option("--skip-hooks", "Skip before-create/after-create hooks")
    .option("--skip-pool", "Bypass warm pool — force fresh setup")
    .action(
      async (
        name: string,
        opts: {
          branch?: string;
          backend?: string;
          skipSetup?: boolean;
          skipHooks?: boolean;
          skipPool?: boolean;
        },
      ) => {
        const repoRoot = findRepoRoot();
        // Backend validation: if user passed --backend, ensure it exists.
        if (opts.backend && !defaultRegistry.has(opts.backend)) {
          console.error(
            `unknown backend '${opts.backend}'. Available: [${defaultRegistry.list().join(", ")}]`,
          );
          process.exit(1);
        }
        try {
          const r = await acquireWorkspace(repoRoot, name, {
            branch: opts.branch,
            skipSetup: opts.skipSetup,
            skipHooks: opts.skipHooks,
            skipPool: opts.skipPool,
          });
          const ws = r.workspace;
          const tag = r.created ? "created" : "attached";
          console.log(`${tag}: ${ws.name}`);
          console.log(`  path:    ${ws.path}`);
          console.log(`  branch:  ${ws.branch}`);
          console.log(`  state:   ${ws.state}`);
          if (Object.keys(ws.ports).length > 0) {
            const ports = Object.entries(ws.ports)
              .map(([n, p]) => `${n}=${p}`)
              .join(" ");
            console.log(`  ports:   ${ports}`);
          }
          if (ws.contract && !ws.contract.ok) {
            console.error("\nContract failures:");
            for (const c of ws.contract.checks) {
              if (!c.ok) console.error(`  ✗ ${c.name}: ${c.reason}`);
            }
            process.exit(2);
          }
        } catch (err) {
          console.error(`acquire failed: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );

  // -----------------------------------------------------------------------
  // cast workspace status <name>
  // -----------------------------------------------------------------------
  ws.command("status <name>")
    .description("Show workspace state and contract validation")
    .action(async (name: string) => {
      const repoRoot = findRepoRoot();
      const state = readState(repoRoot, name);
      if (!state) {
        console.error(`Workspace '${name}' not found`);
        process.exit(1);
      }
      console.log(`${state.name}`);
      console.log(`  state:   ${state.state}`);
      console.log(`  path:    ${state.path}`);
      console.log(`  branch:  ${state.branch}`);
      console.log(`  updated: ${state.updatedAt}`);
      const r = await validateWorkspace(repoRoot, name);
      console.log(`  contract: ${r.ok ? "ok" : "FAIL"}`);
      for (const c of r.checks) {
        const mark = c.ok ? "✓" : "✗";
        const reason = c.reason ? ` (${c.reason})` : "";
        console.log(`    ${mark} ${c.name}${reason}`);
      }
      if (!r.ok) process.exit(2);
    });

  // -----------------------------------------------------------------------
  // cast workspace path <name>
  // -----------------------------------------------------------------------
  ws.command("path <name>")
    .description("Print a workspace's absolute worktree path (for `cd \"$(cast ws path <name>)\"`)")
    .action((name: string) => {
      const repoRoot = findRepoRoot();
      // Prefer the tracked path (handles pool-claimed slots whose layout may
      // differ from the default), then fall back to the deterministic location.
      const tracked = readState(repoRoot, name)?.path;
      const fallback = path.join(repoRoot, ".codecast/worktrees", name);
      const resolved = tracked ?? fallback;
      if (!fs.existsSync(resolved)) {
        console.error(`Workspace '${name}' not found (run: cast workspace acquire ${name})`);
        process.exit(1);
      }
      console.log(resolved);
    });

  // -----------------------------------------------------------------------
  // cast workspace heal <name>
  // -----------------------------------------------------------------------
  ws.command("heal <name>")
    .description("Re-run setup to recover a broken workspace")
    .action(async (name: string) => {
      const repoRoot = findRepoRoot();
      try {
        const ws = await healWorkspace(repoRoot, name);
        console.log(`healed: ${ws.name} → ${ws.state}`);
        if (ws.state !== "ready") process.exit(2);
      } catch (err) {
        console.error(`heal failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // -----------------------------------------------------------------------
  // cast workspace destroy <name>
  // -----------------------------------------------------------------------
  ws.command("destroy <name>")
    .description("Tear down a workspace: run teardown, remove worktree, drop state")
    .action(async (name: string) => {
      const repoRoot = findRepoRoot();
      await releaseWorkspace(repoRoot, name);
      console.log(`destroyed: ${name}`);
    });

  // -----------------------------------------------------------------------
  // cast workspace ls
  // -----------------------------------------------------------------------
  ws.command("ls")
    .description("List all tracked workspaces")
    .action(() => {
      const repoRoot = findRepoRoot();
      const list = listWorkspaces(repoRoot);
      if (list.length === 0) {
        console.log("(no workspaces)");
        return;
      }
      const nameLen = Math.max(...list.map((w) => w.name.length), 4);
      console.log(
        `${"NAME".padEnd(nameLen)}  ${"STATE".padEnd(10)}  ${"BRANCH".padEnd(20)}  PATH`,
      );
      for (const w of list) {
        console.log(
          `${w.name.padEnd(nameLen)}  ${w.state.padEnd(10)}  ${w.branch.padEnd(20)}  ${w.path}`,
        );
      }
    });
}

/** Render a manifest back to TOML for `init` output. Hand-rolled (no dep). */
function renderManifestToml(m: WorkspaceManifest): string {
  const lines: string[] = [
    `# .codecast/workspace.toml — generated by 'cast workspace init'`,
    `# Detected project type: ${m.detected ?? "none"}`,
    `# See https://codecast.sh/docs/workspace for the full schema.`,
    ``,
  ];

  const setupKeys = (["copy", "install", "generate", "migrate"] as const).filter(
    (k) => m.setup[k].length > 0,
  );
  if (setupKeys.length > 0) {
    lines.push(`[setup]`);
    for (const k of setupKeys) {
      lines.push(`${k} = ${JSON.stringify(m.setup[k])}`);
    }
    lines.push(``);
  }

  for (const [name, spec] of Object.entries(m.ports)) {
    lines.push(`[ports.${name}]`);
    lines.push(`base = ${spec.base}`);
    lines.push(`range = ${spec.range}`);
    lines.push(``);
  }

  for (const [name, spec] of Object.entries(m.services)) {
    lines.push(`[services.${name}]`);
    lines.push(`mode = ${JSON.stringify(spec.mode)}`);
    for (const k of ["start", "stop", "url", "port"] as const) {
      if (spec[k]) lines.push(`${k} = ${JSON.stringify(spec[k])}`);
    }
    if (spec.readyCheck) lines.push(`ready_check = ${JSON.stringify(spec.readyCheck)}`);
    if (spec.readyTimeoutSec !== undefined) lines.push(`ready_timeout_sec = ${spec.readyTimeoutSec}`);
    lines.push(``);
  }

  const envKeys = Object.keys(m.env);
  if (envKeys.length > 0) {
    lines.push(`[env]`);
    for (const k of envKeys) lines.push(`${k} = ${JSON.stringify(m.env[k])}`);
    lines.push(``);
  }

  if (m.teardown.run.length > 0) {
    lines.push(`[teardown]`);
    lines.push(`run = ${JSON.stringify(m.teardown.run)}`);
    lines.push(``);
  }

  return lines.join("\n");
}
