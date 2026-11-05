// The group write every feed goes through (external-data.md X3, X4, X6): the
// tally that holds a busy group's numbers between row writes, the upsert for
// occurrences and the mirror for vendor groups, the samples kept per group,
// and the three effects of a transition (timeline row, triggers, promotion).
// ingest.ts keeps the registered functions that call these.
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { scheduleTriggerMatch } from "./triggerMatch";
import { nextShortId } from "../counters";
import { recordExternalEventOnce } from "../externalEvents";
import { linkReplayToGroup } from "../replays";
import { takeFromWindow } from "../ipRateLimit";
import { schedulePromotion } from "../ingestPromotions";
import { patchSourceStats } from "./sourceStats";
import { clusterPeople } from "./groupPeople";
import { GROUP_RULES, INGEST_SHORT_ID_PREFIX, transitionSignalKind, transitionTriggerEvent, type GroupKind, type Transition } from "@codecast/shared/contracts/ingest";
import { groupFingerprint } from "@codecast/shared/contracts/signalFingerprint";
import {
  HOUR_MS,
  SAMPLES_PER_BATCH,
  SAMPLE_TRIM_LOOKAHEAD,
  applyMirror,
  foldOccurrences,
  openGroupsDelta,
  samplePins,
  samplesToTrim,
  tallyMessages,
  type GroupState,
  type ItemPlan,
  type MirrorSnapshot,
} from "./ingestGroups";

export type GroupPlan = Extract<ItemPlan, { type: "group" }>;

/**
 * What one source may cost per hour, whoever holds its key (X2). The browser
 * SDK ships its key in a page, so these bound what a scraped key can do: past
 * the group caps a batch's new fingerprints fold into the source's overflow
 * group of their kind, and past the others the extra promotions and deploy
 * markers are skipped. Each is a fixed window (ipRateLimit.takeFromWindow).
 */
export const SOURCE_CAPS = {
  new_groups_per_hour: 200,
  open_groups_max: 1000,
  promotions_per_hour: 30,
  deploys_per_hour: 30,
} as const;

/** The fingerprint new groups past the caps fold into, one per kind. */
export const OVERFLOW_FP = "(overflow)";

/**
 * How long a group row goes unwritten while occurrences keep coming without a
 * transition. Inside it they land on the group's tally (event_group_tallies),
 * so the issues list, which subscribes to the group rows, re-runs at most
 * this often per busy group rather than on every batch.
 */
export const GROUP_WRITE_EVERY_MS = 60_000;

/** The group fields a tally may hold ahead of the row: counts and names, never a status a person sets. */
export const TALLY_FIELDS = ["count", "last_seen", "buckets", "days", "last_release", "title", "culprit", "level", "meta", "sample_count", "last_sha", "users", "users_since", "messages"] as const;

export function stateOf(row: Doc<"event_groups">): GroupState {
  return {
    kind: row.kind,
    status: row.status,
    count: row.count,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    buckets: row.buckets,
    days: row.days,
    first_release: row.first_release,
    last_release: row.last_release,
    resolved_at: row.resolved_at,
    resolved_in: row.resolved_in,
    resolved_via: row.resolved_via,
    resolved_by: row.resolved_by,
    regressed_at: row.regressed_at,
    regressed_in: row.regressed_in,
    failed_at: row.failed_at,
    last_transition: row.last_transition,
    last_transition_at: row.last_transition_at,
    meta: row.meta ? { ok: row.meta.ok } : undefined,
  };
}

export async function findGroup(ctx: any, sourceId: Id<"event_sources">, fingerprint: string): Promise<Doc<"event_groups"> | null> {
  return await ctx.db.query("event_groups").withIndex("by_source_fingerprint", (q: any) => q.eq("source_id", sourceId).eq("fingerprint", fingerprint)).first();
}

export async function tallyOf(ctx: any, groupId: Id<"event_groups">): Promise<Doc<"event_group_tallies"> | null> {
  return await ctx.db.query("event_group_tallies").withIndex("by_group", (q: any) => q.eq("group_id", groupId)).first();
}

/** A tally's held fields as JSON. A cleared field rides as null, since JSON drops undefined. */
export function tallyJson(fields: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(TALLY_FIELDS.map((k) => [k, fields[k] ?? null])));
}

export function tallyFields(json: string): Partial<Doc<"event_groups">> {
  return Object.fromEntries(Object.entries(JSON.parse(json)).map(([k, value]) => [k, value ?? undefined]));
}

/** A group with what its tally holds ahead of the row: the live numbers, for a reader that shows one group. */
export async function withTally(ctx: any, row: Doc<"event_groups">): Promise<Doc<"event_groups">> {
  const tally = await tallyOf(ctx, row._id);
  return tally ? { ...row, ...tallyFields(tally.fields_json) } : row;
}

/**
 * One group's occurrences from one source folded into its row, with the
 * samples and every transition announced. The one upsert every feed goes
 * through: the door's batches and the polled adapters (metric watches) alike,
 * so a group behaves the same whichever way its facts arrive. `plans` share a
 * fingerprint. The caller moves the source's groups_open by `open_delta`.
 * `found` is the stored row when the caller already looked it up. A deploy's
 * `sha` for the envelope's release is stamped as the group's last_sha (X3),
 * the join from an error to the commit that shipped it.
 */
export async function upsertGroup(
  ctx: any,
  source: Doc<"event_sources">,
  plans: GroupPlan[],
  envelope: { release?: string; environment?: string; sha?: string },
  now: number,
  found?: Doc<"event_groups"> | null,
  link?: EventLink,
): Promise<{ group_id: Id<"event_groups">; short_id: string; open_delta: number; transitions: number }> {
  const plan = plans[0];
  const stored = found !== undefined ? found : await findGroup(ctx, source._id, plan.fingerprint);
  const tally = stored ? await tallyOf(ctx, stored._id) : null;
  const existing: Doc<"event_groups"> | null = stored && tally ? { ...stored, ...tallyFields(tally.fields_json) } : stored;
  const folded = foldOccurrences(existing ? stateOf(existing) : null, plans.map((p) => p.occurrence), now);
  const next = folded.next!;
  // The newest occurrence names the group: a title that drifts with the
  // message (a clipped stack, a new culprit) follows what is happening now.
  const newest = plans.reduce((a, b) => (b.occurrence.at >= a.occurrence.at ? b : a));
  const meta = next.meta || newest.meta ? { ...existing?.meta, ...newest.meta, ...next.meta } : existing?.meta;
  const keep = samplesToKeep(plans);
  const people = await newGroupUsers(ctx, stored?._id ?? null, plans);
  // Samples a group held before sample_count existed are counted once, here.
  const priorSamples = existing ? existing.sample_count ?? (await countSamples(ctx, existing._id)) : 0;
  const fields: Record<string, unknown> = {
    ...next,
    title: newest.title,
    culprit: newest.culprit ?? existing?.culprit,
    level: newest.level ?? existing?.level,
    meta: meta as Doc<"event_groups">["meta"],
    sample_count: Math.min(priorSamples + keep.length, GROUP_RULES.samples_per_group),
    // A release with no known deploy sha clears the last one: it named another build.
    last_sha: envelope.release ? envelope.sha : existing?.last_sha,
    ...usersFields(existing, people.added, now),
    // One job name holds many causes: each failure counts under what it said, so the page splits them by count, not by the kept samples.
    ...(next.kind === "job" ? { messages: tallyMessages(existing?.messages, plans.map((p) => ({ message: p.sample.message, at: p.occurrence.at }))) } : {}),
  };

  let groupId: Id<"event_groups">;
  let shortId: string;
  const quiet = stored && !folded.transitions.length && next.status === stored.status && now - stored.updated_at < GROUP_WRITE_EVERY_MS;
  if (quiet) {
    groupId = stored._id;
    shortId = stored.short_id;
    const held = tallyJson(fields);
    if (tally) await ctx.db.patch(tally._id, { fields_json: held, updated_at: now });
    else {
      await ctx.db.insert("event_group_tallies", { group_id: groupId, fields_json: held, updated_at: now });
      await ctx.scheduler.runAfter(GROUP_WRITE_EVERY_MS, internal.ingest.flushGroupTally, { group_id: groupId });
    }
  } else {
    ({ group_id: groupId, short_id: shortId } = await writeGroup(ctx, source, stored, plan.fingerprint, { ...fields, updated_at: now }));
    if (tally) await ctx.db.delete(tally._id);
  }
  await appendSamples(ctx, source, groupId, plans, keep, priorSamples, existing ? { samples: priorSamples, last_release: existing.last_release, last_seen: existing.last_seen } : null);
  for (const key of people.keys) await ctx.db.insert("event_group_users", { group_id: groupId, user_key: key, at: now });

  for (const t of folded.transitions) {
    await announceTransition(ctx, source, {
      group_id: groupId,
      group_short_id: shortId,
      kind: plan.kind,
      title: newest.title,
      level: fields.level as string | undefined,
      count: next.count,
      transition: t.transition,
      at: t.at,
      reopens: t.reopens,
      release: envelope.release,
      environment: envelope.environment,
      value: newest.meta?.value,
      threshold: newest.meta?.threshold,
      signal_fingerprint: groupFingerprint(source.fingerprint_prefix, plan.kind, plan.fp),
      cause_task_id: stored?.signal_task_id,
      link,
    });
  }
  return { group_id: groupId, short_id: shortId, open_delta: openGroupsDelta(existing?.status, next.status), transitions: folded.transitions.length };
}

/** How many distinct people one group counts at most; past it the count stops growing rather than the table. */
export const GROUP_USERS_MAX = 10_000;
/** New people one batch may add to a group: a bounded number of index reads per batch. */
export const GROUP_USERS_PER_BATCH = 50;

/**
 * The people in a batch the group has not counted yet, and the alias keys to
 * store. A person is every identifier their occurrences carry together
 * (lib/groupPeople): one already held under any of their keys is not new,
 * and their other keys are stored beside it so the next occurrence matches
 * whichever key it arrives with.
 */
export async function newGroupUsers(ctx: any, groupId: Id<"event_groups"> | null, plans: GroupPlan[]): Promise<{ added: number; keys: string[] }> {
  const clusters = clusterPeople(plans.filter((p) => p.occurrence.ok !== true).map((p) => p.sample.user)).slice(0, GROUP_USERS_PER_BATCH);
  let added = 0;
  const keys: string[] = [];
  for (const c of clusters) {
    const held = new Set<string>();
    if (groupId) {
      for (const key of c) {
        if (await ctx.db.query("event_group_users").withIndex("by_group_user", (q: any) => q.eq("group_id", groupId).eq("user_key", key)).first()) held.add(key);
      }
    }
    if (!held.size) added++;
    keys.push(...c.filter((k) => !held.has(k)));
  }
  return { added, keys };
}

/**
 * The group's people count after a batch. A group that existed before people
 * were counted starts its count now and says since when (users_since), so a
 * reader never shows a partial count as the whole.
 */
export function usersFields(existing: Doc<"event_groups"> | null, added: number, now: number): { users?: number; users_since?: number } {
  const counting = existing ? existing.users !== undefined || existing.users_since !== undefined : true;
  const users = Math.min(GROUP_USERS_MAX, (existing?.users ?? 0) + added);
  const since = existing?.users_since ?? (counting ? undefined : now);
  return { users: counting || added ? users : existing?.users, users_since: since };
}

/** The row write every upsert shares: patch the group, or insert it with its short id. */
export async function writeGroup(
  ctx: any,
  source: Doc<"event_sources">,
  existing: Doc<"event_groups"> | null,
  fingerprint: string,
  fields: Record<string, unknown>,
): Promise<{ group_id: Id<"event_groups">; short_id: string }> {
  if (existing) {
    await ctx.db.patch(existing._id, fields);
    return { group_id: existing._id, short_id: existing.short_id };
  }
  const shortId = await nextShortId(ctx.db, INGEST_SHORT_ID_PREFIX.group);
  const groupId = await ctx.db.insert("event_groups", {
    ...fields,
    workspace: source.workspace,
    team_id: source.team_id,
    source_id: source._id,
    short_id: shortId,
    fingerprint,
  });
  return { group_id: groupId, short_id: shortId };
}

/** A vendor group as an adapter read it (X7): its state, its names, and where it lives there. */
export interface MirroredGroup extends MirrorSnapshot {
  /** The kind's own fingerprint (sentryIssueFingerprint), before segment or prefix. */
  fp: string;
  title: string;
  culprit?: string;
  level?: string;
  users?: number;
  external: { provider: string; id: string; url?: string };
}

/**
 * A vendor group mirrored into its row under applyMirror, the counterpart of
 * upsertGroup for a feed that reports whole groups rather than occurrences.
 * A read that changes nothing writes nothing, so a poll every two minutes
 * over a quiet project costs reads only. `added` is how many occurrences the
 * vendor counted since the last read.
 */
export async function mirrorGroup(
  ctx: any,
  source: Doc<"event_sources">,
  m: MirroredGroup,
  now: number,
): Promise<{ group_id?: Id<"event_groups">; short_id?: string; open_delta: number; transitions: number; added: number }> {
  const fingerprint = groupFingerprint(undefined, m.kind, m.fp);
  const existing = await findGroup(ctx, source._id, fingerprint);
  const { next, transitions } = applyMirror(existing ? stateOf(existing) : null, m, now, source.created_at);
  const fields: Record<string, unknown> = {
    ...next,
    title: m.title,
    culprit: m.culprit ?? existing?.culprit,
    level: m.level ?? existing?.level,
    users: m.users ?? existing?.users,
    external: m.external,
  };
  const added = Math.max(0, next.count - (existing?.count ?? 0));
  if (existing && !transitions.length && Object.keys(fields).every((k) => JSON.stringify((existing as any)[k]) === JSON.stringify(fields[k]))) {
    return { group_id: existing._id, short_id: existing.short_id, open_delta: 0, transitions: 0, added: 0 };
  }
  const { group_id, short_id } = await writeGroup(ctx, source, existing, fingerprint, { ...fields, updated_at: now });
  for (const t of transitions) {
    await announceTransition(ctx, source, {
      group_id,
      group_short_id: short_id,
      kind: m.kind,
      title: m.title,
      level: m.level,
      count: next.count,
      transition: t.transition,
      at: t.at,
      reopens: t.reopens,
      release: m.release,
      signal_fingerprint: groupFingerprint(source.fingerprint_prefix, m.kind, m.fp),
      cause_task_id: existing?.signal_task_id,
    });
  }
  return { group_id, short_id, open_delta: openGroupsDelta(existing?.status, next.status), transitions: transitions.length, added };
}

/**
 * Vendor groups for one source mirrored in one transaction, with the source's
 * counters moved once: what the Sentry poll and webhook both write through.
 */
export async function mirrorGroups(ctx: any, source: Doc<"event_sources">, groups: MirroredGroup[], now: number): Promise<{ mirrored: number; transitions: number }> {
  if (source.status === "paused") return { mirrored: 0, transitions: 0 };
  let openDelta = 0;
  let transitions = 0;
  let added = 0;
  for (const m of groups) {
    const out = await mirrorGroup(ctx, source, m, now);
    openDelta += out.open_delta;
    transitions += out.transitions;
    added += out.added;
  }
  if (openDelta || added) {
    await patchSourceStats(ctx, source, (s) => ({
      events_today: (s.events_today ?? 0) + added,
      groups_open: Math.max(0, (s.groups_open ?? 0) + openDelta),
      ...(added ? { last_event_at: now } : {}),
    }), now);
  }
  return { mirrored: groups.length, transitions };
}

/** The newest few occurrences of a batch worth keeping. A green check report is not one. */
export function samplesToKeep(plans: GroupPlan[]): GroupPlan[] {
  return plans
    .filter((p) => p.occurrence.ok !== true)
    .sort((a, b) => b.occurrence.at - a.occurrence.at)
    .slice(0, SAMPLES_PER_BATCH);
}

/** A group's samples counted, for a row written before sample_count. At most samples_per_group plus one batch. */
export async function countSamples(ctx: any, groupId: Id<"event_groups">): Promise<number> {
  const rows = await ctx.db.query("event_samples").withIndex("by_group_at", (q: any) => q.eq("group_id", groupId)).take(GROUP_RULES.samples_per_group + SAMPLES_PER_BATCH);
  return rows.length;
}

/**
 * A batch's kept occurrences as samples, then the oldest past the cap
 * removed. `prior` is how many the group held, so the trim reads only the
 * rows it deletes, never the group's whole set of bodies.
 */
export async function appendSamples(ctx: any, source: Doc<"event_sources">, groupId: Id<"event_groups">, plans: GroupPlan[], keep: GroupPlan[], prior: number, held: { samples: number; last_release?: string; last_seen?: number } | null): Promise<void> {
  // Every occurrence inside a recording links the recording to its group
  // (X5), sampled or not; a kept sample also names the recording's row.
  const replays = new Map<string, Id<"replays"> | null>();
  for (const p of plans) {
    const ext = p.sample.replay_external_id;
    if (ext && !replays.has(ext)) replays.set(ext, await linkReplayToGroup(ctx, source, ext, groupId, p.occurrence.at));
  }
  if (!keep.length) return;
  const pins = samplePins(keep.map((p) => p.sample), held);
  for (const [i, p] of keep.entries()) {
    const replayId = p.sample.replay_external_id ? replays.get(p.sample.replay_external_id) : undefined;
    await ctx.db.insert("event_samples", { ...p.sample, workspace: source.workspace, group_id: groupId, source_id: source._id, ...(replayId ? { replay_id: replayId } : {}), ...(pins[i] ? { pin: pins[i] } : {}) });
  }
  const over = prior + keep.length - GROUP_RULES.samples_per_group;
  if (over <= 0) return;
  // The trim reads a few past the overflow so it can pass over pinned samples and keep the group's samples spread over its life.
  const oldest: Doc<"event_samples">[] = await ctx.db.query("event_samples").withIndex("by_group_at", (q: any) => q.eq("group_id", groupId)).order("asc").take(over + SAMPLE_TRIM_LOOKAHEAD);
  for (const extra of samplesToTrim(oldest, over)) await ctx.db.delete(extra._id);
}

export interface Announcement {
  group_id: Id<"event_groups">;
  group_short_id: string;
  kind: GroupKind;
  title: string;
  level?: string;
  count: number;
  transition: Transition;
  at: number;
  /** The resolve the transition breaks (TransitionAt.reopens). */
  reopens?: number;
  release?: string;
  environment?: string;
  /** A metric's polled value and its line. */
  value?: number;
  threshold?: number;
  signal_fingerprint: string;
  /** The cause the group already promoted to, so its later transitions land on that task's timeline. */
  cause_task_id?: Id<"tasks">;
  link?: EventLink;
}

/**
 * Where a transition happened in git, for a feed that knows (CI on a
 * repository): stored on the timeline row, and the repository lets a
 * trigger's --repo filter match the firing.
 */
export interface EventLink {
  repository?: string;
  url?: string;
  sha?: string;
  branch?: string;
}

/**
 * A transition's three effects (X3, X4, X6): the timeline row, the triggers
 * armed on its name, and a promotion when the source promotes it. A
 * transition already on the timeline (a retried batch) has had its effects
 * and fires nothing again; promotions past SOURCE_CAPS.promotions_per_hour
 * stay on the timeline and the triggers without filing a signal.
 */
export async function announceTransition(ctx: any, source: Doc<"event_sources">, a: Announcement): Promise<void> {
  const eventType = transitionTriggerEvent(a.kind, a.transition);
  const { id: eventId, created } = await recordExternalEventOnce(ctx, {
    team_id: source.team_id,
    workspace: source.workspace,
    source: source.provider,
    kind: eventType ?? a.transition,
    title: a.title,
    ...a.link,
    source_id: source._id,
    group_id: a.group_id,
    data: {
      transition: a.transition,
      group_kind: a.kind,
      group_short_id: a.group_short_id,
      source_name: source.name,
      provider: source.provider,
      count: a.count,
      level: a.level,
      release: a.release,
      environment: a.environment,
      value: a.value,
      threshold: a.threshold,
    },
    dedupe_key: `ingest:${a.group_id}:${a.transition}:${a.at}${a.reopens !== undefined ? `:after:${a.reopens}` : ""}`,
    created_at: a.at,
    task_ids: a.cause_task_id ? [a.cause_task_id] : undefined,
  });
  if (!created) return;
  if (eventType) {
    await scheduleTriggerMatch(ctx, {
      event_type: eventType,
      team_id: source.team_id,
      workspace: source.workspace,
      source: source.name,
      repository: a.link?.repository,
      event_ref: { external_event_id: eventId, group_short_id: a.group_short_id, title: a.title },
    });
  }
  const kind = transitionSignalKind(a.transition);
  if (kind && source.promote.includes(a.transition)) {
    const { granted } = await takeFromWindow(ctx.db, `ingest-promote:${source._id}`, SOURCE_CAPS.promotions_per_hour, HOUR_MS, 1);
    // Over the cap the promotion waits on the group rather than being dropped:
    // a group that promoted nothing on its "new" transition would otherwise
    // never reach the line unless it regressed (promoteDue files it later).
    const due = { transition: a.transition, fingerprint: a.signal_fingerprint, external_event_id: eventId };
    if (!granted) {
      await ctx.db.patch(a.group_id, { promotion_due: { ...due, at: Date.now() } });
      return;
    }
    await schedulePromotion(ctx, a.group_id, due);
  }
}
