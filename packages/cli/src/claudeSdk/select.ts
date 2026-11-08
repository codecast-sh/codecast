// Which backend runs a Claude session, and why the SDK one is refused when it
// is. Default tmux. A start can ask for one (`backend` on start_session, the
// switch a later track adds), else CODECAST_CLAUDE_BACKEND on the daemon, else
// config `claude_backend`.

import * as fs from "node:fs";
import { execFileAsync } from "../proc.js";
import { MINIMUM_CLAUDE_VERSION, versionAtLeast } from "./session.js";

export type ClaudeBackend = "tmux" | "sdk";

const asBackend = (v: unknown): ClaudeBackend | undefined => (v === "sdk" || v === "tmux" ? v : undefined);

export function chooseClaudeBackend(requested: unknown, env: Record<string, string | undefined>, configured: unknown): ClaudeBackend {
  return asBackend(requested) ?? asBackend(env.CODECAST_CLAUDE_BACKEND) ?? asBackend(configured) ?? "tmux";
}

const versions = new Map<string, { mtimeMs: number; version: string | null }>();

/** `claude --version` for a binary, cached until the file changes. */
export async function claudeVersion(binary: string, run: (bin: string) => Promise<string> = async (bin) => (await execFileAsync(bin, ["--version"], { encoding: "utf8", timeout: 30_000 })).stdout): Promise<string | null> {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(binary).mtimeMs; } catch {}
  const cached = versions.get(binary);
  if (cached && cached.mtimeMs === mtimeMs) return cached.version;
  let version: string | null = null;
  try {
    version = /\d+\.\d+\.\d+/.exec(await run(binary))?.[0] ?? null;
  } catch {}
  // A read that failed (a timeout on a loaded machine) is asked again next time, never remembered.
  if (version) versions.set(binary, { mtimeMs, version });
  return version;
}

/** Why this binary cannot run the SDK backend, or null when it can. The host checks again against the init message. */
export async function sdkBackendRefusal(binary: string, run?: (bin: string) => Promise<string>): Promise<string | null> {
  const version = await claudeVersion(binary, run);
  if (!version) return `could not read the version of ${binary}`;
  if (!versionAtLeast(version, MINIMUM_CLAUDE_VERSION)) return `Claude Code ${version} is older than ${MINIMUM_CLAUDE_VERSION}`;
  return null;
}
