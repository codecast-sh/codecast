/**
 * LocalBackend — implements SandboxBackend against local git worktrees.
 *
 * Delegates lifecycle work to the existing exported functions in
 * lifecycle.ts (acquireWorkspaceImpl, etc) which were originally written
 * for the local-only world. This keeps the refactor minimal: we expose the
 * same code under a backend-shaped surface.
 *
 * exec/readFile/writeFile run directly against the worktree path read from
 * persisted state.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  acquireWorkspace,
  healWorkspace,
  listWorkspaces,
  releaseWorkspace,
  validateWorkspace,
} from "../lifecycle.js";
import { readState } from "../contract.js";
import type {
  ExecResult,
  FileContent,
  SandboxBackend,
} from "./types.js";

export const LocalBackend: SandboxBackend = {
  name: "local",

  async acquire(repoRoot, name, opts) {
    const r = await acquireWorkspace(repoRoot, name, opts);
    return r.workspace;
  },

  release(repoRoot, name) {
    return releaseWorkspace(repoRoot, name);
  },

  heal(repoRoot, name) {
    return healWorkspace(repoRoot, name);
  },

  validate(repoRoot, name) {
    return validateWorkspace(repoRoot, name);
  },

  async list(repoRoot) {
    return listWorkspaces(repoRoot);
  },

  async exec(repoRoot, name, command, opts = {}): Promise<ExecResult> {
    const state = readState(repoRoot, name);
    if (!state) throw new Error(`workspace '${name}' not found`);
    const cwd = opts.cwd
      ? path.join(state.path, opts.cwd)
      : state.path;
    const env = {
      ...process.env,
      ...state.env,
      ...(opts.env ?? {}),
    };
    const start = Date.now();
    return await new Promise<ExecResult>((resolve, reject) => {
      const child = spawn("bash", ["-lc", command], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timer: ReturnType<typeof setTimeout> | undefined;

      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
        }, opts.timeoutMs);
      }
      child.stdout?.on("data", (b: Buffer) => { stdout += b.toString("utf-8"); });
      child.stderr?.on("data", (b: Buffer) => { stderr += b.toString("utf-8"); });
      if (opts.stdin) {
        try { child.stdin?.write(opts.stdin); } catch {}
      }
      child.stdin?.end();
      child.on("error", reject);
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({
          stdout,
          stderr,
          exitCode: code,
          durationMs: Date.now() - start,
        });
      });
    });
  },

  async readFile(repoRoot, name, relativePath): Promise<Buffer> {
    const state = readState(repoRoot, name);
    if (!state) throw new Error(`workspace '${name}' not found`);
    return fs.readFileSync(path.join(state.path, relativePath));
  },

  async writeFile(repoRoot, name, relativePath, content: FileContent): Promise<void> {
    const state = readState(repoRoot, name);
    if (!state) throw new Error(`workspace '${name}' not found`);
    const full = path.join(state.path, relativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  },
};
