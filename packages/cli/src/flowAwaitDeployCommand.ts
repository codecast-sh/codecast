// `cast flow await-deploy` (flows.md FL4), moved out of flowCommand.ts to keep it under the file size cap: the Deploy
// stage's wait, run by the deploy segment's parked station in the change's worktree.
import type { Command } from "commander";
import type { FlowDeps } from "./flowCommand.js";

type Cast = (args: string[], cwd: string) => Promise<{ code: number; out: string; err: string }>;

export function registerFlowAwaitDeployCommand(flow: Command, deps: Pick<FlowDeps, "cliPost" | "realCwd">, cast: Cast): void {
  // The Deploy stage's wait (workflow/awaitDeploy.ts, flows.md FL4): run by the
  // deploy segment's parked station in the change's worktree.
  flow
    .command("await-deploy")
    .description("Wait until a change's branch has landed on the default branch and the deploy carrying it is live on every target its files touch; exits 1 when that deploy failed")
    .requiredOption("--branch <name>", "The change's branch")
    .option("--base <name>", "The default branch it lands on", "main")
    .option("--interval <seconds>", "How often to look again", "60")
    .option("--once", "Look once and say where it stands: exit 0 live (or nothing to deploy), 1 failed, 3 still waiting")
    .option("--run <id>", "The run whose station this is: each new line goes on the station while it waits")
    .option("--node <id>", "That station's id in the run")
    .option("--files <paths>", "The change's files, space-separated (the run's $change_files); else read from git")
    .option("--except <targets>", "Targets the change does not wait for, space- or comma-separated")
    .option("--send <policy>", "Once the change lands, send the targets it touches whose policy this names (release) with cast deploy, then wait")
    .action(async (opts: { branch: string; base: string; interval: string; once?: boolean; run?: string; node?: string; files?: string; except?: string; send?: string }) => {
      const { landedCommit, targetTouches, targetState, deployWords, holds } = await import("./workflow/awaitDeploy.js");
      const cwd = deps.realCwd();
      const every = Math.max(5, Number(opts.interval) || 60) * 1000;
      let said = "";
      let sent = false;
      // Inside a run the waiting lines go to the station on the card, and only the verdict is the station's output,
      // which is what a stop and the session's end message quote. At a terminal every line prints.
      const say = (line: string, verdict = false) => {
        if (line === said) return;
        if (verdict || !opts.run) console.log(line);
        said = line;
        // What the card shows on the station while the run waits there.
        if (opts.run && opts.node) void deps.cliPost("/cli/workflow-runs/progress", { run_id: opts.run, current_node_id: opts.node, node_id: opts.node, node_status: "running", result_preview: line }).catch(() => {});
      };
      for (;;) {
        const known = (opts.files ?? "").split(/\s+/).filter(Boolean);
        const landed = await landedCommit(cwd, opts.branch, opts.base, known).catch((err) => { say(`Cannot read ${opts.branch} here: ${err instanceof Error ? err.message : String(err)}`); return null; });
        if (landed) {
          const read = await cast(["line", "deploy", "targets", "--json"], cwd);
          let targets: import("./workflow/awaitDeploy.js").DeployTargetRow[] | null = null;
          try { targets = JSON.parse(read.out).targets ?? []; } catch { say(`Waiting to read the deploy targets: ${(read.err || read.out).trim().split("\n").pop()}`); }
          // The flow sends what the repository says goes out with a release (deploys.md DP15), once, then waits like any change.
          if (targets && opts.send === "release" && !sent && !opts.once) {
            sent = true;
            say(`${landed.sha.slice(0, 10)} landed; sending the release targets it touches.`);
            const release = await cast(["deploy", "--carrying", landed.sha, "--files", landed.files.join(" "), ...(opts.except ? ["--except", opts.except] : [])], cwd);
            const last = (release.out + release.err).trim().split("\n").filter(Boolean);
            if (release.code !== 0) say(`cast deploy stopped: ${last.slice(-3).join(" | ")}`);
            const reread = await cast(["line", "deploy", "targets", "--json"], cwd);
            try { targets = JSON.parse(reread.out).targets ?? targets; } catch { /* keep the first read */ }
          }
          if (targets) {
            const skipped = new Set((opts.except ?? "").split(/[\s,]+/).filter(Boolean));
            const touched = targets.filter((t) => !skipped.has(t.name) && targetTouches(t.paths, landed.files));
            const states = await Promise.all(touched.map((t) => targetState(t, (sha) => holds(cwd, landed.sha, sha))));
            const failed = states.some((s) => s.state === "failed");
            const live = states.every((s) => s.state === "live");
            say(deployWords(landed.sha, states), failed || live);
            if (failed) process.exit(1);
            if (live) return;
          }
        } else say(`Waiting for ${opts.branch} to land on ${opts.base}.`);
        if (opts.once) { if (opts.run) console.log(said); process.exit(3); }
        await new Promise((r) => setTimeout(r, every));
      }
    });
}
