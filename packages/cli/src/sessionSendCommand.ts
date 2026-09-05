import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import { SESSION_UPDATE_MAX_BODY_BYTES } from "@codecast/shared/contracts";
import { c } from "./colors.js";
import { stdinText } from "./sendBody.js";

type SendOptions = { from?: string; raw?: boolean; update?: boolean; requestId?: string };
type SendIo = {
  currentSession(): string | null;
  post(path: string, body: Record<string, unknown>): Promise<any>;
  print(text: string): void;
};

type UpdateReceipt = {
  update_id: string;
  client_id: string;
  to_short_id: string;
  state: "queued" | "enqueued" | "cancelled" | "rejected";
  queued_at: number;
  flush_by: number;
  pending_message_id?: string;
  delivery_status?: string;
  reason?: string;
  members_count?: number;
};

function printUpdateReceipt(receipt: UpdateReceipt, io: SendIo, cancel = false): void {
  io.print(`${receipt.state.toUpperCase()} ${receipt.update_id} to ${receipt.to_short_id}`);
  if (cancel && receipt.state !== "cancelled") {
    io.print(receipt.state === "enqueued" ? "Not cancelled: already assigned to delivery; cancellation is too late." : `Not cancelled: update is ${receipt.state}.`);
  }
  io.print(`Request ID: ${receipt.client_id}`);
  io.print(`Queued at: ${new Date(receipt.queued_at).toISOString()}`);
  if (receipt.state === "queued") {
    io.print(`Batching deadline: ${new Date(receipt.flush_by).toISOString()} (provider delivery may wait for connectivity or safety holds)`);
  }
  if (receipt.pending_message_id) io.print(`Pending message: ${receipt.pending_message_id}`);
  if (receipt.state === "enqueued") io.print(`Delivery: ${receipt.delivery_status || "awaiting confirmation"}`);
  if (receipt.members_count !== undefined) io.print(`Batch members: ${receipt.members_count}`);
  if (receipt.reason) io.print(`Reason: ${receipt.reason}`);
}

export function registerSessionSendCommand(program: Command, io: SendIo): void {
  program
    .command("send")
    .description(
      "Send a message to another session — your own or a teammate's\n\n" +
      "The text is injected into the target session as a new turn, attributed to\n" +
      "this session so the recipient (and the dashboard) can see who sent it. You\n" +
      "can message any session you can see in the feed (your own, or one shared\n" +
      "with a team you're in). If the target session is offline, the message is\n" +
      "queued and the cron tells your session if it can't be delivered.\n\n" +
      "Detached scripts must pass --from <your session id> if the calling\n" +
      "session cannot be detected. An unattributed message is not queued.\n\n" +
      "Use --update for routine updates: persist first, collect for two seconds\n" +
      "(up to fifteen while busy), then use normal delivery. Inspect or cancel\n" +
      "a queued update with cast updates <update_id> [--cancel].\n\n" +
      "Examples:\n" +
      "  cast send jx7c6zk \"can you take the auth half?\"\n" +
      "  cast send jx7c6zk \"done\" --from jx7abcd\n" +
      "  cast send jx7c6zk \"tests passed\" --update\n" +
      "  cast send jx7c6zk --raw \"/model opus\"   # slash command, no wrapper\n" +
      "  cast send jx7c6zk - <<'EOF'\n" +
      "  Multi-line briefing with headings and code blocks,\n" +
      "  delivered exactly as written.\n" +
      "  EOF"
    )
    .argument("<session_id>", "Target session short ID (e.g. jx7c6zk)")
    .argument("<text>", stdinText("Message text"))
    .option("--from <id>", "Override sender session (required if current session cannot be detected)")
    .option("--raw", "Deliver the text exactly as typed, without the session-message wrapper — for the agent's own slash commands (/model opus, /effort high). Own sessions only.")
    .option("--update", "Queue a routine update for bounded batching, then normal delivery")
    .option("--request-id <uuid>", "Stable update request ID; reuse with the same sender, target and body after a transport failure")
    .action(async (sessionId: string, text: string, options: SendOptions) => {
      const body = text ?? "";
      if (!body.trim()) throw new Error("Message text is empty");
      if (options.update && options.raw) throw new Error("--update cannot be combined with --raw");
      if (options.requestId !== undefined && !options.update) throw new Error("--request-id requires --update");
      const from = (options.from ?? io.currentSession())?.trim() || undefined;
      if (!from && (!options.raw || options.from !== undefined)) {
        throw new Error("Sender session not detected. Nothing was sent. Pass --from <your session id>; detached scripts must carry their sender explicitly.");
      }
      if (options.update) {
        const clientId = options.requestId ?? randomUUID();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
          throw new Error("--request-id must be a UUID");
        }
        if (Buffer.byteLength(body, "utf8") > SESSION_UPDATE_MAX_BODY_BYTES) {
          throw new Error(`Update body exceeds ${SESSION_UPDATE_MAX_BODY_BYTES} UTF-8 bytes`);
        }
        io.print(`Request ID: ${clientId} (retry with --update --request-id ${clientId} and the same sender, target and body)`);
        const receipt = await io.post("/cli/messages/update", { to: sessionId, from, body, client_id: clientId });
        if (!receipt?.update_id || receipt.client_id !== clientId || !["queued", "enqueued", "cancelled", "rejected"].includes(receipt.state)) {
          throw new Error(`Update acceptance was not confirmed. Retry with --update --request-id ${clientId} and the same sender, target and body.`);
        }
        printUpdateReceipt(receipt, io);
        io.print(`Inspect: cast updates ${receipt.update_id}`);
        return;
      }
      const result = await io.post("/cli/messages/send", {
        to: sessionId,
        from,
        body,
        ...(options.raw ? { raw: true } : {}),
      });
      const fromNote = result.from_short_id && result.from_short_id !== "unknown"
        ? ` ${c.dim}from${c.reset} ${c.cyan}${result.from_short_id}${c.reset}`
        : "";
      const teamNote = result.cross_user ? ` ${c.dim}(teammate's session)${c.reset}` : "";
      io.print(`${c.green}✓${c.reset} sent to ${c.cyan}${result.to_short_id || sessionId}${c.reset}${fromNote}${teamNote}`);
      if (!options.raw && (!result.from_short_id || result.from_short_id === "unknown")) {
        io.print(`${c.yellow}!${c.reset} ${c.dim}the server queued this message without resolving its sender; check --from before sending again${c.reset}`);
      }
      if (result.target_live === false) {
        io.print(`${c.yellow}!${c.reset} ${c.dim}that session has no live daemon right now — queued; you'll be told if it can't be delivered${c.reset}`);
      }
      if (result.auto_owned) {
        io.print(`${c.dim}you now own this session — it'll sit in your inbox until dismissed (cast disown ${result.to_short_id || sessionId} to release)${c.reset}`);
      }
    });

  program
    .command("updates")
    .description("Inspect an update receipt, or cancel it before it is assigned to delivery")
    .argument("<update_id>", "Update ID returned by cast send --update")
    .option("--cancel", "Cancel only this queued update; already assigned updates are too late")
    .option("--json", "Print the server receipt as JSON")
    .action(async (updateId: string, options: { cancel?: boolean; json?: boolean }) => {
      const receipt = await io.post(options.cancel ? "/cli/messages/update-cancel" : "/cli/messages/update-status", { update_id: updateId });
      if (options.json) io.print(JSON.stringify(receipt, null, 2));
      else printUpdateReceipt(receipt, io, options.cancel);
    });
}
