/**
 * The machine-wide caps this CLI enforces itself, one way to read each:
 * the environment variable wins (one shell), then `<key>.per_machine` in
 * config.json (`cast config <key>.per_machine <n>`, this machine), then the
 * default. Subagent workers are capped too, but by the server
 * (shared/contracts/subagentFleet.ts), from the same config shape.
 */

import * as os from "node:os";
import { readLocalConfig } from "./config/readLocalConfig.js";

/**
 * Typecheck watchers by memory: a watcher holds a whole program, 1 to 4 GB
 * (codecast's web, cli and convex measured 2 to 4 on 2026-10-09), so one per
 * 12 GB keeps them under about a fifth of the machine. A fixed count fit one
 * tree; with several trees sharing it, a cap smaller than the working set
 * rebuilds each program whole every few asks.
 */
export function checkWatchersForMemory(totalBytes = os.totalmem()): number {
  return Math.min(16, Math.max(2, Math.floor(totalBytes / 2 ** 30 / 12)));
}

export const MACHINE_CAPS = {
  check: { env: "CAST_CHECK_MAX_WATCHERS", fallback: checkWatchersForMemory(), what: "typecheck watchers" },
  interactive_jobs: { env: "CAST_INTERACTIVE_JOBS_MAX", fallback: 8, what: "commands run as Interactive jobs" },
} as const;

export type MachineCapKey = keyof typeof MACHINE_CAPS;

const positive = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
};

export function machineCap(key: MachineCapKey, env: NodeJS.ProcessEnv = process.env): number {
  const cap = MACHINE_CAPS[key];
  return positive(env[cap.env]) ?? positive(readLocalConfig()?.[key]?.per_machine) ?? cap.fallback;
}
