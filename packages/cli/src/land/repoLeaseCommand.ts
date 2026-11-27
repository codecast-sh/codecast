// `cast repo lease --repo <owner/name> [--holder <text>] -- <cmd...>`: a
// command run under the repository's lease (repoLease.ts), so a merge made
// outside the Merge station (Union's line.ts merge) takes its turn in the same
// line, across machines. It waits in line, runs the command, and releases on
// the command's exit, or on SIGINT/SIGTERM, which it passes to the command.

import type { EventEmitter } from "node:events";
import type { Command } from "commander";
import { apiPost, type PublishDeps } from "../castApi.js";
import { commandGroup } from "../commandGroupLookup.js";
import { spawn } from "../proc.js";
import { holdRepoLease, leaseHolder, type LeasePost } from "./repoLease.js";

const SIGNALS = { SIGINT: 2, SIGTERM: 15 } as const;
type Signal = keyof typeof SIGNALS;

/** `cast repo lease`'s exit when the lease could not be taken (the server refused it): never the command's. */
export const LEASE_REFUSED_EXIT = 75;

/** Run `cmd` under the lease: the command's exit code, 128 + the signal that ended it, or 127 when it cannot start. */
export async function runUnderLease(o: { post: LeasePost; repository: string; holder: string; cmd: string[]; log: (line: string) => void; signals?: EventEmitter; pollMs?: number }): Promise<number> {
  const signals = o.signals ?? process;
  const waiting = new AbortController();
  const run: { child: ReturnType<typeof spawn> | null; stoppedBy: Signal | null } = { child: null, stoppedBy: null };
  const handlers = (Object.keys(SIGNALS) as Signal[]).map((sig) => [sig, () => {
    run.stoppedBy = sig;
    if (run.child) run.child.kill(sig);
    else waiting.abort();
  }] as const);
  for (const [sig, h] of handlers) signals.on(sig, h);
  const stopped = () => 128 + SIGNALS[run.stoppedBy!];
  try {
    const lease = await holdRepoLease(o.post, { repository: o.repository, holder: o.holder, log: o.log, signal: waiting.signal, ...(o.pollMs ? { pollMs: o.pollMs } : {}) })
      .catch((err) => { if (run.stoppedBy) return null; throw err; });
    if (!lease) return stopped();
    try {
      // A signal that came while the lease was being granted stops the command before it starts.
      if (run.stoppedBy) return stopped();
      return await new Promise<number>((resolve) => {
        const child = (run.child = spawn(o.cmd[0], o.cmd.slice(1), { stdio: "inherit" }));
        child.on("error", (err) => { o.log(`could not run ${o.cmd[0]}: ${err.message}`); resolve(127); });
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
    .argument("<cmd...>", "The command, after --")
    .action(async (cmd: string[], opts: { repo: string; holder?: string }) => {
      const post: LeasePost = (p, body) => apiPost(deps, p, body, { exitOnError: false });
      try {
        process.exit(await runUnderLease({ post, repository: opts.repo, holder: leaseHolder(opts.holder ?? `\`${cmd.join(" ")}\``), cmd, log: (l) => console.error(l) }));
      } catch (err) {
        console.error(`could not take the lease on ${opts.repo}: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(LEASE_REFUSED_EXIT);
      }
    });
}
