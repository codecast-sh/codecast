// Who else a metric watch's alert reaches (contracts/metricMonitor
// AlertNotify), beside its route (a problem task or the timeline, which the
// group upsert decides). The poll (metrics.recordPoint) calls this on a
// crossing, on a still-running alert whose renotify interval has passed, and
// on a recovery. Each target gets the same one line (alertLine):
//   people  a bell row and a phone push that opens the watch;
//   roles   a line into the role's standing session (tellRole);
//   channel a chat line, the crossing as the root and every later line of
//           the episode a reply in its thread, spoken by the team's agent
//           when it has one;
//   fix     on a crossing, a fix session started as the person who set the
//           routes, in the source's project, bound to the problem task and
//           recorded on the issue, once per episode and at most a few an hour.
// Every delivery, and every one that could not go out with the reason, is kept
// on the watch (deliveries) so its page shows what the alert did.
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { emitNotification } from "./notificationRouter";
import { postChatMessage } from "./chat";
import { tellRole } from "./pendingMessages";
import { spawnSessionCore } from "./spawn";
import { addConversationToWorkItem } from "./conversationLinks";
import { workspaceGrantsAccess } from "./lib/access";
import { takeFromWindow } from "./ipRateLimit";
import { alertLine, appendDeliveries, type AlertDelivery, type AlertDeliveryKind } from "@codecast/shared/contracts/metricMonitor";

const HOUR_MS = 3600_000;
/** Fix sessions an alert may start on its own, per workspace per hour. */
const AUTO_FIX_PER_HOUR = 3;

export type AlertEvent = { kind: AlertDeliveryKind; value: number | null; at: number; group_id: Id<"event_groups"> | null; noData?: boolean };

/** The workspace a role or channel lives in, as a workspace key. */
const roleWorkspace = (role: Doc<"org_roles">) => (role.team_id ? `team:${role.team_id}` : `user:${role.scope_user_id}`);

export async function deliverWatchAlert(ctx: MutationCtx, watch: Doc<"metric_watches">, source: Doc<"event_sources">, e: AlertEvent): Promise<void> {
  const n = watch.notify;
  const episode = watch.alert_episode;
  if (e.kind === "recovered") {
    // The episode ends whether or not anyone hears of it.
    if (episode) await ctx.db.patch(watch._id, { alert_episode: undefined });
    if (!n?.recovery || watch.threshold === undefined) return;
  }
  if (!n || watch.threshold === undefined) return;
  const now = Date.now();
  const since = e.kind === "crossed" ? e.at : episode?.at;
  const text = alertLine({ short_id: watch.short_id, name: watch.name, unit: watch.unit, threshold: watch.threshold, direction: watch.direction }, { kind: e.kind, value: e.value, since, now, noData: e.noData });
  const link = `/ops/metrics/${watch.short_id}`;
  const group = e.group_id ? await ctx.db.get(e.group_id) : null;
  const out: AlertDelivery[] = [];
  const at = e.at;

  // People: one bell row each (and a push), to those who can still read the workspace.
  if (n.users?.length) {
    const allowed: Id<"users">[] = [];
    for (const uid of n.users) {
      const u = await ctx.db.get(uid);
      const name = u ? `@${(u as any).github_username || (u as any).name || "someone"}` : "@removed";
      if (u && (await workspaceGrantsAccess(ctx, uid, watch.workspace))) {
        allowed.push(uid);
        out.push({ at, kind: e.kind, to: name, ok: true });
      } else out.push({ at, kind: e.kind, to: name, ok: false, note: "not in this workspace" });
    }
    if (allowed.length) {
      await emitNotification(ctx, {
        event_type: "metric_alert",
        entity_type: "metric_watch",
        entity_id: watch.short_id,
        link,
        message: text,
        actor_name: source.name,
        recipient_ids: allowed,
        push_subtitle: source.name,
      } as any);
    }
  }

  // Roles: a plain line into each role's standing session.
  for (const roleId of n.roles ?? []) {
    const role = await ctx.db.get(roleId);
    if (!role || roleWorkspace(role) !== watch.workspace) {
      out.push({ at, kind: e.kind, to: role ? `@${role.handle}` : "@removed role", ok: false, note: role ? "role is in another workspace" : "role removed" });
      continue;
    }
    const body = [
      text,
      `Watch: ${link}${group ? ` · issue ${group.short_id}` : ""}`,
      e.kind === "crossed" ? `Read it with \`cast metrics show ${watch.short_id}\`${group ? ` and \`cast events show ${group.short_id}\`` : ""}.` : null,
    ].filter(Boolean).join("\n");
    const row = await tellRole(ctx, roleId, { content: body, client_id: `metric-alert:${watch._id}:${e.kind}:${at}:${roleId}`, from_user_id: n.by });
    out.push({ at, kind: e.kind, to: `@${role.handle}`, ok: !!row, ...(row ? {} : { note: "role has no running session" }) });
  }

  // Channel: the crossing is the thread's root, every later line of the episode replies in it.
  let threadRoot = e.kind === "crossed" ? undefined : episode?.thread_root;
  if (n.channel) {
    const channel = await ctx.db.get(n.channel);
    if (!channel || channel.archived_at || `team:${channel.team_id}` !== watch.workspace) {
      out.push({ at, kind: e.kind, to: channel ? `#${channel.name}` : "#removed", ok: false, note: !channel ? "channel removed" : channel.archived_at ? "channel archived" : "channel is in another team" });
    } else {
      const anchor = await ctx.db.query("anchors").withIndex("by_team", (q) => q.eq("team_id", channel.team_id)).filter((q) => q.and(q.eq(q.field("scope_type"), "team"), q.eq(q.field("status"), "active"))).first();
      const root = threadRoot ? await ctx.db.get(threadRoot) : null;
      const posted = await postChatMessage(ctx, {
        channel,
        root: root && String(root.channel_id) === String(channel._id) ? root : null,
        authorId: anchor?.bot_user_id ?? n.by,
        content: `${text} · ${link}`,
        attachments: [],
        ...(anchor ? { agent: { anchorId: anchor._id } } : { origin: "agent" as const }),
      });
      if (!root) threadRoot = posted.messageId;
      out.push({ at, kind: e.kind, to: `#${channel.name}`, ok: true, href: `/chat/${channel._id}?m=${posted.messageId}` });
    }
  }

  // Fix: on a crossing with an issue and no fix already on it this episode.
  if (n.fix && e.kind === "crossed") out.push(await startFix(ctx, watch, source, group, at));

  await ctx.db.patch(watch._id, {
    deliveries: appendDeliveries(watch.deliveries, out),
    ...(e.kind === "recovered" ? {} : { alert_episode: { at: since ?? at, notified_at: now, ...(threadRoot ? { thread_root: threadRoot } : {}) } }),
  });
}

async function startFix(ctx: MutationCtx, watch: Doc<"metric_watches">, source: Doc<"event_sources">, group: Doc<"event_groups"> | null, at: number): Promise<AlertDelivery> {
  const no = (note: string): AlertDelivery => ({ at, kind: "crossed", to: "fix session", ok: false, note });
  const by = watch.notify!.by;
  if (!group) return no("no issue to fix");
  if (group.fix_conversation_id && (group.fix_started_at ?? 0) >= (group.last_transition_at ?? 0) - HOUR_MS) return { at, kind: "crossed", to: "fix session", ok: true, href: `/conversation/${group.fix_conversation_id}`, note: "already running" };
  if (!(await workspaceGrantsAccess(ctx, by, watch.workspace))) return no("its owner left the workspace");
  const project = source.project_id ? await ctx.db.get(source.project_id) : null;
  const path = project?.project_path;
  if (!path) return no(`${source.name} has no project folder`);
  const { granted } = await takeFromWindow(ctx.db, `metric-autofix:${watch.workspace}`, AUTO_FIX_PER_HOUR, HOUR_MS, 1);
  if (!granted) return no(`over ${AUTO_FIX_PER_HOUR} automatic fixes an hour`);
  const task = group.signal_task_id ? await ctx.db.get(group.signal_task_id) : null;
  const prompt = [
    `Investigate and fix metric watch ${watch.short_id} (${watch.name}), which crossed its line: ${watch.direction} ${watch.threshold}${watch.unit ? ` ${watch.unit}` : ""}.`,
    "",
    `Read it with \`cast metrics show ${watch.short_id}\` and the issue with \`cast events show ${group.short_id}\`${task?.short_id ? `; the problem task is ${task.short_id}` : ""}.`,
    "Find what moved it (recent deploys and changes in this project), reproduce the cause with a failing test where it is code, fix it, and show the test passing.",
  ].join("\n");
  const { conversationId, shortId } = await spawnSessionCore(ctx, by, { projectPath: path, gitRoot: path, prompt, title: `Fix ${watch.short_id} ${watch.name}`.slice(0, 80) });
  const now = Date.now();
  await ctx.db.patch(group._id, { fix_conversation_id: conversationId, fix_started_at: now, updated_at: now });
  if (task) await addConversationToWorkItem(ctx, by, "task", task as any, conversationId);
  return { at, kind: "crossed", to: `fix ${shortId}`, ok: true, href: `/conversation/${conversationId}` };
}
