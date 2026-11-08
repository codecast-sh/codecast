import type { Command } from "commander";
import { sessionCommandOutcome, type SessionCommandOutcome } from "@codecast/shared/contracts";

type ParkingIo = {
  post(path: string, body: Record<string, unknown>): Promise<any>;
  print(text: string): void;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

export async function awaitSessionCommand(commandId: string, io: ParkingIo): Promise<SessionCommandOutcome> {
  const now = io.now ?? Date.now;
  const deadline = now() + (io.timeoutMs ?? 30_000);
  const wait = io.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  while (now() < deadline) {
    const rows = await io.post("/cli/sessions/command-results", { command_ids: [commandId] });
    const row = Array.isArray(rows) ? rows.find(r => r.command_id === commandId) : undefined;
    const outcome = sessionCommandOutcome(row);
    if (outcome.state !== "pending") return outcome;
    await wait(1000);
  }
  return { state: "pending", message: "request queued; daemon completion not confirmed yet" };
}

const HIBERNATE_HELP =
  "Park an idle session: stop its agent process, keep the transcript\n\n" +
  "The daemon parks the session only when it is idle (no turn running). The\n" +
  "next message sent to it (cast send) starts it again, or wake it by hand\n" +
  "with cast wake. Waits up to 30s for the daemon and prints its result.\n" +
  "To retire a session for good use cast kill; to take it out of the inbox\n" +
  "while it keeps running use cast stash.\n\n" +
  "Example:\n" +
  "  cast hibernate jx7c6zk";

const WAKE_HELP =
  "Start a parked (hibernated) session again in its managed pane\n\n" +
  "Brings the agent back without a message; a live agent is left alone.\n" +
  "Waits up to 30s for the daemon and prints its result. To wake a session\n" +
  "with something to do, send it the message instead: cast send <id> --wake.\n" +
  "A role's standing session: cast role wake @handle \"<message>\".\n\n" +
  "Example:\n" +
  "  cast wake jx7c6zk";

export function registerSessionParkingCommands(program: Command, io: ParkingIo): void {
  for (const command of ["hibernate", "wake"] as const) {
    program.command(command)
      .description(command === "hibernate" ? HIBERNATE_HELP : WAKE_HELP)
      .argument("<session>", "Session short ID (e.g. jx7c6zk)")
      .action(async (session: string) => {
        const requested = await io.post(`/cli/sessions/${command === "wake" ? "resume" : "hibernate"}`, { session });
        if (!requested.command_id) {
          io.print(`${requested.short_id ?? session}: request queued; this server did not provide a completion ID`);
          return;
        }
        io.print(`${requested.short_id}: ${command === "wake" ? "wake requested" : "parking requested"}`);
        const outcome = await awaitSessionCommand(requested.command_id, io);
        io.print(`${requested.short_id}: ${outcome.state === "skipped" || outcome.state === "failed" ? outcome.state + ": " : ""}${outcome.message}`);
        if (outcome.state === "failed") process.exitCode = 1;
      });
  }
}
