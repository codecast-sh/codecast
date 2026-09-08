import type { Command } from "commander";
import { c } from "./colors.js";
import { stdinText } from "./sendBody.js";

type SendOptions = { from?: string; raw?: boolean };
type SendIo = {
  currentSession(): string | null;
  post(path: string, body: Record<string, unknown>): Promise<any>;
  print(text: string): void;
};

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
      "Examples:\n" +
      "  cast send jx7c6zk \"can you take the auth half?\"\n" +
      "  cast send jx7c6zk \"done\" --from jx7abcd\n" +
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
    .action(async (sessionId: string, text: string, options: SendOptions) => {
      const body = text ?? "";
      if (!body.trim()) throw new Error("Message text is empty");
      const from = (options.from ?? io.currentSession())?.trim() || undefined;
      if (!from && (!options.raw || options.from !== undefined)) {
        throw new Error("Sender session not detected. Nothing was sent. Pass --from <your session id>; detached scripts must carry their sender explicitly.");
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
}
