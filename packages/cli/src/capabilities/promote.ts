// `cast cap promote`: move guidance from a person's own instruction file into a
// repository's CLAUDE.md or a team instructions item. The work is
// kitPromote.ts's, loaded when the verb runs; this file registers and wires it.

import * as path from "path";
import type { Command } from "commander";
import type { PublishDeps } from "../castApi.js";

export function registerCapPromote(cap: Command, _deps: PublishDeps): void {
  cap
    .command("promote")
    .description("Move guidance from your own CLAUDE.md into this repository's CLAUDE.md or your team's kit")
    .option("--file <path>", "The personal instruction file (default ~/.claude/CLAUDE.md)")
    .option("--repo <dir>", "The repository to promote into (default: the one you are in)")
    .option("--team <name|id>", "The team whose kit receives team guidance")
    .option("--model <id>", "The model that proposes the moves")
    .option("--scan", "List the proposed moves without asking or writing")
    .action(async (opts: { file?: string; repo?: string; team?: string; model?: string; scan?: boolean }) => {
      const os = await import("os");
      const { runPromote } = await import("./kitPromote.js");
      const readline = await import("node:readline/promises");
      const { spawnSync } = await import("../proc.js");
      const { selfExecInfo } = await import("../selfExec.js");
      const { subscriptionModelCall } = await import("../subscriptionCall.js");
      if (!opts.scan && !process.stdin.isTTY) {
        console.error("cast cap promote asks about each line; run it in a terminal, or pass --scan to list the proposals.");
        process.exit(2);
      }
      const cwd = path.resolve(opts.repo ?? (process.env.CODECAST_CWD || process.cwd()));
      const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
      const rl = opts.scan ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        await runPromote({
          home: process.env.HOME || os.homedir(),
          personalFile: opts.file ? path.resolve(opts.file) : undefined,
          repoRoot: top.status === 0 ? String(top.stdout).trim() : null,
          model: (spec) => subscriptionModelCall(spec),
          modelId: opts.model,
          ask: (q) => rl!.question(q),
          publishInstructions: async (file, heading) => {
            const { executablePath, args } = selfExecInfo("cap", "publish", "--instructions", `${file}#${heading}`, ...(opts.team ? ["--team", opts.team] : []));
            return spawnSync(executablePath, args, { stdio: "inherit" }).status === 0;
          },
          print: (line) => console.log(line),
          scan: opts.scan,
        });
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      } finally {
        rl?.close();
      }
    });
}
