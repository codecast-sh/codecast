import type { Command } from "commander";
import { c } from "./colors.js";
import { stdinText } from "./sendBody.js";

type SendOptions = { from?: string; raw?: boolean; wake?: boolean };
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
      "A session that was killed, or has not run for longer than its prompt\n" +
      "cache lasts (one hour), is not woken by default: waking it rebuilds its\n" +
      "whole context before it reads the message. The send stops and says what\n" +
      "it would cost; pass --wake when it truly has to act. Reporting back to the\n" +
      "session that started you, or to one that declared itself dormant, always\n" +
      "goes through.\n\n" +
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
    .option("--wake", "Deliver even when the target was killed or idle past its prompt cache lifetime")
    .option("--raw", "Deliver the text exactly as typed, without the session-message wrapper — for the agent's own slash commands (/model opus, /effort high). Own sessions only.")
    .action(async (sessionId: string, text: string, options: SendOptions) => {
      const body = text ?? "";
      if (!body.trim()) throw new Error("Message text is empty");
      const from = (options.from ?? io.currentSession())?.trim() || undefined;
      if (!from && (!options.raw || options.from !== undefined)) {
        throw new Error("Sender session not detected. Nothing was sent. Pass --from <your session id>; detached scripts must carry their sender explicitly.");
      }
      if (options.raw && !/^\/[a-zA-Z]/.test(body.trim())) {
        throw new Error("--raw is only for slash commands (/model, /effort). Drop --raw so the message is attributed to the sending session.");
      }
      const result = await io.post("/cli/messages/send", {
        to: sessionId,
        from,
        body,
        ...(options.raw ? { raw: true } : { wake: options.wake === true }),
      });
      printSendResult(result, io.print, { target: sessionId, fromSession: !options.raw });
    });
}

// One report for every send into a session (cast send, cast role wake): what
// reached whom, and an honest headline when the target has no live daemon to
// take it, since the message then waits in the queue instead of arriving.
export function printSendResult(result: any, print: (text: string) => void, opts: { target: string; label?: string; fromSession: boolean }): void {
  const to = opts.label ?? `${c.cyan}${result.to_short_id || opts.target}${c.reset}`;
  const unattributed = !result.from_short_id || result.from_short_id === "unknown";
  const fromNote = !unattributed ? ` ${c.dim}from${c.reset} ${c.cyan}${result.from_short_id}${c.reset}` : "";
  const teamNote = result.cross_user ? ` ${c.dim}(teammate's session)${c.reset}` : "";
  if (result.target_live === false) {
    print(`${c.yellow}…${c.reset} queued for ${to}${fromNote}${teamNote}: it has no live daemon right now, so it is delivered when that daemon comes back. You'll be told if it is still waiting after a few minutes.`);
  } else {
    print(`${c.green}✓${c.reset} sent to ${to}${fromNote}${teamNote}`);
  }
  if (opts.fromSession && unattributed) {
    print(`${c.yellow}!${c.reset} ${c.dim}the server queued this message without resolving its sender; check --from before sending again${c.reset}`);
  }
  if (result.auto_owned) {
    print(`${c.dim}you now own this session — it'll sit in your inbox until dismissed (cast disown ${result.to_short_id || opts.target} to release)${c.reset}`);
  }
}
