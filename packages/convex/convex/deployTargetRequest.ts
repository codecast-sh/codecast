// Asking for a deploy of one target (docs/architecture/deploys.md DP13): the Deploy button, `cast deploy`, a role's
// release and dispatch all go through requestTargetDeployCore; deployTargets.ts holds the mutation.
import type { Doc, Id } from "./_generated/dataModel";
import { workspaceGrantsAccess } from "./lib/accessKeys";
import { nextShortId } from "./counters";
import { enqueueConfigCommand } from "./users";
import { DEPLOY_SHORT_ID_PREFIX, liveDeploys } from "@codecast/shared/contracts/deploys";
import { canRedeploySha, commitTouchesTarget, NOT_YOUR_MACHINE } from "@codecast/shared/contracts/deployTargets";
import { teamKey } from "./deployTargetsCi";
import { refuseWhilePaused } from "./deployPause";
import { kickDispatch, sendsThroughGithub } from "./deployDispatch";
import { COMMITS_MAX, commitBySha, deployCommitsOf, devPushOver, mainCommitsAfter, repositoryArg, targetDeploys, targetRows } from "./deployTargetsState";

/**
 * Ask for a deploy of one target: main's head (`deploy`), an earlier deploy's
 * sha again (`redeploy`, only for a command that takes `$sha`), or the
 * target's rollback command (`rollback`, back to the live deploy before the
 * current one, or the one named). The machine that published the target runs
 * it (`cast line deploy run dp-N`, the line-deploy graph), and the deploy ends
 * live or failed.
 */
export async function requestTargetDeployCore(
  ctx: any,
  userId: Id<"users">,
  args: { team_id: Id<"teams">; target: string; repository?: string; action?: "deploy" | "redeploy" | "rollback"; of?: string; sha?: string; here?: boolean; cli?: boolean; client_key?: string; request_id?: string; actor?: string; paused?: boolean },
): Promise<{ _id: string; short_id: string; target: string; action: string; sha: string | null; commits: number }> {
  const workspace = teamKey(args.team_id);
  if (!(await workspaceGrantsAccess(ctx, userId, workspace))) throw new Error("Not a member of that team");
  const name = args.target.trim().toLowerCase();
  const candidates = (await targetRows(ctx, workspace, args.repository ? repositoryArg(args.repository) : undefined)).filter((r) => r.name === name);
  if (!candidates.length) throw new Error(`No deploy target ${name}: declare it as a [[target]] in .codecast/deploy.toml and publish (cast line deploy targets --publish)`);
  if (candidates.length > 1) throw new Error(`More than one repository has a target ${name}; name the repository`);
  const t = candidates[0];
  const action = args.action ?? "deploy";
  if (t.runs === "push") throw new Error(`${name} deploys itself when main moves; there is nothing to send from here`);
  if (!t.command) throw new Error(`${name} names no command`);
  // A pause lets only a rollback through.
  if (action !== "rollback") await refuseWhilePaused(ctx, workspace, t.repository);
  // A target whose deploys run as a workflow is sent through codecast's GitHub app (DP18): a rollback always, any other
  // deploy when no machine publishes the target.
  const viaGithub = !args.here && sendsThroughGithub(t) && (action === "rollback" || !t.device_id || !t.root);
  if (!args.here && !viaGithub && (!t.device_id || !t.root)) throw new Error(`No machine publishes ${name}, so nothing can run it`);
  // Codecast's rollback pauses production first and names what ends it (deployRollback.rollbackCore, DP19).
  if (viaGithub && action === "rollback" && !args.paused) throw new Error(`A rollback of ${name} pauses production first: cast line deploy rollback --reason "<why>", or Roll back on the Deploys page`);
  const deploys = await targetDeploys(ctx, workspace, name);
  const open = deploys.find((d) => (d.status === "requested" || d.status === "running") && (!d.repository || d.repository === t.repository));
  // A rollback queues behind what is going out instead of being refused.
  if (open && !(viaGithub && action === "rollback")) throw new Error(`${open.short_id} is already going out to ${name} (${open.status}); wait for it to finish`);
  // What a deploy goes on from, a rollback goes back from, and "already live" means: the deploy that went live last.
  const lives = liveDeploys(deploys, { repository: t.repository });
  const live = lives[0];
  let sha: string | undefined;
  let rollbackOf: string | undefined;
  if (args.sha !== undefined && action !== "deploy") throw new Error(`A ${action} sends the sha of the deploy it names (of); sha names the commit of a deploy`);
  if (action !== "deploy") {
    const of = args.of
      ? deploys.find((d) => d.short_id === args.of!.toLowerCase())
      : lives.find((d) => d._id !== live?._id && d.sha && d.sha !== live?.sha);
    if (!of?.sha) throw new Error(args.of ? `No deploy ${args.of} of ${name} with a sha` : `No earlier live deploy of ${name} to go back to`);
    if (action === "redeploy" && !canRedeploySha(t)) throw new Error(`${name}'s command sends the tree it runs in, not a sha: it cannot redeploy ${of.short_id}${t.rollback ? "; use its rollback" : ""}`);
    if (action === "rollback" && !viaGithub && !t.rollback) throw new Error(`${name} names no rollback command`);
    if (action === "rollback" && viaGithub && !t.rollback_inputs) throw new Error(`${name} names no rollback_inputs: a rollback dispatches ${t.workflow} with them (.codecast/deploy.toml)`);
    sha = of.sha;
    rollbackOf = of.short_id;
  }
  // A deploy may name the commit it makes live (`cast deploy --sha`): a commit on the default branch, after the live
  // one. Without it the deploy sends main's head, fixed when its first step runs.
  if (args.sha !== undefined) {
    const named = args.sha.trim().toLowerCase();
    const commit = /^[0-9a-f]{7,40}$/.test(named) ? await commitBySha(ctx, t.repository, named) : null;
    if (commit?.main_at == null) throw new Error(`${args.sha} is not a commit on ${t.repository}'s default branch as codecast has read it: push it to the default branch (a push GitHub has not reported yet is read within a minute)`);
    // The live sha is already live only when prod runs its committed tree: a dirty deploy, or a dev push on top of it
    // (what the targets view shows as dev_push), runs someone's working tree, and deploying the sha puts the commit back.
    if (live?.sha && commit.sha === live.sha && !live.dirty && !(await devPushOver(ctx, t, live))) throw new Error(`${commit.sha.slice(0, 10)} is already live on ${name}`);
    const liveAt = live?.sha ? (await commitBySha(ctx, t.repository, live.sha))?.main_at ?? null : null;
    if (liveAt != null && commit.main_at < liveAt) throw new Error(`${commit.sha.slice(0, 10)} is older than what is live on ${name} (${live!.sha!.slice(0, 10)}): a rollback puts an earlier deploy back (action rollback)`);
    // A command that sends the tree it runs in (no $sha) ships main's head, so only that commit can be pinned.
    if (!canRedeploySha(t)) {
      const head = (await mainCommitsAfter(ctx, t.repository, commit.sha)).commits.at(-1);
      if (head && head.sha !== commit.sha) throw new Error(`${name}'s command sends the tree it runs in, not a sha, so it ships main's head (${head.sha.slice(0, 10)}), not ${commit.sha.slice(0, 10)}: deploy main's head, or give ${name} a command that takes $sha`);
    }
    sha = commit.sha;
  }
  // What it will send: the commits on main after the live sha that touch the target, up to the sha it makes live.
  let commits: Doc<"deploys">["commits"] & {} = [];
  if (action === "deploy") {
    const after = await mainCommitsAfter(ctx, t.repository, live?.sha ?? null, sha ?? null);
    commits = await deployCommitsOf(ctx, after.commits
      .filter((c) => commitTouchesTarget(t, (c.files ?? []).map((f) => f.filename)))
      .reverse()
      .slice(0, COMMITS_MAX));
  }
  const now = Date.now();
  const user = await ctx.db.get(userId);
  const by = user?.name ?? user?.github_username ?? user?.email ?? "someone";
  // Codecast sends an exact commit: main's head as it has read it, when the deploy names none.
  if (viaGithub && !sha) {
    sha = (await mainCommitsAfter(ctx, t.repository, live?.sha ?? null)).commits.at(-1)?.sha;
    if (!sha) throw new Error(`Nothing on ${t.repository}'s default branch after what is live on ${name}`);
  }
  const dispatch = viaGithub
    ? { state: "queued" as const, at: now, inputs: { sha: sha!, actor: args.actor ?? by.split(/\s+/)[0], ...(action === "rollback" ? t.rollback_inputs : {}) } }
    : undefined;
  const shortId = await nextShortId(ctx.db, DEPLOY_SHORT_ID_PREFIX);
  const id = await ctx.db.insert("deploys", {
    short_id: shortId,
    ...(args.client_key ? { client_key: args.client_key } : {}),
    workspace,
    team_id: args.team_id,
    target: name,
    status: "requested",
    trigger: "person",
    started_by: { kind: args.cli ? "cli" : "person", name: by, user_id: userId },
    source: "codecast",
    event_ids: [],
    repository: t.repository,
    ...(sha ? { sha } : {}),
    ...(live?.sha ? { previous_sha: live.sha } : {}),
    ...(commits.length ? { commits } : {}),
    carries: [],
    action,
    ...(rollbackOf ? { rollback_of: rollbackOf } : {}),
    ...(dispatch ? { dispatch } : {}),
    created_at: now,
    updated_at: now,
  });
  if (viaGithub) await kickDispatch(ctx, workspace, name);
  else if (!args.here) {
    try {
      await enqueueConfigCommand(ctx, userId, "line_deploy", JSON.stringify({ deploy: shortId, root: t.root }), t.device_id, args.request_id);
    } catch (err) {
      throw new Error(`${name} runs on the machine that published it, ${NOT_YOUR_MACHINE}: ask its owner, or run \`cast line deploy --target ${name} --go\` there (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { _id: String(id), short_id: shortId, target: name, action, sha: sha ?? null, commits: commits.length };
}
