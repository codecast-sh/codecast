/**
 * The machine-wide caps this CLI enforces itself, one way to read each:
 * the environment variable wins (one shell), then `<key>.per_machine` in
 * config.json (`cast config <key>.per_machine <n>`, this machine), then the
 * default. Subagent workers are capped too, but by the server
 * (shared/contracts/subagentFleet.ts), from the same config shape.
 */

import { readLocalConfig } from "./config/readLocalConfig.js";

/**
 * Typecheck watchers are admitted by memory (watcherMemory.ts): their sizes
 * run from under 100 MB to over 6 GB, so a count says little. The count stays
 * as a backstop, and as the knob for a machine that wants fewer.
 */
export const CHECK_WATCHERS_BACKSTOP = 16;

export const MACHINE_CAPS = {
  check: { env: "CAST_CHECK_MAX_WATCHERS", fallback: CHECK_WATCHERS_BACKSTOP, what: "typecheck watchers" },
  interactive_jobs: { env: "CAST_INTERACTIVE_JOBS_MAX", fallback: 8, what: "commands run as Interactive jobs" },
  // Named slots (machineSlot.ts), taken by a flow station's machine_slot= or `cast slot run --name`. Two Local CI
  // runs side by side already fill a laptop.
  local_ci: { env: "CAST_LOCAL_CI_MAX", fallback: 2, what: "Local CI runs", slot: true },
} as const;

export type MachineCapKey = keyof typeof MACHINE_CAPS;

/** The caps that are named slots: a flow station's machine_slot= and `cast slot run --name` take a place in one. */
export const MACHINE_SLOTS = (Object.keys(MACHINE_CAPS) as MachineCapKey[]).filter((k) => "slot" in MACHINE_CAPS[k]);

const positive = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
};

export function machineCap(key: MachineCapKey, env: NodeJS.ProcessEnv = process.env): number {
  const cap = MACHINE_CAPS[key];
  return positive(env[cap.env]) ?? positive(readLocalConfig()?.[key]?.per_machine) ?? cap.fallback;
}
