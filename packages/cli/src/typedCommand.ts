// `cast typed`: when the signed-in person typed messages into codecast
// sessions (convex userSends.typedSince), across every machine and workspace.
// Times are unix seconds; no message text ever leaves the server. Built for a
// script that reads it as a productivity signal and fails closed, so any
// refusal or network failure exits non-zero.
import type { Command } from "commander";
import type { PublishDeps } from "./castApi.js";
import { JSON_OPTION, fail, postOrFail } from "./externalDataCli.js";
import { parseAnsweredSince } from "./decideCommand.js";

export interface TypedRow {
  at: number;
  session: string;
  chars: number;
  kind: "message" | "decision_written" | "decision_picked";
}

export interface TypedPage {
  messages: TypedRow[];
  next: number | null;
}

export interface TypedReport {
  now: number;
  since: number;
  messages: TypedRow[];
}

const secs = (ms: number) => Math.floor(ms / 1000);

/** Every page of the window, oldest first, with times in unix seconds. */
export async function readTyped(read: (body: Record<string, unknown>) => Promise<TypedPage>, sinceMs: number, nowMs: number): Promise<TypedReport> {
  const messages: TypedRow[] = [];
  let after: number | undefined;
  for (;;) {
    const page = await read({ since: sinceMs, ...(after !== undefined ? { after } : {}) });
    if (!page || !Array.isArray(page.messages)) throw new Error("the server answered without a list of messages");
    for (const m of page.messages) messages.push({ ...m, at: secs(m.at) });
    if (page.next === null || page.next === undefined) break;
    after = page.next;
  }
  return { now: secs(nowMs), since: secs(sinceMs), messages };
}

export function formatTyped(report: TypedReport): string {
  if (report.messages.length === 0) return "Nothing typed in this window.";
  return report.messages
    .map((m) => {
      const t = new Date(m.at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      return `${t}  ${m.session}  ${String(m.chars).padStart(5)} chars${m.kind === "message" ? "" : `  (${m.kind.replace("_", " ")})`}`;
    })
    .join("\n");
}

export function registerTypedCommand(program: Command, deps: PublishDeps): void {
  program
    .command("typed")
    .description("When you typed messages into codecast sessions, on every machine and workspace: time, session and length, no text")
    .requiredOption("--since <time>", "Window start: 30m, 3h, 24h, 7d, epoch ms, or an ISO date")
    .option(...JSON_OPTION)
    .addHelpText("after", `
Counts what a person typed in the composer (web, desktop, phone) or the agent's
terminal. Leaves out trigger prompts, cast send and teammate messages, task
notifications, hook output, compaction summaries, imports, slash commands and
the opening prompt of a session a program started. A decision-card answer is
kept and marked by kind: decision_picked (an option tapped) or decision_written.

  cast typed --since 3h --json
  {"now":1795390000,"since":1795379200,"messages":[{"at":1795389100,"session":"jx7d2e1","chars":212,"kind":"message"}]}`)
    .action(async (o: { since: string; json?: boolean }) => {
      const now = Date.now();
      const since = parseAnsweredSince(o.since, now);
      if (since === null || since > now) fail("--since takes a window like 3h, 24h or 7d (or epoch ms, or an ISO date)");
      let report: TypedReport;
      try {
        report = await readTyped((body) => postOrFail(deps, "/cli/typed", body, { read: true }), since, now);
      } catch (err) {
        fail(`cast typed: ${err instanceof Error ? err.message : String(err)}`);
      }
      console.log(o.json ? JSON.stringify(report) : formatTyped(report));
    });
}
