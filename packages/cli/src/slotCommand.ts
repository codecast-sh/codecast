/**
 * `cast slot run --name <n> [--wait <dur>] -- <cmd...>`: run a command once it
 * holds a place in one of this machine's named slots (machineSlot.ts), and
 * give the place back when it ends. A wait that runs out exits 75, the code
 * for "busy, ask again". `cast slot ls` lists each slot's holders and waiters.
 */

import { constants as osConstants } from "node:os";
import { parseDuration } from "@codecast/shared/contracts/moments";
import { spawn } from "./proc.js";
import { EXIT_BUSY, printHint } from "./infraExit.js";
import { listMachineSlots, machineSlotProblem, takeMachineSlot } from "./machineSlot.js";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export async function runSlotRun(command: string[], o: { name: string; wait?: string }): Promise<never> {
  const problem = machineSlotProblem(o.name);
  if (problem) {
    console.error(`cast slot run: ${problem}`);
    process.exit(2);
  }
  const waitMs = o.wait === undefined ? undefined : parseDuration(o.wait);
  if (waitMs === null) {
    console.error(`cast slot run: --wait ${o.wait} is not a duration (90s, 15m, 1h)`);
    process.exit(2);
  }
  const slot = await takeMachineSlot(o.name, {
    waitMs,
    what: command.join(" "),
    onWait: (why) => process.stderr.write(`queued: ${why}; starting when a place frees (cast slot ls lists them)\n`),
  });
  if (!slot.release) {
    console.error(`cast slot run: ${slot.why} for ${o.wait}; ${command[0]} did not run`);
    printHint(`run it again later, or see who holds ${o.name}: cast slot ls`);
    process.exit(EXIT_BUSY);
  }
  const child = spawn(command[0]!, command.slice(1), { stdio: "inherit" });
  // The place's own signal handler gives it back and ends this process; the command hears the signal first.
  const forward = (sig: NodeJS.Signals) => () => { child.kill(sig); };
  for (const sig of SIGNALS) process.prependListener(sig, forward(sig));
  const code = await new Promise<number>((resolve) => {
    child.on("error", (err) => { console.error(`cast slot run: ${err.message}`); resolve(127); });
    child.on("exit", (status, signal) => resolve(status ?? 128 + ((signal && osConstants.signals[signal]) || 0)));
  });
  slot.release();
  process.exit(code);
}

export function renderSlots(slots: ReturnType<typeof listMachineSlots>, now = Date.now()): string {
  const ago = (at: number) => `${Math.max(0, Math.round((now - at) / 60_000))}m`;
  const lines: string[] = [];
  for (const s of slots) {
    lines.push(`${s.name}  ${s.running.length}/${s.cap} running${s.waiting.length ? `, ${s.waiting.length} waiting` : ""}`);
    for (const j of s.running) lines.push(`  ${ago(j.at)}  pid ${j.pid}  ${j.what ?? ""}`.trimEnd());
    for (const j of s.waiting) lines.push(`  waiting ${ago(j.at)}: pid ${j.pid}  ${j.what ?? ""}`.trimEnd());
  }
  lines.push("", `Caps: cast config <name>.per_machine <n>`);
  return lines.join("\n");
}

export function runSlotLs(o: { json?: boolean }): void {
  const slots = listMachineSlots();
  console.log(o.json ? JSON.stringify(slots, null, 2) : renderSlots(slots));
}
