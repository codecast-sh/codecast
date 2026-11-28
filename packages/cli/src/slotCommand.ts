/**
 * `cast slot run --name <n> [--wait <dur>] -- <cmd...>`: run a command once it
 * holds a place in one of this machine's named slots (machineSlot.ts), and
 * give the place back when it ends. A wait that runs out exits 75, the code
 * for "busy, ask again". `cast slot ls` lists each slot's holders and waiters.
 */

import type { Command } from "commander";
import { constants as osConstants } from "node:os";
import { parseDuration } from "@codecast/shared/contracts/moments";
import { commandGroup } from "./commandGroupLookup.js";
import { spawn } from "./proc.js";
import { EXIT_BUSY, printHint } from "./infraExit.js";
import { listMachineSlots, machineSlotProblem, takeMachineSlot } from "./machineSlot.js";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
/** How long the command has to end after cast passes it a signal, before it is killed: the place is given back only once it has ended. */
export const CHILD_GRACE_MS = 10_000;

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
    // A signal before the command starts ends cast at once (nothing holds a place yet); after, the handlers below.
    signals: false,
    onWait: (why) => process.stderr.write(`queued: ${why}; starting when a place frees (cast slot ls lists them)\n`),
  });
  if (!slot.release) {
    console.error(`cast slot run: ${slot.why} for ${o.wait}; ${command[0]} did not run`);
    printHint(`run it again later, or see who holds ${o.name}: cast slot ls`);
    process.exit(EXIT_BUSY);
  }
  const child = spawn(command[0]!, command.slice(1), { stdio: "inherit" });
  // A signal goes on to the command, and its place is given back once the command has ended, so a second holder never
  // starts beside one still winding down; a command that outlives the grace is killed.
  let grace: ReturnType<typeof setTimeout> | undefined;
  const forward = (sig: NodeJS.Signals) => () => {
    child.kill(sig);
    grace ??= setTimeout(() => child.kill("SIGKILL"), CHILD_GRACE_MS);
  };
  for (const sig of SIGNALS) process.on(sig, forward(sig));
  const code = await new Promise<number>((resolve) => {
    child.on("error", (err) => { console.error(`cast slot run: ${err.message}`); resolve(127); });
    child.on("exit", (status, signal) => resolve(status ?? 128 + ((signal && osConstants.signals[signal]) || 0)));
  });
  clearTimeout(grace);
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

export function registerSlotCommand(program: Command): void {
  const slot = program.command("slot").description(commandGroup("slot").description);
  slot.command("run")
    .description("Run a command once it holds a place in a slot, and give the place back when it ends; a wait that runs out exits 75")
    .requiredOption("--name <name>", "The slot, e.g. local_ci (cast slot ls lists them)")
    .option("--wait <dur>", "Longest to wait for a place (90s, 15m, 1h); default: until one frees")
    .argument("<cmd...>", "The command, after --")
    .action((cmd: string[], o: { name: string; wait?: string }) => runSlotRun(cmd, o));
  slot.command("ls")
    .description("Each slot's cap, holders and waiters")
    .option("--json", "Print them as JSON")
    .action((o: { json?: boolean }) => runSlotLs(o));
}
