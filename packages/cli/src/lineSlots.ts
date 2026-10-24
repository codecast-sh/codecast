/**
 * The line checkouts this machine offers, for the heartbeat's `line_slots`.
 *
 * A machine joins a role's line pool only by declaring it in config.json:
 *
 *   "line": { "checkouts": [ { "root": "/home/ubuntu/union-mobile", "runs": 10 } ] }
 *
 * The server places a line run on a device whose slot has the role checkout's
 * origin and fewer working runs than `runs`, with the run's folder at `root`
 * plus the role's subpath under its own git root. `origin` is read from the
 * checkout and normalized (normalizeGitOrigin), so the laptop's clone and the
 * host's clone of one repo match whatever protocol cloned them.
 *
 * A checkout whose disk is full (diskFull.ts) is offered with no runs until
 * it has room again, so admission places nothing there.
 */
import { execFileSync } from "./proc.js";
import { normalizeGitOrigin } from "@codecast/shared/contracts";
import type { Config } from "./config/types.js";
import { diskFullHold } from "./diskFull.js";

export interface LineSlot {
  root: string;
  origin?: string;
  runs: number;
}

export function readLineSlots(config: Pick<Config, "line"> | null | undefined, originOf: (root: string) => string | undefined = gitOrigin): LineSlot[] {
  const checkouts = config?.line?.checkouts;
  if (!Array.isArray(checkouts)) return [];
  const slots: LineSlot[] = [];
  for (const c of checkouts) {
    const root = typeof c?.root === "string" ? c.root.replace(/\/+$/, "") : "";
    const runs = Number(c?.runs);
    // 0 runs keeps the checkout in the pool with no room (the slot governor, a full disk): runs wait for it.
    if (!root || !Number.isFinite(runs) || runs < 0) continue;
    const raw = originOf(root);
    const origin = raw ? normalizeGitOrigin(raw) ?? undefined : undefined;
    slots.push({ root, ...(origin ? { origin } : {}), runs: Math.floor(runs) });
  }
  return slots;
}

function gitOrigin(root: string): string | undefined {
  try {
    return execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The heartbeat's view: the slots when they changed since the last beat that
 * carried them (or ten minutes passed, which also covers a beat that failed),
 * else undefined. A machine that never declared a checkout sends nothing; one
 * that drops its declaration sends [] once, which takes it out of the pool.
 */
export class LineSlotsReporter {
  private sentKey: string | null = null;
  private sentAt = 0;
  // Each held checkout's root and why, as of the last beat: a change is logged once.
  private held = new Map<string, string>();

  constructor(private log: (m: string) => void = () => {}) {}

  next(config: Pick<Config, "line"> | null | undefined, now = Date.now(), originOf?: (root: string) => string | undefined, holdOf: (root: string) => string | null = diskFullHold): LineSlot[] | undefined {
    const held = new Map<string, string>();
    const slots = readLineSlots(config, originOf).map((s) => {
      const hold = holdOf(s.root);
      if (!hold) return s;
      held.set(s.root, hold);
      return { ...s, runs: 0 };
    });
    for (const [root, hold] of held) if (!this.held.has(root)) this.log(`[LINE] ${root} takes no line runs: ${hold}`);
    for (const root of this.held.keys()) if (!held.has(root)) this.log(`[LINE] ${root} takes line runs again: its disk has room`);
    this.held = held;
    if (!slots.length && this.sentKey === null) return undefined;
    const key = JSON.stringify(slots);
    if (key === this.sentKey && now - this.sentAt < 10 * 60_000) return undefined;
    this.sentKey = key;
    this.sentAt = now;
    return slots;
  }
}
