// `cast advise-close <session>`: whether closing a session from the inbox
// loses anything (convex closeAdvice.adviseClose over /cli/sessions/advise).
// The CLI has no Close of its own, so the advice names the inbox's. Read-only,
// and behind the close_advice team feature, so a session without it hears that plainly.
import type { Command } from "commander";
import type { CloseAdvice, CloseAdviceResult } from "@codecast/shared/contracts/closeKind";
import { apiPost, type PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";
import { commandGroup } from "./commandGroups.js";

const DECIDED_BY: Record<CloseAdvice["decided_by"], string> = { facts: "verified facts", pin: "its pinned status", settle: "settle classifier", model: "model" };

export function formatCloseAdvice(r: CloseAdviceResult): string {
  if ("off" in r) return `${r.short_id}: ${r.message}`;
  if ("error" in r) return `No advice for ${r.short_id}: ${r.error}.`;
  const { verdict, reason, decided_by } = r.advice;
  // A newer server can name a decider this CLI does not know yet: print it as sent.
  const by = DECIDED_BY[decided_by] ?? decided_by;
  if (verdict === "needs_input") return `${r.short_id}  needs you — ${reason} (${by})`;
  // The facts' reason is what the inbox's Close does; the others' is what the session finished.
  if (decided_by === "facts") return `${r.short_id}  close — Close it from the inbox: ${reason} (${by})`;
  return `${r.short_id}  close — Close it from the inbox; ${reason.replace(/\.$/, "")} (${by})`;
}

export function registerAdviseCloseCommand(program: Command, deps: PublishDeps): void {
  program
    .command("advise-close", { hidden: true })
    .description(commandGroup("advise-close").description)
    .argument("<session>", "Session short ID")
    .option("--json", "Print {short_id} with advice {verdict: close|needs_input, reason, decided_by: facts|pin|settle|model}, error, or off: team|personal with its message")
    .action(async (session: string, opts: { json?: boolean }) => {
      const result: CloseAdviceResult = await apiPost(deps, "/cli/sessions/advise", { session });
      if (opts.json) console.log(JSON.stringify(result));
      else if ("advice" in result) console.log(formatCloseAdvice(result));
      else console.log(fmt.muted(formatCloseAdvice(result)));
    });
}
