// `cast state` — the agent's pinned answer to "where does this thread stand?".
//
// The text is stored on the session and rendered pinned above the composer in
// the web UI, and truncated on the inbox card, so a human opening a long or
// noisy thread learns the situation without reading the backscroll. The agent
// owns it: it rewrites the line as the work moves and clears it when the state
// no longer holds.
//
// Same deps pattern as publish.ts / imageCommand.ts: index.ts hands in config
// access, this module stays importable by tests.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Command } from "commander";
import { apiPost, type PublishDeps } from "./publish.js";
import { stdinText } from "./sendBody.js";
import { fmt, c } from "./colors.js";
import {
  normalizeThreadState,
  threadStateFreshness,
  parseThreadStateStatus,
  THREAD_STATE_MAX_CHARS,
  THREAD_STATE_STATUS_LABEL,
  type ThreadStateStatus,
} from "@codecast/shared/contracts";

// ── the local stamp the reminder hook reads ──────────────────────────────────
//
// The reminder hook (thread-state.sh, on Stop and UserPromptSubmit) must decide
// whether to nudge without a network call on every event, so the decision is
// kept on disk: a stamp file exists only while this session has a pinned state,
// and a mark beside it holds the transcript message count the thread stood at
// after the last write (plus a "nudged" flag once the reminder has fired).
// `cast state` deletes the mark on every write, which is what makes the
// reminder fire once per stretch and re-arm when the agent actually updates
// its state.

function threadStateDir(): string {
  return path.join(os.homedir(), ".codecast", "thread-state");
}

export function threadStateStampPath(sessionId: string): string {
  return path.join(threadStateDir(), `${sessionId}.json`);
}

export function threadStateCounterPath(sessionId: string): string {
  return path.join(threadStateDir(), "counters", sessionId);
}

/** What the stamp holds. `status` is the agent's declared answer to "who acts
 * next" — the daemon reads it at turn end (daemon.ts declaredSettleVerdict)
 * and settles the agent's status to "dormant" / "done" instead of plain idle
 * when the stamp was written during the turn that just ended. */
export interface ThreadStateStamp {
  at: number;
  status?: ThreadStateStatus;
}

/** Stamp "this session has a pinned state" (with the declared status) and
 * reset the reminder's message baseline. */
export function writeThreadStatePulse(sessionId: string, status?: ThreadStateStatus): void {
  try {
    fs.mkdirSync(threadStateDir(), { recursive: true });
    const stamp: ThreadStateStamp = { at: Date.now(), ...(status ? { status } : {}) };
    fs.writeFileSync(threadStateStampPath(sessionId), JSON.stringify(stamp));
    const counter = threadStateCounterPath(sessionId);
    if (fs.existsSync(counter)) fs.unlinkSync(counter);
  } catch {}
}

/** The stamp for a session, or null when it has none / is unreadable. */
export function readThreadStateStamp(sessionId: string): ThreadStateStamp | null {
  try {
    const raw = fs.readFileSync(threadStateStampPath(sessionId), "utf8");
    const parsed = JSON.parse(raw) as { at?: unknown; status?: unknown };
    if (typeof parsed.at !== "number") return null;
    const status = parseThreadStateStatus(typeof parsed.status === "string" ? parsed.status : null);
    return { at: parsed.at, ...(status ? { status } : {}) };
  } catch {
    return null;
  }
}

/** Drop the stamp — a session with no pinned state is never nudged. */
export function clearThreadStatePulse(sessionId: string): void {
  try {
    for (const file of [threadStateStampPath(sessionId), threadStateCounterPath(sessionId)]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  } catch {}
}

/** Words that mean "remove the pinned state" when they are the whole argument.
 * Deliberately excludes "done": an agent wrapping up is as likely to mean it as
 * the state text, and silently clearing on it would be a surprise. */
const CLEAR_WORDS = new Set(["clear", "rm", "unset", "none"]);

export type StateInvocation =
  | { mode: "show"; session?: string }
  | { mode: "set"; text: string; session?: string }
  | { mode: "clear"; session?: string };

/**
 * Resolve the argv shape into an intent. The command deliberately takes free
 * arguments rather than commander subcommands so that the common write —
 * `cast state "waiting on CI"` — needs no verb at all; `set`, `show` and the
 * clear words are recognized only when they are the FIRST argument, so a state
 * that happens to begin with "done deploying" is still text.
 */
export function parseStateArgs(args: string[], forSession?: string): StateInvocation {
  const [head, ...rest] = args;
  const session = forSession;

  if (head === undefined) return { mode: "show", session };

  const verb = head.toLowerCase();
  if (CLEAR_WORDS.has(verb) && rest.length === 0) return { mode: "clear", session };
  if (verb === "show" || verb === "get") {
    return { mode: "show", session: rest[0] ?? session };
  }
  if (verb === "set") {
    return { mode: "set", text: rest.join(" ").trim(), session };
  }
  return { mode: "set", text: args.join(" ").trim(), session };
}

/** "4 min ago" / "3 hours ago" / "2 days ago" for a millisecond age. */
export function formatAge(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/**
 * The one-line provenance the CLI prints under a state: when it was written and
 * how far the thread has moved since. The message gap is the part that matters —
 * it is what tells an agent reading its own state whether it is still vouching
 * for something true.
 */
export function describeProvenance(
  row: { at?: number | null; msg_count_at_write?: number | null; message_count?: number | null },
  now: number,
): string {
  const bits: string[] = [];
  if (row.at) bits.push(`set ${formatAge(Math.max(0, now - row.at))}`);
  const { messagesSince, freshness } = threadStateFreshness(
    { thread_state_at: row.at, thread_state_msg_count: row.msg_count_at_write },
    row.message_count ?? 0,
    now,
  );
  if (messagesSince != null) {
    bits.push(messagesSince === 1 ? "1 message since" : `${messagesSince} messages since`);
  }
  if (freshness === "stale") bits.push("likely stale — rewrite or clear it");
  return bits.join(", ");
}

/** The reminder line, or null when the state is still fresh (or absent). */
export function staleStateNotice(
  row: { state?: string | null; at?: number | null; msg_count_at_write?: number | null; message_count?: number | null } | null,
  now: number,
): string | null {
  if (!row?.state) return null;
  const { freshness, messagesSince } = threadStateFreshness(
    { thread_state: row.state, thread_state_at: row.at, thread_state_msg_count: row.msg_count_at_write },
    row.message_count ?? 0,
    now,
  );
  if (freshness === "fresh") return null;
  const gap = messagesSince != null
    ? `${messagesSince} messages old`
    : `set ${formatAge(Math.max(0, now - (row.at ?? now)))}`;
  return `pinned state is ${gap} — \`cast state\` to refresh it, or \`cast state clear\``;
}

/**
 * Print the reminder after a command that marks a phase boundary (`cast task
 * done`, `cast task start`, `cast plan comment`). Those are exactly the moments
 * the pinned state went out of date, and the agent is already thinking about
 * this session's status, so one dim line lands where it can be acted on.
 *
 * Silent on every failure: this rides along with another command's output and
 * must never turn that command into an error.
 */
export async function warnIfThreadStateStale(deps: PublishDeps): Promise<void> {
  try {
    const session = deps.detectCurrentSessionId();
    if (!session) return;
    const row = await apiPost(deps, "/cli/sessions/state/get", { session }, { read: true, exitOnError: false });
    const notice = staleStateNotice(row, Date.now());
    if (notice) console.log(fmt.muted(`  ${notice}`));
  } catch {}
}

/** Colored "[in progress]" / "[needs input]" / "[complete]" tag, or "" when the
 * row predates the status field. */
export function statusTag(status: string | null | undefined): string {
  const parsed = parseThreadStateStatus(status);
  if (!parsed) return "";
  const color: Record<ThreadStateStatus, string> = {
    working: c.cyan,
    blocked: c.yellow,
    done: c.green,
    dormant: c.blue,
  };
  return `${color[parsed]}[${THREAD_STATE_STATUS_LABEL[parsed].toLowerCase()}]${c.reset}`;
}

function printState(text: string, provenance: string): void {
  for (const line of text.split("\n")) {
    console.log(`  ${line ? c.reset + line : ""}`);
  }
  if (provenance) console.log(`  ${fmt.muted(provenance)}`);
}

export function registerStateCommand(program: Command, deps: PublishDeps): void {
  program
    .command("state")
    .argument("[args...]", stdinText("clear | show <session> | the text to pin"))
    .description(
      "Pin the current state of this thread — the standing answer to \"where does this stand?\"\n\n" +
      "The text renders pinned above the composer in the dashboard and on the inbox\n" +
      "card, so the human sees the situation the moment they open the session instead\n" +
      "of reading back through it. First line: what this session is working on, plain\n" +
      "and unlabeled. You own it: rewrite it whenever the answer changes, and clear it\n" +
      "when it stops being true. The dashboard shows how many messages have passed\n" +
      "since you wrote it, so a stale state is visible as stale.\n\n" +
      "Subcommands:\n" +
      "  cast state                     Print the pinned state of this session\n" +
      "  cast state \"<text>\"            Pin (or replace) the state\n" +
      "  cast state clear               Remove it\n" +
      "  cast state show <session>      Print another session's state\n\n" +
      "--status is your answer to WHO ACTS NEXT, and it decides where the session\n" +
      "files in the inbox when your turn ends:\n" +
      "  working   still moving (default)\n" +
      "  blocked   a human must act to unblock you            → Needs Input\n" +
      "  done      delivered; nothing stalled, review at leisure → Done\n" +
      "  dormant   a machine wakes you — name the wake in the text → Dormant\n" +
      "done and dormant cover exactly the turn that declares them: after the next\n" +
      "wake, declare again or the session returns to Needs Input.\n\n" +
      "Examples:\n" +
      "  cast state --status dormant \"Waiting on CI run 8841 — tr-42 re-checks at 3pm\"\n" +
      "  cast state --status blocked - <<'EOF'\n" +
      "  Migrating the sync layer to wake signatures\n" +
      "  Status: rewrite done, tests green\n" +
      "  Blocked: needs a prod key before the last check\n" +
      "  EOF\n" +
      "  cast state --status done \"Shipped — all four fixes verified in the browser\"\n" +
      "  cast state clear               # the state no longer holds",
    )
    .option(
      "--status <status>",
      "Who acts next: working (default) | blocked | done | dormant — files the session under Needs Input / Done / Dormant when the turn ends",
    )
    .option("--for <session>", "Target another session (default: the current one)")
    .option("--json", "Machine-readable output")
    .action(async (rawArgs: string[], options: { for?: string; json?: boolean; status?: string }) => {
      const args = rawArgs ?? [];

      const intent = parseStateArgs(args, options.for);
      const session = intent.session || deps.detectCurrentSessionId();
      if (!session) {
        console.error(
          "No session given and none detected — pass one with --for (e.g. cast state --for jx7c6zk \"…\")",
        );
        process.exit(1);
      }

      if (intent.mode === "show") {
        const row = await apiPost(deps, "/cli/sessions/state/get", { session }, { read: true });
        if (options.json) {
          console.log(JSON.stringify(row, null, 2));
          return;
        }
        if (!row.state) {
          console.log(`${fmt.muted(`${row.short_id} has no pinned state`)}`);
          return;
        }
        const tag = statusTag(row.status);
        console.log(`${c.cyan}${row.short_id}${c.reset}${tag ? ` ${tag}` : ""} ${fmt.muted(row.title ?? "")}`);
        printState(row.state, describeProvenance(row, Date.now()));
        return;
      }

      const text = intent.mode === "set" ? normalizeThreadState(intent.text) : "";
      if (intent.mode === "set" && !text) {
        console.error("Empty state — pass text to pin, or `cast state clear` to remove it");
        process.exit(1);
      }

      const status = intent.mode === "set" ? parseThreadStateStatus(options.status ?? "working") : null;
      if (intent.mode === "set" && !status) {
        console.error(
          `Unknown --status "${options.status}" — use working, blocked, done, or dormant`,
        );
        process.exit(1);
      }

      const result = await apiPost(deps, "/cli/sessions/state/set", { session, text, status: status ?? undefined });
      // Keep the reminder hook's local stamp in step with the write — but only
      // for THIS session. `--for` writes to somebody else's thread, and their
      // agent's reminder is keyed to their own machine's stamp, not ours.
      const own = !intent.session ? session : null;
      if (own) {
        if (result.cleared) clearThreadStatePulse(own);
        else writeThreadStatePulse(own, status ?? undefined);
      }
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.cleared) {
        console.log(
          result.previous_state
            ? `${c.green}ok${c.reset} cleared the pinned state on ${c.cyan}${result.short_id}${c.reset}`
            : fmt.muted(`${result.short_id} had no pinned state`),
        );
        return;
      }

      // Confirmation only — never echo the state back. The caller just wrote
      // it; reprinting it doubles the tokens an agent spends on every update.
      // The trailing hint also heads off a common failure: agents narrating
      // "I've updated the state" into the chat after every write. The pin is
      // already on the human's screen — the update needs no announcement.
      const truncated = intent.mode === "set" && intent.text.length > THREAD_STATE_MAX_CHARS;
      const tag = statusTag(result.status ?? status);
      console.log(
        `${c.green}ok${c.reset} pinned the state of ${c.cyan}${result.short_id}${c.reset}` +
        (tag ? ` ${tag}` : "") +
        (truncated ? ` ${fmt.muted(`(truncated to ${THREAD_STATE_MAX_CHARS} chars)`)}` : "") +
        ` ${fmt.muted("— the human already sees the pin: do not mention this update in your reply. Rewrite it when this changes; `cast state clear` when it no longer holds")}`,
      );
      // A blocked declaration from a hidden session is a claim on the human's
      // eyes — the server just honored it; say so, since the agent may believe
      // it is still out of sight.
      if ((result as { resurfaced?: boolean }).resurfaced) {
        console.log(`${c.yellow}!${c.reset} this session was hidden (stashed) — declaring blocked returned it to the user's inbox`);
      }
    });
}
