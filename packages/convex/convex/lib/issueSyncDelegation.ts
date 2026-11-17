import { internal } from "../_generated/api";
import { inlineForeignText } from "@codecast/shared/contracts";
import { scheduleTriggerMatch } from "./triggerMatch";
import type { NormalizedIssue } from "./issueMapping";
import type { SourceDoc } from "../issueSync";

/* ---------------- Delegation, feed, triggers (S7, S8) ---------------- */

/**
 * The source's delegation convention (S7.3): a label or an assignee on the
 * provider side that means "an agent takes this". Guarded by the task having
 * no session yet, so the signal spawns once and re-firing events are inert.
 */
export async function maybeDelegate(ctx: any, source: SourceDoc | null, task: any, issue: NormalizedIssue) {
  if (!source?.auto_spawn) return;
  if ((task.conversation_ids ?? []).length > 0) return;

  const label = (source.delegate_label || "agent").toLowerCase();
  const byLabel = issue.labels.some((l) => l.toLowerCase() === label);
  const target = source.delegate_assignee?.toLowerCase();
  const byAssignee = !!target
    && [issue.assignee_login, issue.assignee_email, issue.assignee_label]
      .some((v) => typeof v === "string" && v.toLowerCase() === target);
  if (!byLabel && !byAssignee) return;

  await ctx.scheduler.runAfter(0, internal.tasks.spawnSessionForTaskInternal, {
    task_id: task._id,
    user_id: source.user_id,
    isolated: source.spawn_isolated !== false,
    target_device_id: source.spawn_device || undefined,
    definition: source.spawn_definition || undefined,
    // Why: this is the one spawn with no human in the loop — a labelled issue
    // launches an agent by itself — and identifier/url come from the provider,
    // so they are escaped before they lead the prompt (ct-49559).
    initial_message: `Picked up from ${inlineForeignText(issue.identifier)}: ${inlineForeignText(issue.url)}`,
  });
}

/** S8: one feed row per inbound event, deduped so retries do not stack. */
export async function recordFeedEvent(
  ctx: any,
  source: SourceDoc | null,
  task: any,
  issue: NormalizedIssue,
  kind: string | undefined,
  now: number,
) {
  const teamId = task.team_id ?? source?.team_id;
  if (!kind || !teamId) return;
  await ctx.scheduler.runAfter(0, internal.externalEvents.record, {
    team_id: teamId,
    source: issue.provider,
    repository: issue.repo,
    kind,
    actor_login: issue.actor,
    title: issue.title || issue.identifier,
    url: issue.url,
    issue: {
      provider: issue.provider,
      key: issue.identifier,
      url: issue.url,
      title: issue.title,
    },
    task_ids: [task._id],
    project_ids: task.project_id ? [task.project_id] : undefined,
    dedupe_key: `${issue.provider}:${issue.id}:${kind}:${issue.remote_updated_at || now}`,
  });
}

/**
 * Hand the event to armed triggers (S7). Two shapes, both scheduled: the
 * provider-native pair (`issues` + `opened`) that GitHub users already arm on,
 * and the CLI shorthand (`issue_opened`) that reads the same for Linear. The
 * repository is the repo name, or the Linear team key when there is none.
 */
export async function fireTriggers(
  ctx: any,
  source: SourceDoc | null,
  issue: NormalizedIssue,
  kind: string | undefined,
  githubAction: string | undefined,
  hasComment: boolean,
) {
  // A source that is gone has no workspace to keep the fan out inside: wake nobody.
  if (!source) return;
  const repository = issue.repo ?? issue.team_key ?? source.external_id;
  const eventType = hasComment ? "issue_comment" : "issues";
  const action = githubAction ?? linearActionFor(kind);
  // team_id keeps the fan out inside the source's team: event filters are
  // user chosen strings, and "issues" is one every team writes. The CLI
  // shorthands (issue_opened ...) are expanded to this provider pair before
  // they are stored, so this one call covers both spellings.
  await scheduleTriggerMatch(ctx, {
    event_type: eventType,
    action,
    repository,
    // A personal source has no team, and an event with neither a team nor a
    // workspace wakes every user's trigger: scope it to the source's own key.
    ...(source.team_id ? { team_id: source.team_id } : { workspace: source.workspace }),
  });
}

function linearActionFor(kind: string | undefined): string | undefined {
  switch (kind) {
    case "issue_opened": return "opened";
    case "issue_assigned": return "assigned";
    case "issue_labeled": return "labeled";
    case "issue_closed": return "closed";
    case "issue_reopened": return "reopened";
    case "issue_commented": return "created";
    default: return "edited";
  }
}

