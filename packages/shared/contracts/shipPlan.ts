// One Ship control (docs/architecture/ship.md): what pressing Ship on a task,
// a session or a pull request will do, resolved from the facts the server and
// the store both hold. The popover renders the plan, the server starts it, and
// the CLI prints it, so all three say the same thing. Pure; no runtime deps.

export type ShipTargetKind = "task" | "conversation" | "pull_request";
export type ShipTarget = { kind: ShipTargetKind; id: string };
export type MergeMethod = "squash" | "merge" | "rebase";

/** The line profile's say over shipping (line-profile.md LP4, `[line.merge]`). */
export type ShipProfileFacts = {
  check: string | null;
  ship: string | null;
  merge: { auto: boolean; method: MergeMethod };
};

export type ShipPrFacts = {
  repository: string;
  number: number;
  state: string;
  head_ref?: string | null;
  base_ref?: string | null;
};

export type ShipFacts = {
  target: ShipTarget;
  /** How the target reads to a person: "ct-42 Fix the login race", "session jx7abcd", "owner/repo#12". */
  label: string;
  repository: string | null;
  /** The branch the change sits on, when known. */
  branch: string | null;
  /** The branch it lands in. */
  base: string;
  /** The checkout the ship session starts in. */
  projectPath: string | null;
  taskShortId: string | null;
  /** The published line profile, or null when the project has none. */
  profile: ShipProfileFacts | null;
  /** The pull request already open (or closed, or merged) from this branch. */
  pr: ShipPrFacts | null;
  /** A line run parked at its change card for this task: Ship answers the card. */
  lineGate: { decisionId: string } | null;
  /** The session whose changes ship, when the target names one. */
  sessionShortId: string | null;
};

export type ShipProcedure = "line_gate" | "profile_command" | "cast_ship";

export type ShipPlan = {
  procedure: ShipProcedure;
  target: ShipTarget;
  label: string;
  /** The change card a line_gate press answers. */
  decisionId: string | null;
  branch: string | null;
  /** The change sits on the base branch: the ship session moves it to `branch` first. */
  newBranch: boolean;
  base: string;
  checks: string[];
  command: string | null;
  pr: { action: "open" } | { action: "shepherd"; repository: string; number: number };
  merge: { will: boolean; method: MergeMethod; why: string };
  /** What pressing Ship does, in order, one sentence each. */
  steps: string[];
  /** Why it cannot start, or null. */
  blocked: string | null;
};

/** The line's default check when a project has no profile (line-profile.md LP2). */
export const SHIP_DEFAULT_CHECK = "cast ws check";
export const SHIP_DEFAULT_MERGE: ShipProfileFacts["merge"] = { auto: false, method: "squash" };

const prRef = (pr: { repository: string; number: number }) => `${pr.repository}#${pr.number}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** The branch a change on the base branch moves to: named after what ships. */
export function shipBranchName(facts: Pick<ShipFacts, "taskShortId" | "sessionShortId" | "target">): string {
  return `ship/${slug(facts.taskShortId ?? facts.sessionShortId ?? facts.target.id.slice(0, 7))}`;
}

export function resolveShipPlan(facts: ShipFacts): ShipPlan {
  const profile = facts.profile;
  const method = profile?.merge.method ?? SHIP_DEFAULT_MERGE.method;
  const pressedOnPr = facts.target.kind === "pull_request";
  const base = facts.pr?.base_ref || facts.base;
  const known = facts.pr?.head_ref || facts.branch;
  const newBranch = !facts.pr && (!known || known === base);
  const branch = facts.pr?.head_ref || (newBranch ? shipBranchName(facts) : known);
  const checks = [profile?.check || SHIP_DEFAULT_CHECK];
  const command = profile?.ship ?? null;

  if (facts.lineGate) {
    const merges = !command;
    return {
      procedure: "line_gate", target: facts.target, label: facts.label, decisionId: facts.lineGate.decisionId, branch, newBranch: false, base, checks, command,
      pr: facts.pr ? { action: "shepherd", repository: facts.pr.repository, number: facts.pr.number } : { action: "open" },
      merge: {
        will: merges,
        method,
        why: merges
          ? `The project has no ship command, so the line's merge step lands ${branch ?? "the branch"} in ${base}.`
          : "The project's ship command decides how the change lands.",
      },
      steps: [
        `Answers Ship on the change card ${facts.taskShortId ? `for ${facts.taskShortId} ` : ""}waiting on you.`,
        command
          ? `The line's ship station runs \`${command}\` and posts what it printed on the task.`
          : `The line's merge step merges ${branch ?? "the run's branch"} into ${base}.`,
        "The task enters watch for the profile's watch days.",
      ],
      blocked: null,
    };
  }

  const blocked = facts.pr?.state === "merged"
    ? `${prRef(facts.pr)} is already merged.`
    : facts.pr?.state === "closed"
      ? `${prRef(facts.pr)} is closed. Reopen it on GitHub first.`
      : !facts.projectPath
        ? "No checkout is known for this work, so there is nowhere to ship from."
        : null;

  const will = pressedOnPr || !!profile?.merge.auto;
  const why = pressedOnPr
    ? "Ship on a pull request's page merges it once its checks pass. From a task or a session it would stop at the open pull request."
    : profile?.merge.auto
      ? "The project's line profile sets merge.auto, so it merges once its checks pass."
      : command
        ? "The command decides how the change lands; Ship adds no merge of its own."
      : "The pull request stays open and shepherded. Only Ship on the pull request's page merges, unless the line profile sets merge.auto.";

  const home = facts.projectPath ? facts.projectPath.replace(/^\/(Users|home)\/[^/]+/, "~") : "the checkout";
  const steps: string[] = [`Starts a ship session in ${home}${facts.sessionShortId ? `, working from session ${facts.sessionShortId}'s changes` : ""}.`];
  if (newBranch) steps.push(`Moves the changes on ${base} to a new branch ${branch}, leaving other work in the checkout alone.`);
  steps.push(`Runs ${checks.map((c) => `\`${c}\``).join(" and ")}; a red check stops it and names the failure.`);
  if (command) steps.push(`Runs the project's ship command \`${command}\` and reports the line it prints.`);
  else if (facts.pr) steps.push(`Pushes to ${branch} and shepherds ${prRef(facts.pr)}: reviews, failing checks and conflicts wake it.`);
  else steps.push(`Commits the changes in topical pieces, pushes ${branch} and opens a pull request into ${base}, then shepherds it.`);
  if (will) steps.push(`Merges with ${method} once the checks are green.`);

  return {
    procedure: command ? "profile_command" : "cast_ship",
    target: facts.target, label: facts.label, decisionId: null, branch, newBranch, base, checks, command,
    pr: facts.pr ? { action: "shepherd", repository: facts.pr.repository, number: facts.pr.number } : { action: "open" },
    merge: { will, method, why },
    steps,
    blocked,
  };
}

/** The first turn of the ship session: everything it needs, nothing it must look up to start. */
export function shipBrief(plan: ShipPlan, facts: Pick<ShipFacts, "projectPath" | "taskShortId" | "sessionShortId" | "repository">): string {
  const lines: string[] = [
    `# Ship ${plan.label}`,
    "",
    "You are a ship worker. Land this one change the way the plan below says, report each step with `cast state`, and stop. Do not change the code beyond what shipping needs; a real fix belongs to the session that wrote it.",
    "",
    `- Checkout: ${facts.projectPath ?? "(unknown)"}`,
    `- Branch: ${plan.branch}${plan.newBranch ? ` (new; the change is on ${plan.base} now)` : ""}, landing in ${plan.base}`,
  ];
  if (facts.repository) lines.push(`- Repository: ${facts.repository}`);
  if (facts.taskShortId) lines.push(`- Task: ${facts.taskShortId} (comment the PR link and the outcome on it)`);
  if (facts.sessionShortId) lines.push(`- Changes from session ${facts.sessionShortId} (\`cast diff ${facts.sessionShortId}\` lists its files; ship only those)`);
  if (plan.pr.action === "shepherd") lines.push(`- Pull request: ${plan.pr.repository}#${plan.pr.number}, already open`);
  lines.push("", "## Steps", "");
  let n = 1;
  if (plan.newBranch) lines.push(`${n++}. Create ${plan.branch} from ${plan.base} in a worktree (\`git worktree add\`), carry over only the files this work changed, and commit them there. Never stash, reset or discard other sessions' changes in the checkout.`);
  lines.push(`${n++}. \`cast state --status working "Checks running"\`, then run ${plan.checks.map((c) => `\`${c}\``).join(" and ")}. If one fails: \`cast state --status blocked "Failed: <the failing check and its first error>"\` and stop.`);
  if (plan.command) {
    lines.push(`${n++}. Run the project's ship command from the branch's checkout with task_id, branch and default_branch in its environment: \`${plan.command}\`. Its last line says what is true now; pin it with \`cast state\`.`);
  } else if (plan.pr.action === "open") {
    lines.push(`${n++}. Follow the cast-ship skill: commit in topical pieces, push ${plan.branch}, open the pull request into ${plan.base} with \`gh pr create\`, then \`cast pr shepherd on\`. Pin \`cast state "PR opened: <url>"\`.`);
  } else {
    lines.push(`${n++}. Push any commits to ${plan.branch}, then \`cast pr shepherd on ${plan.pr.repository}#${plan.pr.number}\`. Pin \`cast state "Shepherding ${plan.pr.repository}#${plan.pr.number}"\`.`);
  }
  if (plan.merge.will) {
    lines.push(`${n++}. When its checks are green, \`cast pr merge --${plan.merge.method}\`, then \`cast state --status done "Merged"\`. ${plan.merge.why}`);
  } else {
    lines.push(`${n++}. Do not merge. ${plan.merge.why} Pin \`cast state --status done "PR opened: <url>, waiting on review"\`.`);
  }
  return lines.join("\n");
}

// ── Progress: what the ship session's row says, folded for the control ──

export type ShipPhase = "starting" | "working" | "checks" | "pr_open" | "merged" | "failed" | "done";

export type ShipProgressInput = {
  session: {
    agent_status?: string | null;
    thread_state?: string | null;
    thread_state_status?: string | null;
    pr_status?: { repository: string; number: number; state: string } | null;
    status?: string | null;
  } | null;
  pr?: { state?: string | null; checks?: Array<{ name: string; status: string; conclusion?: string | null }> | null } | null;
};

export type ShipProgress = { phase: ShipPhase; text: string; pr: { repository: string; number: number } | null };

const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

export function shipProgress({ session, pr }: ShipProgressInput): ShipProgress {
  if (!session) return { phase: "starting", text: "Starting the ship session", pr: null };
  const ref = session.pr_status ? { repository: session.pr_status.repository, number: session.pr_status.number } : null;
  const prState = pr?.state ?? session.pr_status?.state ?? null;
  const state = (session.thread_state ?? "").trim();
  if (prState === "merged") return { phase: "merged", text: "Merged", pr: ref };
  const failing = (pr?.checks ?? []).find((c) => c.conclusion && FAILED.has(c.conclusion));
  if (failing) return { phase: "failed", text: `Failed: ${failing.name}`, pr: ref };
  if (session.thread_state_status === "blocked") return { phase: "failed", text: state || "Blocked", pr: ref };
  if (ref) {
    const running = (pr?.checks ?? []).some((c) => c.status !== "completed");
    return { phase: running ? "checks" : "pr_open", text: running ? "PR open, checks running" : (state || "PR open"), pr: ref };
  }
  if (session.thread_state_status === "done") return { phase: "done", text: state || "Done", pr: ref };
  if (/^checks running/i.test(state)) return { phase: "checks", text: state, pr: null };
  return { phase: "working", text: state || "Working", pr: null };
}
