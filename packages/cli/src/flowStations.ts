// The change flow's stations as `cast flow` subcommands (flows.md FL4). Each is
// a script a station of the library change flow runs; its exit code is the
// route the graph takes.
import type { Command } from "commander";
import { spawnSync } from "./proc.js";
import type { FlowDeps } from "./flowCommand.js";
import type { MergeProof } from "./workflow/prStation.js";

/**
 * A waiting station's lines on its card. A post that fails is logged and the wait goes on: without throwOnError the
 * CLI's cliPost exits the process on any error reply, and one bad gateway must not end a four-hour wait.
 */
export function stationProgress(deps: Pick<FlowDeps, "cliPost">, run: string | undefined, node: string | undefined): (line: string) => void {
  return (line) => {
    if (!run || !node) return console.error(line);
    void deps.cliPost("/cli/workflow-runs/progress", { run_id: run, current_node_id: node, node_id: node, node_status: "running", result_preview: line }, { throwOnError: true })
      .catch((err) => console.error(`${line} (not posted to the run: ${err instanceof Error ? err.message : String(err)})`));
  };
}

/** A station script's report to its run. One that fails is logged and the station goes on. */
async function reportToRun(deps: Pick<FlowDeps, "cliPost">, what: string, route: string, body: { run_id?: string } & Record<string, unknown>): Promise<void> {
  if (!body.run_id) return console.error(`${what} was not recorded on the run: no run ($run_id)`);
  await deps.cliPost(route, body, { throwOnError: true })
    .catch((err) => console.error(`${what} was not recorded on the run: ${err instanceof Error ? err.message : String(err)}`));
}

/**
 * The run's pull request and the head pushed, on the server: the first one is what a Ship press approves
 * (convex changeApprovals.ts), and a pull request no run reported reads as a bot's. A failed report costs the
 * approval status a wait, never the station.
 */
export async function recordRunPr(deps: Pick<FlowDeps, "cliPost">, pr: { run_id?: string; repository?: string | null; number: number; head_sha: string }): Promise<void> {
  if (!pr.repository) return console.error("the pull request was not recorded on the run: no repository");
  await reportToRun(deps, "the pull request", "/cli/workflow-runs/pr", { run_id: pr.run_id, repository: pr.repository, number: pr.number, head_sha: pr.head_sha });
}

export function registerFlowStations(flow: Command, deps: FlowDeps): Command {
  // What the server holds for the run's attempt (orgLineMerge.mergeProofCore), or null without a run or an answer:
  // then nothing is carried, and the round is reviewed.
  const mergeProof = async (runId: string | undefined): Promise<MergeProof | null> => {
    if (!runId) return null;
    try { return await deps.cliPost("/cli/workflow-runs/merge-proof", { run_id: runId }, { throwOnError: true }); } catch { return null; }
  };
  // Land's check that the change is on main (workflow/landed.ts): run by templates/line/ship.sh after the land command.
  flow
    .command("landed")
    .description("Find the commit on origin's default branch that carries a change's branch and write it as merge.json; exit 1 when nothing was merged")
    .option("--branch <name>", "The change's branch")
    .option("--base <name>", "The default branch it lands on", "main")
    .option("--files <paths>", "The change's files, space-separated (the run's $change_files); else read from git")
    .option("--out <file>", "Where to write { sha, files } (the run's $run_dir/merge.json)")
    .option("--since <sha>", "Where the change started (its fork from the default branch before it landed): a branch with nothing of its own since is never landed")
    .option("--wait <seconds>", "Wait this long for the branch to merge (a pull request Ship's session merges); exit 2 when it has not")
    .option("--interval <seconds>", "How often to look again while waiting", "30")
    .option("--as <name>", "The branch's name on the run's merge record, when --branch is a commit")
    .option("--run <id>", "The run whose station this is: the landed commit is recorded as its merge, and each waiting line goes on the station")
    .option("--node <id>", "That station's id in the run")
    .action(async (opts: import("./workflow/landed.js").LandedOptions) => {
      const { runLanded } = await import("./workflow/landed.js");
      process.exit(await runLanded(deps.realCwd(), opts, (p, b) => deps.cliPost(p, b, { throwOnError: true })));
    });

  // The personal flow's Check station (workflow/personalCheck.ts): runs what Find check read from the docs.
  flow
    .command("check")
    .description("Run the check commands a personal flow's Find check read from the project's docs, each in the change's tree; prints and writes check.json {outcome: pass|fail|skipped, note, results: [{run, cwd, source, exit, tail}]}; exits 0 once it ran them, 2 when the answer cannot be read")
    .requiredOption("--spec <json>", "Find check's answer: {outcome: found|skipped, note, commands: [{run, cwd, source}]}")
    .requiredOption("--tree <path>", "The change's tree, where each command's directory resolves")
    .requiredOption("--dir <path>", "The run's directory: check.json and each command's check-<n>.log go there")
    .action(async (opts: { spec: string; tree: string; dir: string }) => {
      const { runCheck } = await import("./workflow/personalCheck.js");
      const r = runCheck(opts);
      if (typeof r === "string") { console.log(r); process.exit(2); }
      console.log(JSON.stringify(r));
    });

  // The change flow's CI station (workflow/ciStation.ts): parks on the pull request's checks.
  flow
    .command("ci")
    .description("Wait for a pull request's CI, rerun failed jobs once, and write ci.json: green only when GitHub's runs and every outside check passed, red failures split by whether main has them too; always exits 0")
    .requiredOption("--pr <number>", "The pull request")
    .requiredOption("--dir <path>", "The run's directory, where ci.json is written")
    .option("--deadline <duration>", "How long to wait for the checks (90s, 60m, 2h, 1h30m)", "60m")
    .option("--head <sha>", "Judge only this head: wait until the pull request's head is it")
    .option("--pushed", "Judge only the head pr.json in --dir holds now (the PR station's push, or a retest's rebase)")
    .option("--run <id>", "The run whose station this is: each new line goes on the station while it waits, and the verdict to the run (default: $run_id)")
    .option("--node <id>", "That station's id in the run (default: $station_id)")
    .action(async (opts: { pr: string; dir: string; deadline: string; head?: string; pushed?: boolean; run?: string; node?: string }) => {
      if (opts.pushed && !opts.head) {
        const head = (await import("./workflow/prStation.js")).readPr(opts.dir)?.head_sha;
        // No head to judge: no ci.json, which Verdicts reads as CI that never reported.
        if (!head) return console.error(`--pushed: no pr.json with a head_sha in ${opts.dir}`);
        opts.head = head;
      }
      await (await import("./workflow/ciStation.js")).ciCommand(opts, deps.cliPost);
    });

  // The change flow's PR station (workflow/prStation.ts, flows.md FL4).
  flow
    .command("pr")
    .description("Start a round: clear the last round's verdicts, push the change's branch and open its pull request, or update the open one; writes pr.json {url, number, head_sha, branch} in --dir and prints it")
    .option("--branch <name>", "The change's branch")
    .requiredOption("--dir <path>", "The run's directory")
    .option("--base <name>", "The branch it merges into", "main")
    .option("--title <text>", "The title of a pull request it opens (else the change's title)")
    .option("--body <text>", "The body of a pull request it opens", "")
    .option("--refresh", "Merge pushed the branch rebased for a retest: take origin's branch as the head, keep the review")
    .option("--rebase", "Main went green again: put origin's branch onto --base, push it, and keep the review")
    .option("--run <id>", "The run whose station this is (default: $run_id): --rebase records its rebase on it, as Merge does, and the pull request and its head are recorded on it")
    .action(async (opts: { branch?: string; dir: string; base: string; title?: string; body: string; refresh?: boolean; rebase?: boolean; run?: string }) => {
      const { prStation, rebasePr, refreshPr } = await import("./workflow/prStation.js");
      if (!opts.refresh && !opts.rebase && !opts.branch) throw new Error("--branch is required unless --refresh or --rebase");
      const cwd = deps.realCwd();
      const runId = opts.run ?? process.env.run_id;
      // A new round on a head the reviewer said ship on keeps that ship, as the server holds it for the run's attempt.
      const proof = !opts.refresh && !opts.rebase ? await mergeProof(runId) : null;
      const r = opts.refresh ? refreshPr({ cwd, dir: opts.dir }) : opts.rebase ? await rebasePr({ cwd, dir: opts.dir, base: opts.base, runId: opts.run ?? "", post: (route, body) => deps.cliPost(route, body, { throwOnError: true }) }) : prStation({ cwd, ...opts, branch: opts.branch!, proof });
      if (!r.ok) {
        console.log(r.reason);
        // 4: someone else moved origin's branch, so the run starts a new round at PR.
        process.exit(r.new_round ? 4 : 1);
      }
      const repository = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(r.pr.url)?.[1];
      if (runId && repository) await recordRunPr(deps, { run_id: runId, repository, number: r.pr.number, head_sha: r.pr.head_sha });
      console.log(JSON.stringify(r.pr));
    });

  // The same report from a repository's own PR station script, one that opens its pull request without `cast flow pr`.
  flow
    .command("record-pr")
    .description("From a PR station's script: record the pull request it opened or updated, and the head it pushed, on the run. A report that fails is printed and exits 0, so it never fails the station")
    .requiredOption("--number <n>", "The pull request's number")
    .requiredOption("--head <sha>", "The head the station pushed")
    .option("--repository <owner/name>", "The pull request's repository (default: this checkout's origin)")
    .option("--run <id>", "The run whose station this is (default: $run_id)")
    .action(async (opts: { number: string; head: string; repository?: string; run?: string }) => {
      const repository = opts.repository ?? (await import("./prCommand.js")).readLocalGitContext(deps.realCwd()).repository;
      await recordRunPr(deps, { run_id: opts.run ?? process.env.run_id, repository, number: Number(opts.number), head_sha: opts.head });
    });

  // And its rebases: a review of the head before covers the head after only once the run holds the link (orgLineMerge.coveredHeads).
  flow
    .command("record-rebase")
    .description("From a station's script: record that it rebased the pull request's head from one commit to another, before it pushes the rebase, so the review of the first covers the second. A report that fails is printed and exits 0, so it never fails the station")
    .requiredOption("--from <sha>", "The head before the rebase")
    .requiredOption("--to <sha>", "The rebased head it is about to push")
    .option("--run <id>", "The run whose station this is (default: $run_id)")
    .action(async (opts: { from: string; to: string; run?: string }) => {
      await reportToRun(deps, "the rebase", "/cli/workflow-runs/rebase", { run_id: opts.run ?? process.env.run_id, from: opts.from, to: opts.to });
    });

  // The change flow's Wait for main station (workflow/waitMain.ts): run by a parked station.
  flow
    .command("wait-main")
    .description("Wait until the default branch's own CI is green at its head; exits 1, naming main's red jobs, when the deadline passes first")
    .option("--base <name>", "The default branch", "main")
    .option("--deadline <duration>", "How long to wait (30m, 4h)", "4h")
    .option("--interval <seconds>", "How often to look again", "60")
    .option("--run <id>", "The run whose station this is: each new line goes on the station while it waits")
    .option("--node <id>", "That station's id in the run")
    .action(async (opts: { base: string; deadline: string; interval: string; run?: string; node?: string }) => {
      const [{ waitForMain }, { parseDuration }] = await Promise.all([import("./workflow/waitMain.js"), import("@codecast/shared/time")]);
      const r = await waitForMain({ cwd: deps.realCwd(), base: opts.base, deadlineMs: parseDuration(opts.deadline), intervalMs: Math.max(5, Number(opts.interval) || 60) * 1000, say: stationProgress(deps, opts.run, opts.node) });
      console.log(r.line);
      if (!r.ok) process.exit(1);
    });

  // The change flow's Verdicts station (workflow/changeVerdicts.ts): where a round's CI and review send the run.
  flow
    .command("verdicts")
    .description("Read this round's pr.json and ci.json in --dir and the reviewer's pinned verdict, and print where the change flow goes: {next: merge|brief|rejected|rerun_ci|rerun_review|no_ci|wait_main|decide, why, ci, review}; writes review.json only for a verdict it accepts")
    .requiredOption("--dir <path>", "The run's directory")
    .option("--review <json>", "The reviewer's pinned verdict, {verdict, findings, round}; it counts only with this round's nonce from pr.json")
    .option("--run <id>", "The run whose station this is (default: $run_id): a ship carried in pr.json counts only as the server holds it")
    .action(async (opts: { dir: string; review?: string; run?: string }) => {
      const [{ changeVerdicts }, { readPr }] = await Promise.all([import("./workflow/changeVerdicts.js"), import("./workflow/prStation.js")]);
      // Where origin's branch stands now: a push since this round's would make every verdict about another head.
      const branch = readPr(opts.dir)?.branch;
      const ls = branch ? spawnSync("git", ["ls-remote", "origin", `refs/heads/${branch}`], { cwd: deps.realCwd(), encoding: "utf-8" }) : null;
      const originHead = ls?.status === 0 ? String(ls.stdout).trim().split(/\s/)[0] || null : null;
      const proof = readPr(opts.dir)?.reviewed ? await mergeProof(opts.run ?? process.env.run_id) : null;
      console.log(JSON.stringify(changeVerdicts(opts.dir, opts.review, originHead, proof)));
    });

  flow
    .command("merge")
    .description("A change flow's Merge station: clears the merge on green CI of the PR's head and a ship review, rebases it onto the default branch, runs the before-merge deploy steps from the rebased tree, then squash-merges that head. Exits 0 merged (the last line is the sha on the default branch, merge.json written), 1 conflict, 2 refused, 3 retest")
    .requiredOption("--pr <number>", "The pull request")
    .requiredOption("--branch <name>", "The change's branch")
    .requiredOption("--dir <run_dir>", "The run's directory: ci.json and review.json are read from it, merge.json written to it")
    .option("--run <id>", "The run whose station this is (default: $run_id from the station's environment)")
    .action(async (opts: { pr: string; branch: string; dir: string; run?: string }) => {
      // bun exits 1 on an uncaught error, and the graph reads exit 1 as a conflict: a crash refuses instead.
      const crashed = (err: unknown) => { console.log(`station crashed: ${String(err instanceof Error ? `${err.name}: ${err.message}` : err).split("\n")[0]}`); process.exit(2); };
      process.on("uncaughtException", crashed);
      process.on("unhandledRejection", crashed);
      try {
        const { mergeCommand } = await import("./workflow/mergeStation.js");
        const post = (p: string, body: Record<string, unknown>) => deps.cliPost(p, body, { throwOnError: true, timeoutMs: 300_000 });
        process.exit(await mergeCommand({ ...opts, cwd: deps.realCwd(), post }));
      } catch (err) {
        crashed(err);
      }
    });

  flow
    .command("review-verdict")
    .description("From a change flow's reviewer session: record the verdict and the head it read on the run, which a merge's clearance needs. The session names itself from its environment; the server finds the run and reviewer station it runs as")
    .requiredOption("--verdict <verdict>", "ship, changes or rejected")
    .requiredOption("--head <sha>", "The pull request head the review read (40 hex characters)")
    .option("--round <id>", "The review round, as pr.json names it")
    .option("--run <id>", "The run, when this session reviews for more than one")
    .option("--node <id>", "The reviewer station's id, when the session runs more than one")
    .option("--mechanism <answer>", "true or false: whether the change is a mechanism (a mistake that reaches many people and cannot be undone). Left out, the review has not said, and an approval status waits on it")
    .action(async (opts: { verdict: string; head: string; round?: string; run?: string; node?: string; mechanism?: string }) => {
      if (opts.mechanism !== undefined && opts.mechanism !== "true" && opts.mechanism !== "false") { console.error("--mechanism is true or false"); process.exit(1); }
      const session = deps.callingSession();
      if (!session) { console.error("no session: the review verdict is recorded from inside the reviewer station's own session"); process.exit(1); }
      try {
        const r = await deps.cliPost("/cli/workflow-runs/review-verdict", {
          session_id: session, verdict: opts.verdict, head_sha: opts.head,
          ...(opts.round ? { round: opts.round } : {}), ...(opts.run ? { run_id: opts.run } : {}), ...(opts.node ? { node_id: opts.node } : {}),
          ...(opts.mechanism !== undefined ? { mechanism: opts.mechanism === "true" } : {}),
        }, { throwOnError: true });
        console.log(`recorded ${opts.verdict} on ${opts.head.slice(0, 10)} for ${r?.node_id ?? "the reviewer station"}`);
      } catch (err) {
        console.error(`the review verdict was not recorded: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
  return flow;
}
