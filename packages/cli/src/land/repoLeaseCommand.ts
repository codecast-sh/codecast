// `cast repo lease --repo <owner/name> [--holder <text>] [--team <name|id>]
// [--run <id>] [--wait <dur>] [--strict] -- <cmd...>`: a command run under the repository's
// lease (repoLease.ts), so a merge made outside the Merge station (Union's
// line.ts merge) takes its turn in the same line, across machines. It waits in
// line, runs the command, and releases on the command's exit, or on
// SIGINT/SIGTERM, which it passes to the command (a SIGINT only when the
// command did not already get it from the terminal). A lease lost while the
// command runs is said loudly, and with --strict ends the command. --wait
// bounds the wait in line as the Merge station's own budget does (repoLease.ts
// waitMs): past it the command leaves the line and exits as refused, so a
// station that wraps a merge in it is never killed mid-merge by a long line.

import type { EventEmitter } from "node:events";
import type { Command } from "commander";
import { apiPost, type PublishDeps } from "../castApi.js";
import { loadWorkspaceRoster, matchTeam, unknownTeamMessage } from "../resolveWorkspace.js";
import { commandGroup } from "../commandGroupLookup.js";
import { spawn } from "../proc.js";
import { holdRepoLease, leaseHolder, type LeasePost } from "./repoLease.js";

const SIGNALS = { SIGINT: 2, SIGTERM: 15 } as const;
type Signal = keyof typeof SIGNALS;

/** `cast repo lease`'s exit when the lease could not be taken (the server refused it, or --wait ran out): never the command's. */
export const LEASE_REFUSED_EXIT = 75;

/**
 * Run `cmd` under the lease: the command's exit code, 128 + the signal that ended it, or 127 when it cannot start.
 * `forwardInt`: pass a SIGINT on to the command. By default only without a terminal: the command runs in our process
 * group, and a Ctrl-C at the terminal reaches it already, so a second one would cut short its own handling of the first.
 */
export async function runUnderLease(o: { post: LeasePost; repository: string; holder: string; cmd: string[]; log: (line: string) => void; teamId?: string; runId?: string; waitMs?: number; strict?: boolean; forwardInt?: boolean; signals?: EventEmitter; pollMs?: number; renewMs?: number }): Promise<number> {
  const signals = o.signals ?? process;
  const forwardInt = o.forwardInt ?? !process.stdin.isTTY;
  const waiting = new AbortController();
  const run: { child: ReturnType<typeof spawn> | null; stoppedBy: Signal | null } = { child: null, stoppedBy: null };
  const handlers = (Object.keys(SIGNALS) as Signal[]).map((sig) => [sig, () => {
    run.stoppedBy = sig;
    if (run.child) { if (sig !== "SIGINT" || forwardInt) run.child.kill(sig); }
    else waiting.abort();
  }] as const);
  // A lease lost under the command (this machine slept past it, the server gave it to the next in line) means another
  // merge or deploy may now run beside it: said where the person running it looks, and with --strict the command ends.
  const onLost = () => {
    o.log(`!! the lease on ${o.repository} was LOST while \`${o.cmd.join(" ")}\` runs: another merge or deploy may now run beside it${o.strict ? "; ending the command (--strict)" : ""}`);
    if (o.strict) run.child?.kill("SIGTERM");
  };
  for (const [sig, h] of handlers) signals.on(sig, h);
  const stopped = () => 128 + SIGNALS[run.stoppedBy!];
  try {
    const lease = await holdRepoLease(o.post, { repository: o.repository, holder: o.holder, log: o.log, onLost, signal: waiting.signal, ...(o.teamId ? { teamId: o.teamId } : {}), ...(o.runId ? { runId: o.runId } : {}), ...(o.waitMs !== undefined ? { waitMs: o.waitMs } : {}), ...(o.pollMs ? { pollMs: o.pollMs } : {}), ...(o.renewMs ? { renewMs: o.renewMs } : {}) })
      .catch((err) => { if (run.stoppedBy) return null; throw err; });
    if (!lease) return stopped();
    try {
      // A signal that came while the lease was being granted stops the command before it starts.
      if (run.stoppedBy) return stopped();
      return await new Promise<number>((resolve) => {
        const cannot = (err: unknown) => { o.log(`could not start ${o.cmd[0]}: ${err instanceof Error ? err.message : String(err)}`); resolve(127); };
        let child: ReturnType<typeof spawn>;
        try { child = run.child = spawn(o.cmd[0], o.cmd.slice(1), { stdio: "inherit" }); } catch (err) { return cannot(err); }
        child.on("error", cannot);
        child.on("exit", (code, signal) => resolve(code ?? 128 + (SIGNALS[signal as Signal] ?? 1)));
      });
    } finally {
      await lease.release();
    }
  } finally {
    for (const [sig, h] of handlers) signals.off(sig, h);
  }
}

export function registerRepoCommand(program: Command, deps: PublishDeps): void {
  const repo = program.command("repo").description(commandGroup("repo").description);
  repo.command("lease")
    .description(`Run a command under the repository's lease: wait in line behind every merge and deploy that holds or asked for it, on any machine, run the command, release when it exits. Exits with the command's code, or ${LEASE_REFUSED_EXIT} when the lease could not be taken`)
    .requiredOption("--repo <owner/name>", "The repository whose lease to take")
    .option("--holder <text>", "Who holds it, as others waiting read it (default: the command); this machine's name is added")
    .option("--team <name|id>", "The team that takes it, when more than one of yours works on the repository")
    .option("--run <id>", "The flow run the command is a station of: its workspace takes the lease")
    .option("--wait <dur>", `How long to wait in line (90s, 20m, 1h30m): past it, leave the line and exit ${LEASE_REFUSED_EXIT} (default: as long as it takes)`)
    .option("--strict", "End the command (SIGTERM) if the lease is lost while it runs")
    .argument("<cmd...>", "The command, after --")
    .action(async (cmd: string[], opts: { repo: string; holder?: string; team?: string; run?: string; wait?: string; strict?: boolean }) => {
      const post: LeasePost = (p, body) => apiPost(deps, p, body, { exitOnError: false });
      let waitMs: number | undefined;
      if (opts.wait !== undefined) {
        const { parseDeadline } = await import("../workflow/ciStation.js");
        const ms = parseDeadline(opts.wait);
        if (ms === null) { console.error(`--wait ${JSON.stringify(opts.wait)} is not a duration: use 90s, 20m, 2h or 1h30m`); process.exit(2); }
        waitMs = ms;
      }
      try {
        let teamId: string | undefined;
        if (opts.team) {
          const roster = await loadWorkspaceRoster(() => apiPost(deps, "/cli/teams", {}, { read: true }));
          const hit = matchTeam(roster, opts.team);
          if (!hit) throw new Error(unknownTeamMessage(roster, opts.team));
          teamId = hit._id;
        }
        process.exit(await runUnderLease({ post, repository: opts.repo, holder: leaseHolder(opts.holder ?? `\`${cmd.join(" ")}\``), cmd, log: (l) => console.error(l), teamId, runId: opts.run, waitMs, strict: !!opts.strict }));
      } catch (err) {
        console.error(`could not take the lease on ${opts.repo}: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(LEASE_REFUSED_EXIT);
      }
    });
}
