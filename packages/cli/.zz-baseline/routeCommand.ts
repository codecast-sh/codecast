// `cast route "<request>"` (docs/architecture/org-staffing.md S35): where a
// request lands, by the one rule, and why. Scripts and systems outside
// codecast use the same door as `POST /cli/route`. A request the rule cannot
// place is read by the semantic router; when it is not confident, the choices
// come back here: a person at a terminal picks one, a script reads `choices`.

import type { Command } from "commander";
import type { OrgInitDeps } from "./orgInit.js";
import { readStdinBody } from "./sendBody.js";

const c = { green: "\x1b[32m", dim: "\x1b[2m", yellow: "\x1b[33m", bold: "\x1b[1m", reset: "\x1b[0m" };

export type RouteCliResult = {
  owner: { kind: "role"; handle: string; name: string; role_id: string } | { kind: "user"; user_id: string } | null;
  line: number;
  why: string;
  confidence?: number;
  choices?: Array<{ handle: string; confidence?: number; reason: string }>;
  dry: boolean;
  task?: { short_id: string } | null;
  woke?: { short_id: string } | null;
  not_woken?: string;
};

/** The lines a person reads for one landing; pure, for the test. */
export function routeLines(r: RouteCliResult): string[] {
  const who = r.owner ? (r.owner.kind === "role" ? `@${r.owner.handle}` : "you") : null;
  const conf = r.confidence !== undefined ? ` ${c.dim}(${Math.round(r.confidence * 100)}% sure)${c.reset}` : "";
  if (!who) {
    const out = [`${c.yellow}Nobody yet${c.reset} · line ${r.line}: ${r.why}${conf}`];
    if (r.choices?.length) {
      out.push("Choices:");
      r.choices.forEach((ch, i) => out.push(`  ${i + 1}. @${ch.handle}${ch.confidence !== undefined ? ` ${c.dim}(${Math.round(ch.confidence * 100)}%)${c.reset}` : ""}  ${ch.reason}`));
      out.push(`${c.dim}Pick one with: cast route --to @<handle> "<the request>"${c.reset}`);
    }
    return out;
  }
  const out = [`${r.dry ? `${c.dim}dry${c.reset} ` : `${c.green}✓${c.reset} `}→ ${c.bold}${who}${c.reset} · line ${r.line}: ${r.why}${conf}`];
  if (r.task) out.push(`  task ${r.task.short_id}${r.woke ? `, @${(r.owner as any).handle} woken in ${r.woke.short_id}` : ""}`);
  if (r.not_woken) out.push(`  ${c.yellow}not woken:${c.reset} ${r.not_woken}`);
  return out;
}

export function registerRouteCommand(program: Command, deps: OrgInitDeps): void {
  program
    .command("route")
    .description("Where a request lands in the org, by the one rule: named, anchored, started, or read by the router. Files it as a task for the owner and wakes a role.")
    .argument("<request>", "The request; '-' reads it from stdin (heredoc-friendly)")
    .option("--to <who>", "Name the owner yourself: @handle, or-N, or me (line 1)")
    .option("--task <ct-N>", "The task it is about (line 2)")
    .option("--plan <pl-N>", "The plan it is about (line 2)")
    .option("--project <ref>", "The project it is about: title or pr-N (line 2)")
    .option("--team <name|id|personal>", "Workspace (default: the active one)")
    .option("--dry", "Say where it would land and why; write nothing")
    .option("--json", "Machine-readable output")
    .addHelpText("after", `
  cast route "Warm the three new sender domains before Monday"
  cast route --to @cold-email "Warm the three new sender domains"
  cast route --plan pl-54 --dry "Add the bounce report to the daily check"
  cast route - --json <<'EOF'
  ...a longer request...
  EOF

The line says which rule placed it: 1 named (--to), 2 anchored (--task,
--plan, --project: the role that names the work, S26), 3 started (it stays
with whoever started it), 4 read (the semantic router). Unsure, the router
answers with choices and files nothing; pick one with --to.`)
    .action(async (request: string, options: any) => {
      const body = request === "-" ? readStdinBody() : request;
      const ws = await deps.readWorkspace(options.team);
      const result: RouteCliResult = await deps.cliPost("/cli/route", {
        request: body,
        ...deps.workspaceArgs(ws),
        ...(options.to ? { to: options.to } : {}),
        ...(options.task ? { task: options.task } : {}),
        ...(options.plan ? { plan: options.plan } : {}),
        ...(options.project ? { project: options.project } : {}),
        ...(options.dry ? { dry: true } : {}),
        from_session: deps.callingSession(),
      });
      if (options.json) { console.log(JSON.stringify(result, null, 2)); if (!result.owner) process.exit(2); return; }
      for (const line of routeLines(result)) console.log(line);
      if (result.owner) return;
      // A person at a terminal picks; a script reads the choices and exits 2.
      if (!result.choices?.length || !process.stdin.isTTY || !process.stdout.isTTY || options.dry) process.exit(2);
      const readline = await import("node:readline");
      const iface = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => iface.question(`Which one? [1-${result.choices!.length}, or Enter to leave it] `, resolve));
      iface.close();
      const n = Number(answer.trim());
      const pick = Number.isInteger(n) && n >= 1 && n <= result.choices.length ? result.choices[n - 1] : null;
      if (!pick) { console.log(`${c.dim}Left unplaced.${c.reset}`); process.exit(2); }
      const filed: RouteCliResult = await deps.cliPost("/cli/route", { request: body, ...deps.workspaceArgs(ws), to: `@${pick.handle}`, from_session: deps.callingSession() });
      for (const line of routeLines(filed)) console.log(line);
    });
}
