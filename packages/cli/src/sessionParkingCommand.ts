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

export function registerSessionParkingCommands(program: Command, io: ParkingIo): void {
  for (const command of ["hibernate", "wake"] as const) {
    program.command(command)
      .description(command === "hibernate" ? "Request safe parking of an idle session; show the daemon's result" : "Resume a parked session; show the daemon's result")
      .argument("<session>", "Session short ID")
      .action(async (session: string) => {
        const requested = await io.post(`/cli/sessions/${command === "wake" ? "resume" : "hibernate"}`, { session });
        if (!requested.command_id) {
          io.print(`${requested.short_id ?? session}: request queued; this server did not provide a completion ID`);
          return;
        }
        io.print(`${requested.short_id}: ${command === "wake" ? "wake requested" : "parking requested"}`);
        const outcome = await awaitSessionCommand(requested.command_id, io);
        io.print(`${requested.short_id}: ${outcome.state === "skipped" || outcome.state === "failed" ? outcome.state + " — " : ""}${outcome.message}`);
      });
  }
}
