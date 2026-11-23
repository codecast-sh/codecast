import type { Command } from "commander";
import { c } from "./colors.js";
import { stdinText } from "./sendBody.js";
import { sendArrivalPhrase, type SendArrival } from "@codecast/shared/contracts";

type SendOptions = { from?: string; raw?: boolean; wake?: boolean; done?: boolean; fyi?: boolean; status?: boolean };
type SendIo = {
  currentSession(): string | null;
  post(path: string, body: Record<string, unknown>): Promise<any>;
  print(text: string): void;
  /** Keep a refused message's body on disk; returns the file's path. */
  hold?(target: string, body: string): string;
};

/** The server's refusal of a killed target (pendingMessages.killedSendMessage). */
const REFUSED = /^Not sent\./;
// The server's refusal of a role writing into a session a person drives
// (convex lib/sessionTakeOver pausedRoleRefusal).
const PAUSED_ROLE = /^Not sent\. .+ drives \S+/;

export function registerSessionSendCommand(program: Command, io: SendIo): void {
  program
    .command("send")
    .description(
      "Send a message to another session, your own or a teammate's\n\n" +
      "The text is injected into the target session as a new turn, attributed to\n" +
      "this session so the recipient (and the dashboard) can see who sent it. You\n" +
      "can message any session you can see in the feed (your own, or one shared\n" +
      "with a team you're in). A message that has not reached the target after a\n" +
      "few minutes stays queued, and your session is told why: the target is\n" +
      "offline, or idle while its machine fails to deliver. Waiting on a busy\n" +
      "session of your own is not reported.\n\n" +
      "A send to a killed session stops and says what restarting it would cost,\n" +
      "unless it is your own worker; pass --wake when it truly has to act. The\n" +
      "refused message is kept in a file, and the refusal prints the one command\n" +
      "that sends it. Every other session takes the message, however long it idled.\n\n" +
      "Detached scripts must pass --from <your session id> if the calling\n" +
      "session cannot be detected. An unattributed message is not queued.\n\n" +
      "The receipt says when the message arrives: now (the target is idle), at\n" +
      "its next tool call (a busy Claude Code session; a turn that makes no\n" +
      "further call takes it when it ends), when its current turn ends (other\n" +
      "busy sessions), once someone answers a prompt open in it, once it\n" +
      "finishes starting, once its machine resumes it, or when its machine\n" +
      "comes back online.\n\n" +
      "A message asks for a reply unless marked otherwise: --fyi needs no reply,\n" +
      "and --done closes the exchange, so the recipient must not answer it. Use\n" +
      "--done for a final result nobody needs to acknowledge.\n\n" +
      "Examples:\n" +
      "  cast send jx7c6zk \"can you take the auth half?\"\n" +
      "  cast send jx7c6zk --done \"auth half merged in 1a2b3c; nothing left for you\"\n" +
      "  cast send jx7c6zk --fyi \"main is red from 9f8e7d, not your change\"\n" +
      "  cast send jx7c6zk --status               # your last sends there: typed in, delivered\n" +
      "  cast send jx7c6zk --raw \"/model opus\"   # slash command, no wrapper\n" +
      "  cast send jx7c6zk - <<'EOF'\n" +
      "  Multi-line briefing with headings and code blocks,\n" +
      "  delivered exactly as written.\n" +
      "  EOF"
    )
    .argument("<session_id>", "Target session short ID (e.g. jx7c6zk)")
    .argument("[text]", stdinText("Message text"))
    .option("--from <id>", "Override sender session (required if current session cannot be detected)")
    .option("--wake", "Deliver even when the target was killed")
    .option("--done", "Close the exchange: the recipient must not reply")
    .option("--fyi", "For information: the recipient need not reply")
    .option("--status", "Show your recent sends to this session: when each was typed in and delivered")
    .option("--raw", "Deliver the text exactly as typed, without the session-message wrapper, for the agent's own slash commands (/model opus, /effort high). Own sessions only.")
    .action(async (sessionId: string, text: string | undefined, options: SendOptions) => {
      if (options.status) {
        if (text !== undefined) throw new Error("--status takes no message text");
        const extra = (["done", "fyi", "raw", "wake"] as const).find((flag) => options[flag]);
        if (extra) throw new Error(`--status shows past sends; it does not take --${extra}`);
        const from = (options.from ?? io.currentSession())?.trim();
        if (!from) throw new Error("Sender session not detected. Pass --from <your session id>.");
        printSendStatus(await io.post("/cli/messages/status", { to: sessionId, from }), io.print, Date.now());
        return;
      }
      if (options.done && options.fyi) throw new Error("Pick one of --done and --fyi");
      const intent = options.done ? "done" : options.fyi ? "inform" : undefined;
      if (intent && options.raw) throw new Error("--done and --fyi mark a message from a session; drop --raw");
      const body = text ?? "";
      if (!body.trim()) throw new Error("Message text is empty");
      const from = (options.from ?? io.currentSession())?.trim() || undefined;
      if (!from && (!options.raw || options.from !== undefined)) {
        throw new Error("Sender session not detected. Nothing was sent. Pass --from <your session id>; detached scripts must carry their sender explicitly.");
      }
      if (options.raw && !/^\/[a-zA-Z]/.test(body.trim())) {
        throw new Error("--raw is only for slash commands (/model, /effort). Drop --raw so the message is attributed to the sending session.");
      }
      let result: any;
      try {
        result = await io.post("/cli/messages/send", {
          to: sessionId,
          from,
          body,
          ...(options.raw ? { raw: true } : { wake: options.wake === true }),
          ...(intent ? { intent } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!REFUSED.test(message) || !io.hold) throw err;
        // The sender decides with the cost in front of it; the body waits in a
        // file so sending it after all never means typing it again.
        const kept = io.hold(sessionId, body);
        // A killed target can be sent to after all; a paused role cannot.
        if (PAUSED_ROLE.test(message)) throw new Error(`${message}\nYour message is kept in ${kept}`);
        const intentFlag = options.done ? " --done" : options.fyi ? " --fyi" : "";
        throw new Error(`${message}\nYour message is kept. To send it after all: cast send --wake${intentFlag} ${sessionId} - < ${kept}`);
      }
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
  const arrives = arrivalOf(result);
  if (arrives === "when_online") {
    print(`${c.yellow}…${c.reset} queued for ${to}${fromNote}${teamNote}, arrives ${sendArrivalPhrase(arrives)}. You'll be told if it is still waiting after a few minutes.`);
  } else if (arrives === "held" || arrives === "with_owner" || arrives === "never") {
    print(`${c.yellow}…${c.reset} queued for ${to}${fromNote}${teamNote}, arrives ${sendArrivalPhrase(arrives)}.`);
  } else {
    print(`${c.green}✓${c.reset} sent to ${to}${fromNote}${teamNote}${arrives ? `, arrives ${sendArrivalPhrase(arrives)}` : ""}`);
  }
  if (opts.fromSession && unattributed) {
    print(`${c.yellow}!${c.reset} ${c.dim}the server queued this message without resolving its sender; check --from before sending again${c.reset}`);
  }
  if (result.auto_owned) {
    print(`${c.dim}you now own this session — it'll sit in your inbox until dismissed (cast disown ${result.to_short_id || opts.target} to release)${c.reset}`);
  }
}

// The server's `arrives`; an older server sends only `target_live`.
function arrivalOf(result: any): SendArrival | undefined {
  if (typeof result.arrives === "string") return result.arrives as SendArrival;
  return result.target_live === false ? "when_online" : undefined;
}

const STATUS_WORDS: Record<string, string> = {
  pending: "queued",
  held: "queued",
  unconfirmed: "unconfirmed",
  delivered: "delivered",
  failed: "failed",
  undeliverable: "undeliverable",
  cancelled: "cancelled",
};

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// One line per send, newest first: when it went, what became of it, when the
// daemon typed it in and when its delivery was confirmed.
export function printSendStatus(result: any, print: (text: string) => void, now: number): void {
  const to = `${c.cyan}${result.to_short_id}${c.reset}`;
  const sends: any[] = result.sends ?? [];
  if (sends.length === 0) {
    print(`No sends from this session to ${to}.`);
    return;
  }
  print(`Your last ${sends.length === 1 ? "send" : `${sends.length} sends`} to ${to}, newest first:`);
  for (const send of sends) {
    // "injected" is also the daemon's claim before it pastes: only a verified
    // paste reads as typed in.
    const state = send.status === "injected" ? (send.typed_in_at ? "typed in" : "sending") : STATUS_WORDS[send.status] ?? send.status;
    const color = send.status === "delivered" ? c.green : ["failed", "undeliverable", "cancelled"].includes(send.status) ? c.red : c.yellow;
    const times = [
      `sent ${ago(send.created_at, now)}`,
      send.typed_in_at ? `typed in ${ago(send.typed_in_at, now)}` : null,
      send.delivered_at ? `delivered ${ago(send.delivered_at, now)}` : null,
    ].filter(Boolean).join(", ");
    const tag = send.intent && send.intent !== "request" ? ` ${c.dim}[${send.intent === "inform" ? "fyi" : send.intent}]${c.reset}` : "";
    const reason = send.reason ? ` ${c.dim}(${send.reason})${c.reset}` : "";
    print(`  ${color}${state.padEnd(14)}${c.reset}${times}${reason}${tag}  ${c.dim}${send.preview}${c.reset}`);
  }
}
