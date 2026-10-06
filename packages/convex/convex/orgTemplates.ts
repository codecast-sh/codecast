// Roles hired from a template (docs/architecture/org-hire.md W8): the template
// as a server object, the instance row the web reads and an upgrade walks, and
// lessons flowing back to the publisher. The manifest validator and the record
// rules are the shared ones the CLI uses (orgTemplateManifest, orgTemplateState,
// orgTemplateReadiness), so one definition serves inspect, publish, the host
// step and the role page.
//
// Every mutation is a thin wrapper over a `perform*` function that takes the db
// and the caller, so the fake-db tests drive the same code the mutation runs.
// Access is the stored workspace key (lib/access): a template row carries its
// publisher's key or the positive value "codecast"; an instance carries the
// hiring workspace's key; a lesson carries the publisher's key.
import { v } from "convex/values";
import { mutation, query } from "./functions";
import { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId, reachableRole, tellRole } from "./pendingMessages";
import { canAccessProject, requireTeamAdmin, requireTeamMembership, resolveWorkspaceKey, workspaceGrantsAccess, workspaceKey, type WorkspaceKey } from "./lib/access";
import { compareVersions, validateTemplate, type OrgTemplate } from "@codecast/shared/contracts/orgTemplateManifest";
import { type ReleaseChanges, type ReleaseClass, type UpdateNames, updateNames, bumpRefusal, changelogBetween, classifyRelease, jumpBetween, previousRelease, releaseNote, updateOffer, withClasses } from "@codecast/shared/contracts/orgTemplateRelease";
import { markSetup, nextHumanAsk, readiness, recordEvidence, recordScores, setupRows, type InstanceState, type SetupText } from "@codecast/shared/contracts/orgTemplateState";
import { routineState, type RoutineReadiness } from "@codecast/shared/contracts/orgTemplateReadiness";
import type { LessonKind } from "@codecast/shared/contracts/orgTemplateLearning";
import { applyActivate, getArmableTask } from "./agentTasks";
import { refuseUnlessHuman, standingConversationOf } from "./orgRoles";
import { DEVICE_ONLINE_MS, pickOwnerDevice } from "./deviceRouting";
import type { OrgTemplateBindArgs, OrgTemplateBindResult, OrgTemplateBindSecret } from "@codecast/shared/contracts/orgTemplateBind";
import { truncateStr } from "@codecast/shared/render";

/** The one value beside a workspace key that grants visibility: a template every workspace may hire. */
export const CODECAST_TEMPLATE_ACCESS = "codecast";
const RELEASE_STATUSES = ["draft", "canary", "stable"] as const;
type ReleaseStatus = (typeof RELEASE_STATUSES)[number];
const digestRe = /^[a-f0-9]{64}$/;

export type Ctx = { db: any; storage?: any };

export async function requireCaller(ctx: Ctx, apiToken?: string): Promise<Id<"users">> {
  const userId = await getAuthenticatedUserId(ctx, apiToken);
  if (!userId) throw new Error("Authentication failed: invalid token or session");
  return userId;
}

/** The key a caller publishes or hires under: a team they belong to, else their own. */
export async function callerWorkspace(ctx: Ctx, userId: Id<"users">, teamId?: Id<"teams">): Promise<WorkspaceKey> {
  if (teamId) { await requireTeamMembership(ctx as any, userId, teamId); return workspaceKey({ type: "team", teamId }); }
  return workspaceKey({ type: "personal", userId });
}

/** Publishing as Codecast is the Codecast team's admins' act; the team is named on the deployment. */
export async function requireCodecastPublisher(ctx: Ctx, userId: Id<"users">): Promise<void> {
  const teamId = process.env.CODECAST_TEMPLATES_TEAM_ID as Id<"teams"> | undefined;
  if (!teamId) throw new Error("Publishing as codecast is not enabled on this deployment (CODECAST_TEMPLATES_TEAM_ID)");
  await requireTeamAdmin(ctx as any, userId, teamId);
}

export async function templateRow(ctx: Ctx, templateId: string, access: WorkspaceKey): Promise<any> {
  const rows: any[] = await ctx.db.query("org_templates").withIndex("by_template_id", (q: any) => q.eq("template_id", templateId)).collect();
  return rows.find((r) => r.workspace === access) ?? null;
}
/**
 * The template a viewer in `access` reads: their own workspace's, else
 * Codecast's. A retired row is skipped, so a workspace that retired its own
 * copy hires Codecast's again; with `pin`, the row that holds that release
 * wins, so an instance keeps reading the row it was hired from, retired or not.
 */
export async function visibleTemplate(ctx: Ctx, templateId: string, access: WorkspaceKey, pin?: { version: string; digest: string }): Promise<any> {
  const rows = [await templateRow(ctx, templateId, access), access === CODECAST_TEMPLATE_ACCESS ? null : await templateRow(ctx, templateId, CODECAST_TEMPLATE_ACCESS)].filter(Boolean);
  return (pin && rows.find((r) => releaseOf(r, pin))) ?? rows.find((r) => !r.retired) ?? null;
}
export const releaseOf = (template: any, pin: { version: string; digest: string }): any => template?.releases.find((r: any) => r.version === pin.version && r.digest === pin.digest) ?? null;
/** The newest release nobody withdrew: what `latest` points at. */
const newestGood = (releases: any[]) => releases.filter((r) => !r.yanked).sort((a, b) => compareVersions(a.version, b.version)).at(-1) ?? null;

// ── Publish and catalog (H1) ────────────────────────────────────────────────

export type PublishArgs = { team_id?: Id<"teams">; as_codecast?: boolean; manifest: unknown; digest: string; status?: ReleaseStatus; changelog?: string; storage_id?: Id<"_storage">; review_project_id?: Id<"projects">; dry_run?: boolean };

/** The workspace a publisher acts in: Codecast's (its admins) or one the caller belongs to. Publish, yank and retire share it. */
async function publisherAccess(ctx: Ctx, userId: Id<"users">, args: { as_codecast?: boolean; team_id?: Id<"teams"> }): Promise<WorkspaceKey> {
  if (args.as_codecast) { await requireCodecastPublisher(ctx, userId); return CODECAST_TEMPLATE_ACCESS; }
  return callerWorkspace(ctx, userId, args.team_id);
}

/**
 * Write or advance a template from a validated manifest and its release
 * digest. Same version with another digest is refused; the same version and
 * digest again only moves its status or changelog. A new version is
 * classified against the release before it (orgTemplateRelease) and refused
 * when its version bump is smaller than its class needs; it becomes latest
 * and its manifest replaces the row's. `dry_run` answers the same without
 * writing.
 */
export async function performPublish(ctx: Ctx, userId: Id<"users">, args: PublishArgs) {
  const manifest = validateTemplate(args.manifest);
  if (!digestRe.test(args.digest)) throw new Error("digest must be a SHA-256 hex string");
  const status: ReleaseStatus = args.status ?? "draft";
  if (!RELEASE_STATUSES.includes(status)) throw new Error("status must be draft, canary or stable");
  const access = await publisherAccess(ctx, userId, args);
  if (args.review_project_id) {
    const project = await ctx.db.get(args.review_project_id);
    if (!project || !(await canAccessProject(ctx as any, userId, project))) throw new Error("Review project not found");
  }
  const now = Date.now();
  const existing = await templateRow(ctx, manifest.id, access);
  if (existing?.retired) throw new Error(`${manifest.id} is retired in this workspace; run cast org template retire ${manifest.id} --undo first`);
  const same = existing?.releases.find((r: any) => r.version === manifest.version);
  if (same && same.digest !== args.digest) throw new Error(`Version ${manifest.version} is already published with different content; publish a new version`);
  if (same?.yanked) throw new Error(`${manifest.id}@${manifest.version} was yanked (${same.yanked.reason}); publish a new version`);
  const prev: any = same ? null : previousRelease(existing?.releases ?? [], manifest.version);
  const classed = same ? withClasses(existing.releases).find((r: any) => r.version === same.version)! : classifyRelease(prev?.manifest ?? null, manifest);
  const classification = { class: classed.class, changes: classed.changes };
  if (!same) { const refused = bumpRefusal(prev?.manifest ?? null, manifest); if (refused) throw new Error(refused); }
  const action = !existing ? ("created" as const) : same ? ("updated" as const) : ("released" as const);
  if (args.dry_run) return { template_id: manifest.id, workspace: access, version: manifest.version, previous: prev?.version ?? null, action, dry_run: true, ...classification };
  const release = { version: manifest.version, digest: args.digest, status, changelog: args.changelog, storage_id: args.storage_id, manifest, published_at: now, published_by: userId, ...classification };
  if (!existing) {
    const id = await ctx.db.insert("org_templates", {
      template_id: manifest.id, workspace: access, name: manifest.name, description: manifest.description, avatar: manifest.role.avatar,
      latest: { version: manifest.version, digest: args.digest }, releases: [release], manifest, review_project_id: args.review_project_id,
      created_by: userId, created_at: now, updated_at: now,
    });
    return { ...(await ctx.db.get(id)), action, ...classification };
  }
  const releases = same
    ? existing.releases.map((r: any) => (r.version === manifest.version ? { ...r, status, changelog: args.changelog ?? r.changelog, storage_id: args.storage_id ?? r.storage_id } : r))
    : [...existing.releases, release];
  const advances = !same && compareVersions(manifest.version, existing.latest.version) > 0;
  const patch: Record<string, unknown> = { releases, updated_at: now, ...(args.review_project_id ? { review_project_id: args.review_project_id } : {}) };
  if (advances || (same && manifest.version === existing.latest.version)) Object.assign(patch, { latest: { version: manifest.version, digest: args.digest }, manifest, name: manifest.name, description: manifest.description, avatar: manifest.role.avatar });
  await ctx.db.patch(existing._id, patch);
  return { ...(await ctx.db.get(existing._id)), action, ...classification };
}

export { compareVersions };

/** What the hire form lists: a viewer's own templates and Codecast's, with what each asks for. */
export async function performCatalog(ctx: Ctx, userId: Id<"users">, args: { team_id?: Id<"teams"> }) {
  const access = await callerWorkspace(ctx, userId, args.team_id);
  const own: any[] = await ctx.db.query("org_templates").withIndex("by_workspace", (q: any) => q.eq("workspace", access)).collect();
  const shared: any[] = access === CODECAST_TEMPLATE_ACCESS ? [] : await ctx.db.query("org_templates").withIndex("by_workspace", (q: any) => q.eq("workspace", CODECAST_TEMPLATE_ACCESS)).collect();
  // A retired template, or one whose every release was yanked, is offered to nobody.
  return [...own, ...shared].filter((row) => !row.retired && newestGood(row.releases)).map(catalogEntry);
}
export function catalogEntry(row: any) {
  const m = row.manifest as OrgTemplate;
  // A release can be installed from the record only when publish uploaded its
  // snapshot (H1); a manifest alone lets a person read the template, not hire it.
  // A yanked release is not listed: no hire or update can pick it.
  const releases = withClasses(row.releases).filter((r: any) => !r.yanked);
  const latest = releaseOf(row, row.latest);
  return {
    template_id: row.template_id, workspace: row.workspace, name: row.name, description: row.description, avatar: row.avatar,
    latest: row.latest, installable: !!latest?.storage_id && !latest?.yanked, latest_status: latest?.status ?? null, latest_class: releases.find((r: any) => r.version === row.latest.version)?.class ?? null, changelog: latest?.changelog ?? null,
    ...(row.retired ? { retired: row.retired } : {}),
    releases: releases.map((r: any) => ({ version: r.version, digest: r.digest, status: r.status, published_at: r.published_at, installable: !!r.storage_id, class: r.class, changes: r.changes })),
    asks: { inputs: (m.inputs ?? []).length, secrets: (m.inputs ?? []).filter((i) => i.kind === "secret").length, authority: (m.authority ?? []).length, setup: (m.setup ?? []).length, routines: m.routines.length },
    manifest: m,
  };
}
/** A catalog entry as the org reviewer reads it (orgInit's `templates`): one
 *  line saying what the role does, and the release a hire change pins. */
export function templateLine(t: ReturnType<typeof catalogEntry>, descriptionChars: number) {
  return { id: t.template_id as string, name: t.name as string, description: truncateStr(String(t.description ?? "").replace(/\s+/g, " ").trim(), descriptionChars), version: t.latest.version as string, digest: t.latest.digest as string, status: t.latest_status as string | null };
}
export async function performGetTemplate(ctx: Ctx, userId: Id<"users">, args: { template_id: string; team_id?: Id<"teams"> }) {
  const row = await visibleTemplate(ctx, args.template_id, await callerWorkspace(ctx, userId, args.team_id));
  if (!row) throw new Error("Template not found");
  return catalogEntry(row);
}
/** One published release for the host step (H1, install from the record): its manifest and the snapshot's download URL, or null when publish uploaded none. */
export async function performRelease(ctx: Ctx, userId: Id<"users">, args: { template_id: string; version: string; digest: string; team_id?: Id<"teams"> }) {
  const row = await visibleTemplate(ctx, args.template_id, await callerWorkspace(ctx, userId, args.team_id), args);
  if (!row) throw new Error("Template not found");
  const release = releaseOf(row, args);
  if (!release) throw new Error(`Release ${args.template_id}@${args.version} with this digest is not published`);
  const storage_url = release.storage_id && ctx.storage ? await ctx.storage.getUrl(release.storage_id) : null;
  return { template_id: row.template_id, version: release.version, digest: release.digest, status: release.status, manifest: release.manifest, storage_url: storage_url ?? null };
}

// ── The instance row (H1, H3) ───────────────────────────────────────────────

export type UpsertInstanceArgs = {
  instance_key: string; instance: string; template_id: string; version: string; digest: string; project_id: Id<"projects">;
  role_id?: Id<"org_roles">; host?: { machine: string; dir: string }; phase?: "awaiting_host" | "ready" | "upgrading" | "retired"; update_policy?: "manual" | "canary" | "stable";
  config?: Record<string, string>; bindings?: Record<string, { host: string; path_hash: string; bound_at: number }>; ledgers?: Record<string, { taskId: string; shortId: string }>;
  routines?: Record<string, { triggerId?: string; external?: boolean; retired?: boolean }>;
  /** Each setup item's title, price and how-to guide with the instance's values filled in, rendered by the host at bind. */
  setup_text?: SetupText;
  /** The session that ran bind, when an agent did: the role's own standing session is not told what it just did. */
  from_session?: string;
};

/**
 * The host step's record of a hire (bind), or the hire change's row before
 * it (awaiting_host). Upserts by the receipt's key. The row carries the
 * hiring workspace's key, read from the project; the template must be one
 * that workspace may hire. Answers never carry a secret: a secret input's
 * value is refused here, its binding is recorded by hash instead.
 */
export async function performUpsertInstance(ctx: Ctx, userId: Id<"users">, args: UpsertInstanceArgs) {
  const project = await ctx.db.get(args.project_id);
  if (!project || !(await canAccessProject(ctx as any, userId, project))) throw new Error("Project not found");
  const access = await resolveWorkspaceKey(ctx as any, project);
  const template = await visibleTemplate(ctx, args.template_id, access, args);
  if (!template) throw new Error(`Template ${args.template_id} is not available to this workspace`);
  const release = releaseOf(template, args);
  if (!release) throw new Error(`Release ${args.template_id}@${args.version} with this digest is not published`);
  const manifest = template.manifest as OrgTemplate;
  const secrets = new Set((manifest.inputs ?? []).filter((i) => i.kind === "secret").map((i) => i.key));
  for (const key of Object.keys(args.config ?? {})) if (secrets.has(key)) throw new Error(`Secret input ${key} is bound on the host, never stored as an answer`);
  if (args.role_id) {
    const role = await ctx.db.get(args.role_id);
    if (!role || role.status === "retired" || !(role.scope?.project_ids ?? []).some((id: any) => String(id) === String(args.project_id))) throw new Error("Role not found or does not lead this project");
  }
  const now = Date.now();
  // The row is found by the host's key, or, for a hire accepted on the web
  // before any host step, by the instance's name on the project: that row was
  // written awaiting the host, and takes the host's key when bind arrives.
  let existing = await ctx.db.query("org_template_instances").withIndex("by_instance_key", (q: any) => q.eq("instance_key", args.instance_key)).first();
  if (!existing) {
    const rows: any[] = await ctx.db.query("org_template_instances").withIndex("by_workspace", (q: any) => q.eq("workspace", access)).collect();
    existing = rows.find((r) => String(r.project_id) === String(args.project_id) && r.instance === args.instance) ?? null;
    if (existing && existing.phase !== "awaiting_host" && existing.instance_key !== args.instance_key) throw new Error(`Instance ${args.instance} already exists on this project under another host; choose another name or rebind from that host`);
  }
  const fields = {
    instance: args.instance, template_id: args.template_id, version: args.version, digest: args.digest, project_id: args.project_id,
    ...(args.role_id ? { role_id: args.role_id } : {}), ...(args.host ? { host: args.host } : {}),
    ...(args.config ? { config: args.config } : {}), ...(args.bindings ? { bindings: args.bindings } : {}), ...(args.ledgers ? { ledgers: args.ledgers } : {}), ...(args.routines ? { routines: args.routines } : {}),
    ...(args.setup_text ? { setup_text: args.setup_text } : {}),
    updated_at: now,
  };
  // A new hire, or a move, never lands on a withdrawn release or a retired
  // template; an instance already on one keeps binding where it is.
  const moved = !!existing && (existing.version !== args.version || existing.digest !== args.digest);
  if (!existing || moved) {
    if (release.yanked) throw new Error(`${args.template_id}@${args.version} was yanked by its publisher (${release.yanked.reason}); pick another release`);
    if (!existing && template.retired) throw new Error(`${args.template_id} is retired by its publisher and can no longer be hired`);
  }
  let id = existing?._id;
  if (existing) {
    if (existing.workspace !== access || String(existing.project_id) !== String(args.project_id)) throw new Error("Instance belongs to another project or workspace");
    // A release change starts the row's time on that release (H12, the canary's
    // runs count from here), and an accepted upgrade that has arrived stops waiting.
    const arrived = existing.pending_upgrade?.to === args.version && existing.pending_upgrade?.digest === args.digest;
    await ctx.db.patch(existing._id, { ...fields, instance_key: args.instance_key, phase: args.phase ?? existing.phase, update_policy: args.update_policy ?? existing.update_policy, ...(moved ? { version_at: now } : {}), ...(arrived ? { pending_upgrade: undefined } : {}) });
  } else {
    id = await ctx.db.insert("org_template_instances", { instance_key: args.instance_key, workspace: access, phase: args.phase ?? "ready", update_policy: args.update_policy ?? "manual", ...fields, version_at: now, created_by: userId, created_at: now });
  }
  const row = await ctx.db.get(id);
  await tellRoleOfBind(ctx, userId, existing, row, template, release.manifest as OrgTemplate, args.from_session);
  return row;
}

type RoutineRow = { id: string; title: string; every: string; mode: "propose" | "apply"; external: boolean; retired: boolean; trigger: { id: string; short_id?: string; status: string; run_at?: number; precheck?: string; interval_ms?: number; run_count?: number; last_run_at?: number; last_run_failed?: boolean } | null };
/** The pinned release's routines with the trigger each is bound to: the role page's Triggers rows, and the list a role hears after a bind. */
export async function routineRows(ctx: Ctx, row: any, manifest: OrgTemplate | undefined): Promise<RoutineRow[]> {
  const rows: RoutineRow[] = [];
  for (const r of manifest?.routines ?? []) {
    const bound = row.routines?.[r.id];
    const trigger = bound?.triggerId ? await ctx.db.get(bound.triggerId as Id<"agent_tasks">) : null;
    // The trigger carries the title with the instance's values filled in; the manifest's may still hold tokens.
    rows.push({ id: r.id, title: trigger?.title ?? r.title, every: r.every, mode: r.mode ?? "propose", external: !!bound?.external, retired: !!bound?.retired, trigger: trigger ? { id: String(trigger._id), short_id: trigger.short_id, status: trigger.status, run_at: trigger.run_at, precheck: trigger.precheck, interval_ms: trigger.interval_ms, run_count: trigger.run_count, last_run_at: trigger.last_run_at, last_run_failed: trigger.last_run_failed } : null });
  }
  return rows;
}

const listed = (words: string[]) => words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
/**
 * What a role hears, once, when its host step finishes or a secret is bound:
 * what is bound now, what is still missing, and where each routine stands.
 * Plain words, because it arrives in the standing session as a message.
 */
export function bindNote(o: { instance: string; machine?: string; becameReady: boolean; newlyBound: string[]; secrets: { key: string; label: string; bound: boolean; unlocks?: string[] }[]; routines: RoutineRow[]; readiness: Record<string, RoutineReadiness> }): string {
  const on = o.machine ? ` on ${o.machine}` : "";
  const fresh = o.secrets.filter((s) => o.newlyBound.includes(s.key));
  const missing = o.secrets.filter((s) => !s.bound);
  const lines: string[] = [];
  if (o.becameReady) lines.push(`The host step for ${o.instance} finished${on}: the template is installed, the instance file is written and your routines exist, paused until a person activates each from the role page.`);
  if (fresh.length) {
    const unlocks = [...new Set(fresh.flatMap((s) => s.unlocks ?? []))];
    lines.push(`${listed(fresh.map((s) => s.label))} ${fresh.length === 1 ? "is" : "are"} now bound for ${o.instance}${on}: the value is in a file there and its path is in the instance file.${unlocks.length ? ` ${listed(unlocks)} needed it.` : ""}`);
  }
  if (o.secrets.length) lines.push(missing.length ? `Still missing: ${listed(missing.map((s) => s.label))}.` : "Every secret this template asks for is bound.");
  const live = o.routines.filter((r) => !r.retired);
  if (live.length) {
    lines.push("Routines:");
    for (const r of live) {
      const needs = o.readiness[r.id]?.missing ?? [];
      lines.push(`- ${r.title}${r.trigger?.short_id ? ` (${r.trigger.short_id})` : ""}: ${routineState(r, o.readiness[r.id])}${needs.length ? `; ${needs.join("; ")}` : ""}`);
    }
  }
  return lines.join("\n");
}

/**
 * Bind ends here from both doors: a person's `cast org template bind` and the
 * daemon's run of the same command for the role page's host step. Saving a
 * secret or finishing the host step used to change the record and wake nobody,
 * so the role kept asking for what it already had. It is told once per bind
 * that changed something: a rerun that binds nothing new says nothing.
 *
 * A bind that moved the instance to another release leads with the release
 * note (orgTemplateRelease.releaseNote), and is sent even to the session that
 * ran it: a long-lived standing session otherwise keeps acting on what it
 * remembers of the old release.
 */
async function tellRoleOfBind(ctx: Ctx, userId: Id<"users">, before: any, row: any, template: any, manifest: OrgTemplate, fromSession?: string): Promise<void> {
  if (!row.role_id || row.phase !== "ready") return;
  const becameReady = before?.phase !== "ready";
  const newlyBound = Object.keys(row.bindings ?? {}).filter((key) => row.bindings[key].bound_at !== before?.bindings?.[key]?.bound_at);
  const moved = !becameReady && (before.version !== row.version || before.digest !== row.digest);
  if (!becameReady && !newlyBound.length && !moved) return;
  const reached = await reachableRole(ctx, row.role_id);
  if (!reached || (!moved && fromSession && reached.standing.session_id === fromSession)) return;
  const state = stateOf(row, reached.role);
  const stamp = moved ? `release:${row.version}:${row.digest}` : newlyBound.length ? Math.max(...newlyBound.map((key) => row.bindings[key].bound_at)) : "ready";
  let lead = "";
  if (moved) {
    const old = releaseOf(template, before) ?? releaseOf(await visibleTemplate(ctx, row.template_id, row.workspace, before), before);
    const now = releaseOf(template, row);
    lead = releaseNote({
      instance: row.instance, template: template.name, from: before.version, next: manifest, yanked: old?.yanked?.reason ?? null,
      classification: (old && jumpBetween(template.releases, old, now)) ?? classifyRelease((old?.manifest as OrgTemplate | undefined) ?? null, manifest),
      changelogs: changelogBetween(template.releases, before.version, row.version),
    }) + "\n\n";
  }
  await tellRole(ctx, row.role_id, {
    content: lead + bindNote({
      instance: row.instance, machine: row.host?.machine, becameReady, newlyBound,
      secrets: (manifest.inputs ?? []).filter((i) => i.kind === "secret").map((i) => ({ key: i.key, label: i.label, bound: !!row.bindings?.[i.key], unlocks: i.unlocks })),
      routines: await routineRows(ctx, row, manifest),
      readiness: readiness(manifest, state, reached.role.trust ?? "understand"),
    }),
    client_id: `template-bind:${row._id}:${stamp}`,
    from_user_id: userId,
  });
}

export async function instanceFor(ctx: Ctx, userId: Id<"users">, instanceKey: string): Promise<{ row: any; manifest: OrgTemplate; template: any }> {
  const row = await ctx.db.query("org_template_instances").withIndex("by_instance_key", (q: any) => q.eq("instance_key", instanceKey)).first();
  if (!row || !(await workspaceGrantsAccess(ctx as any, userId, row.workspace))) throw new Error("Instance not found");
  const template = await visibleTemplate(ctx, row.template_id, row.workspace, row);
  if (!template) throw new Error("The instance's template is no longer available");
  // The instance runs its pinned release; the template's latest manifest may differ.
  const release = releaseOf(template, row);
  if (!release) throw new Error("The instance's pinned release is no longer published");
  return { row, manifest: release.manifest as OrgTemplate, template };
}
/** The instance record plus the authority its role holds (org_roles.authority), for readiness. */
export const stateOf = (row: any, role?: any): InstanceState => ({ evidence: row.evidence, scoreboard: row.scoreboard, setup: row.setup, authority: (role?.authority ?? []).map((g: any) => ({ id: g.id, expires_at: g.expires_at })) });

// ── The instance record (H5 to H7) ──────────────────────────────────────────

export async function performRecordEvidence(ctx: Ctx, userId: Id<"users">, args: { instance_key: string; check: string; status: string; source?: string; detail?: string[] }) {
  const { row, manifest } = await instanceFor(ctx, userId, args.instance_key);
  const state = stateOf(row);
  const record = recordEvidence(manifest, state, args.check, { status: args.status, source: args.source, detail: args.detail });
  await ctx.db.patch(row._id, { evidence: state.evidence, updated_at: Date.now() });
  return record;
}
export async function performRecordScores(ctx: Ctx, userId: Id<"users">, args: { instance_key: string; entries: string[]; source?: string; observed_at?: number }) {
  const { row, manifest } = await instanceFor(ctx, userId, args.instance_key);
  const state = stateOf(row);
  const written = recordScores(manifest, state, args.entries, { source: args.source, observedAt: args.observed_at });
  await ctx.db.patch(row._id, { scoreboard: state.scoreboard, updated_at: Date.now() });
  return written;
}
/** A person's setup item is marked by a person; the CLI says whether an agent session is calling. */
export async function performMarkSetup(ctx: Ctx, userId: Id<"users">, args: { instance_key: string; id: string; status: string; evidence?: string; from_agent: boolean }) {
  const { row, manifest } = await instanceFor(ctx, userId, args.instance_key);
  const state = stateOf(row);
  const next = markSetup(manifest, state, args.id, { status: args.status, evidence: args.evidence, fromAgent: args.from_agent });
  await ctx.db.patch(row._id, { setup: state.setup, updated_at: Date.now() });
  return next;
}

/** What the role page and `status` show: the row, its setup rows, the one open ask, readiness per routine. */
export async function performInstanceStatus(ctx: Ctx, userId: Id<"users">, args: { instance_key: string }) {
  const { row, manifest, template } = await instanceFor(ctx, userId, args.instance_key);
  const role = row.role_id ? await ctx.db.get(row.role_id) : null;
  const state = stateOf(row, role);
  const pinned = withClasses(template.releases).find((r: any) => r.version === row.version && r.digest === row.digest)!;
  // The rendered setup text rides inside the setup rows; `setup_marks` is the
  // raw record of who marked what, which the host reads back into its receipt.
  const { setup_text, ...rest } = row;
  return { ...rest, release: { version: pinned.version, status: pinned.status, class: pinned.class, yanked: pinned.yanked?.reason ?? null }, trust: role?.trust ?? "understand", authority: role?.authority ?? [], handle: role?.handle, setup: setupRows(manifest, state, setup_text), setup_marks: row.setup ?? {}, ask: nextHumanAsk(manifest, state, setup_text), readiness: readiness(manifest, state, role?.trust ?? "understand") };
}
export async function performListInstances(ctx: Ctx, userId: Id<"users">, args: { team_id?: Id<"teams">; template_id?: string }) {
  const access = await callerWorkspace(ctx, userId, args.team_id);
  const rows: any[] = await ctx.db.query("org_template_instances").withIndex("by_workspace", (q: any) => q.eq("workspace", access)).collect();
  // The rendered guides are the role page's (instanceStatus); a list of every instance leaves them out.
  return rows.filter((r) => !args.template_id || r.template_id === args.template_id).map(({ setup_text, ...r }) => r);
}
/** The role page's read (H11): the instance a role was hired as, with its status, or null for an ordinary role. */
export async function performInstanceForRole(ctx: Ctx, userId: Id<"users">, args: { role_id: Id<"org_roles"> }) {
  const rows: any[] = await ctx.db.query("org_template_instances").withIndex("by_role", (q: any) => q.eq("role_id", args.role_id)).collect();
  const row = rows.find((r) => r.phase !== "retired") ?? rows[0];
  if (!row || !(await workspaceGrantsAccess(ctx as any, userId, row.workspace))) return null;
  const status = await performInstanceStatus(ctx, userId, { instance_key: row.instance_key });
  const template = await visibleTemplate(ctx, row.template_id, row.workspace, row);
  const latest = template?.releases.filter((r: any) => r.status === "stable" && !r.yanked).map((r: any) => r.version).sort(compareVersions).at(-1);
  const pinned = releaseOf(template, row)?.manifest as OrgTemplate | undefined;
  const routines = await routineRows(ctx, row, pinned);
  const secrets = (pinned?.inputs ?? []).filter((i) => i.kind === "secret").map((i) => ({ key: i.key, label: i.label, bound: !!row.bindings?.[i.key] }));
  const scoreboard = (pinned?.scoreboard ?? []).map((k) => ({ ...k, ...(row.scoreboard?.[k.key] ?? {}) }));
  // The host step from the web (H3): the machine it would run on and how the
  // last request went, so the page shows one button and its progress.
  const bind_host = await bindHostOf(ctx, userId, row);
  const host_step = await hostStepOf(ctx, row);
  return { ...status, routines, secrets, scoreboard, bind_host: { device: bind_host.device, dir: bind_host.dir, reason: bind_host.reason }, host_step, template: template ? { name: template.name, avatar: template.avatar, latest_stable: latest, changelog: template.releases.find((r: any) => r.version === latest)?.changelog } : null, ...updateFields(template, row) };
}
/**
 * The Update card's data (sd-424: every change waits for a person's click):
 * the release offered (orgTemplateRelease.updateOffer), what moving to it
 * changes, judged by diffing the two manifests across the whole gap, every
 * changelog section in between, and how far behind the instance is.
 */
export function updateFields(template: any, row: any) {
  const none = { update_available: null as string | null, update_digest: null as string | null, update_class: null as ReleaseClass | null, update_changes: null as ReleaseChanges | null, update_changelogs: [] as { version: string; text: string }[], update_rollback: null as { reason: string } | null, update_names: null as UpdateNames | null, releases_behind: 0 };
  const pinned = releaseOf(template, row);
  if (!template || !pinned) return none;
  const offer = updateOffer(template.releases, row, row.update_policy ?? "manual");
  if (!offer.to) return { ...none, releases_behind: offer.behind };
  const jump = jumpBetween(template.releases, pinned, offer.to);
  return {
    update_available: offer.to.version, update_digest: offer.to.digest, update_class: jump?.class ?? null, update_changes: jump?.changes ?? null,
    update_changelogs: changelogBetween(template.releases, row.version, offer.to.version), update_rollback: offer.rollback, update_names: updateNames(offer.to.manifest), releases_behind: offer.behind,
  };
}

// ── The host step from the web (H3): a daemon runs bind ─────────────────────

export type BindHost = {
  host_user_id: Id<"users">;
  device: { device_id: string; label: string; online: boolean; is_remote: boolean; can_receive_secrets: boolean; pubkey: string | null } | null;
  /** The project checkout on that device: the standing session's directory, else the project's registered path. */
  dir: string | null;
  standing: boolean;
  /** Why no machine can run the step, in the words the role page shows. */
  reason: string | null;
};

/**
 * The machine the host step runs on: the one that runs the role's standing
 * session (it holds the checkout by construction), else the machine of the
 * session's host that holds the project's path (deviceRouting's ladder). The
 * daemon belongs to the session's host user; the person pressing the button
 * may be another member of the workspace.
 */
export async function bindHostOf(ctx: Ctx, userId: Id<"users">, row: any): Promise<BindHost> {
  const role = row.role_id ? await ctx.db.get(row.role_id) : null;
  const standing = role ? await standingConversationOf(ctx, role) : null;
  const project = await ctx.db.get(row.project_id);
  // The daemon that polls the command belongs to the human who runs the role
  // (org_roles.host_user_id); a standing session renders as its bot identity.
  const hostUser: Id<"users"> = role?.host_user_id ?? standing?.owner_user_id ?? userId;
  const dir: string | null = standing?.project_path ?? project?.project_path ?? null;
  const devices: any[] = await ctx.db.query("devices").withIndex("by_user_id", (q: any) => q.eq("user_id", hostUser)).collect();
  const now = Date.now();
  const picked = pickOwnerDevice(devices, { projectPath: dir, ownerDeviceId: standing?.owner_device_id ?? null }, now);
  const device = picked ? devices.find((d) => d.device_id === picked) : null;
  const base = { host_user_id: hostUser, dir, standing: !!standing };
  if (!device) return { ...base, device: null, reason: "No machine has run codecast for this workspace's host recently. Start the codecast app on the machine with the project's checkout, then try again." };
  if (!dir) return { ...base, device: null, reason: "The project has no checkout path on record. Start a session in the project's folder once, so codecast learns where it lives." };
  return { ...base, reason: null, device: { device_id: device.device_id, label: device.label ?? device.hostname ?? device.device_id.slice(0, 8), online: now - device.last_seen < DEVICE_ONLINE_MS, is_remote: !!device.is_remote, can_receive_secrets: !!device.provider_key_pubkey, pubkey: device.provider_key_pubkey ?? null } };
}

/** How the requested host step went, read from its command row: the role page's progress line. */
export async function hostStepOf(ctx: Ctx, row: any): Promise<{ state: "idle" | "pending" | "failed" | "done"; device_label?: string; requested_at?: number; error?: string; result?: OrgTemplateBindResult } > {
  const req = row.bind_request;
  if (!req) return { state: "idle" };
  const cmd = await ctx.db.get(req.command_id);
  const base = { device_label: req.device_label, requested_at: req.requested_at };
  if (!cmd) return { state: "idle" };
  if (!cmd.executed_at) return { state: "pending", ...base };
  if (cmd.error) return { state: "failed", ...base, error: cmd.error };
  let result: OrgTemplateBindResult | undefined;
  try { result = JSON.parse(cmd.result ?? "null") ?? undefined; } catch {}
  return { state: "done", ...base, result };
}

/**
 * Enqueue the host step (H3) for the machine bindHostOf names: one
 * `org_template_bind` command carrying the instance, its checkout, its
 * workspace and the secrets a person typed, each sealed in the browser to that
 * device's public key (H4: the value never enters the server in plain text;
 * the command row holds ciphertext only the device can open). Human only,
 * like activation. One request at a time: a pending one is returned, not
 * doubled.
 */
export async function performRequestBind(ctx: Ctx, userId: Id<"users">, args: { instance_key: string; secrets?: OrgTemplateBindSecret[]; device_id?: string }) {
  const { row, manifest } = await instanceFor(ctx, userId, args.instance_key);
  if (row.phase === "retired") throw new Error("This instance is retired");
  const secretKeys = new Set((manifest.inputs ?? []).filter((i) => i.kind === "secret").map((i) => i.key));
  const secrets = args.secrets ?? [];
  for (const s of secrets) {
    if (!secretKeys.has(s.key)) throw new Error(`Not a secret input of this template: ${s.key}`);
    if (!s.payload || s.payload.provider !== s.key || !s.payload.epk || !s.payload.iv || !s.payload.ct) throw new Error(`Secret ${s.key} must arrive sealed to the machine's key`);
  }
  return enqueueBind(ctx, userId, row, { secrets, device_id: args.device_id });
}
/**
 * One `org_template_bind` command for the machine bindHostOf names, recorded
 * on the row. One request at a time: a pending one is returned, not doubled.
 * A person's host step (above) and the publisher's canary rollout
 * (orgTemplateLearning.performRollout, H12) both queue through here.
 */
export async function enqueueBind(ctx: Ctx, userId: Id<"users">, row: any, args: { secrets?: OrgTemplateBindSecret[]; device_id?: string } = {}) {
  const secrets = args.secrets ?? [];
  const current = await hostStepOf(ctx, row);
  if (current.state === "pending" && row.bind_request) return { command_id: row.bind_request.command_id, device: { device_id: row.bind_request.device_id, label: row.bind_request.device_label }, already_pending: true };
  const host = await bindHostOf(ctx, userId, row);
  let device = host.device;
  if (args.device_id && device?.device_id !== args.device_id) {
    const rows: any[] = await ctx.db.query("devices").withIndex("by_user_id", (q: any) => q.eq("user_id", host.host_user_id)).collect();
    const chosen = rows.find((d) => d.device_id === args.device_id);
    if (!chosen) throw new Error("That machine is not one of the host's");
    device = { device_id: chosen.device_id, label: chosen.label ?? chosen.device_id.slice(0, 8), online: Date.now() - chosen.last_seen < DEVICE_ONLINE_MS, is_remote: !!chosen.is_remote, can_receive_secrets: !!chosen.provider_key_pubkey, pubkey: chosen.provider_key_pubkey ?? null };
  }
  if (!device || !host.dir) throw new Error(host.reason ?? "No machine can run the host step");
  if (secrets.length && !device.can_receive_secrets) throw new Error(`${device.label} runs a codecast too old to receive a secret from the web. Update codecast there, or bind the secret from its terminal.`);
  const [kind, id] = row.workspace.split(":", 2);
  if ((kind !== "team" && kind !== "user") || !id) throw new Error("Instance workspace is unresolved");
  const command: OrgTemplateBindArgs = { instance_key: row.instance_key, instance: row.instance, dir: host.dir, workspace: { kind, id }, secrets };
  const now = Date.now();
  const commandId = await ctx.db.insert("daemon_commands", { user_id: host.host_user_id, command: "org_template_bind" as const, args: JSON.stringify(command), created_at: now, target_device_id: device.device_id });
  await ctx.db.patch(row._id, { bind_request: { command_id: commandId, device_id: device.device_id, device_label: device.label, requested_at: now, requested_by: userId }, updated_at: now });
  return { command_id: commandId, device: { device_id: device.device_id, label: device.label }, already_pending: false };
}

// ── Lessons (H9) ────────────────────────────────────────────────────────────

/** A lesson leaves the hiring workspace as a row the publisher sees; the writer keeps only its status. */
export async function performFileLesson(ctx: Ctx, userId: Id<"users">, args: { instance_key: string; body: string; evidence?: { label: string; href: string }[] }) {
  const { row } = await instanceFor(ctx, userId, args.instance_key);
  return fileLessonRow(ctx, userId, row, { ...args, source: "role" });
}
export type LessonFields = { body: string; evidence?: { label: string; href: string }[]; source: "role" | "learning"; kind?: LessonKind; about?: string };
/** The one writer of a lesson row: the role's own lesson (above) and the learning pass (orgTemplateLearning, H12) both end here. */
export async function fileLessonRow(ctx: Ctx, userId: Id<"users">, row: any, args: LessonFields) {
  const body = args.body.trim();
  if (body.length < 20) throw new Error("Say what was learned, with its evidence: at least a sentence");
  if (body.length > 20000) throw new Error("A lesson is a proposal, not a report; keep it under 20000 characters");
  for (const e of args.evidence ?? []) if (!e.label.trim() || !/^(https?:\/\/|ct-\d+|pl-\d+|tr-\d+|doc:[a-z0-9]+|jx[a-z0-9]+)/i.test(e.href)) throw new Error("Each evidence entry needs a label and a link or short id");
  const template = await visibleTemplate(ctx, row.template_id, row.workspace, row);
  const now = Date.now();
  const id = await ctx.db.insert("org_template_lessons", {
    template_id: row.template_id, workspace: template.workspace, from_workspace: row.workspace, instance_key: row.instance_key,
    release: { version: row.version, digest: row.digest }, body, evidence: args.evidence ?? [], status: "open", source: args.source, ...(args.kind ? { kind: args.kind } : {}), ...(args.about ? { about: args.about } : {}),
    created_by: userId, created_at: now, updated_at: now,
  });
  const lesson = await ctx.db.get(id);
  return { id: lesson._id, status: lesson.status, created_at: lesson.created_at };
}
/** The publisher reads its lessons; an instance reads the status of its own. */
export async function performListLessons(ctx: Ctx, userId: Id<"users">, args: { template_id?: string; instance_key?: string; team_id?: Id<"teams">; as_codecast?: boolean }) {
  if (args.instance_key) {
    const { row } = await instanceFor(ctx, userId, args.instance_key);
    const rows: any[] = await ctx.db.query("org_template_lessons").withIndex("by_instance", (q: any) => q.eq("instance_key", row.instance_key)).collect();
    return rows.map((l) => ({ id: l._id, status: l.status, released_in: l.released_in, created_at: l.created_at, body: l.body, source: l.source ?? "role", kind: l.kind, about: l.about }));
  }
  if (!args.template_id) throw new Error("Name a template or an instance");
  const access = args.as_codecast ? CODECAST_TEMPLATE_ACCESS : await callerWorkspace(ctx, userId, args.team_id);
  if (args.as_codecast) await requireCodecastPublisher(ctx, userId);
  const rows: any[] = await ctx.db.query("org_template_lessons").withIndex("by_template_status", (q: any) => q.eq("template_id", args.template_id)).collect();
  // A learned lesson (H12) reaches its publisher without where it came from: no workspace, no instance, no author.
  return rows.filter((l) => l.workspace === access).map((l) => l.source === "learning" ? (({ from_workspace, instance_key, created_by, ...rest }) => rest)(l) : l);
}
export async function performSetLessonStatus(ctx: Ctx, userId: Id<"users">, args: { lesson_id: Id<"org_template_lessons">; status: "accepted" | "declined" | "released"; released_in?: string; task_id?: Id<"tasks"> }) {
  const lesson = await ctx.db.get(args.lesson_id);
  if (!lesson) throw new Error("Lesson not found");
  if (lesson.workspace === CODECAST_TEMPLATE_ACCESS) await requireCodecastPublisher(ctx, userId);
  else if (!(await workspaceGrantsAccess(ctx as any, userId, lesson.workspace))) throw new Error("Lesson not found");
  if (args.status === "released" && !args.released_in) throw new Error("Name the version the lesson shipped in");
  await ctx.db.patch(lesson._id, { status: args.status, released_in: args.released_in, task_id: args.task_id, updated_at: Date.now() });
  return await ctx.db.get(lesson._id);
}

// ── An accepted upgrade waits for the host (H9) ─────────────────────────────

export async function performAcceptUpgrade(ctx: Ctx, userId: Id<"users">, args: { access: WorkspaceKey; instance: string; template_id: string; to: string; digest: string }) {
  const rows: any[] = await ctx.db.query("org_template_instances").withIndex("by_workspace", (q: any) => q.eq("workspace", args.access)).collect();
  const row = rows.find((r) => r.instance === args.instance && r.template_id === args.template_id);
  if (!row) throw new Error(`No instance ${args.instance} of ${args.template_id} in this workspace`);
  const target = { version: args.to, digest: args.digest };
  const release = releaseOf(await visibleTemplate(ctx, args.template_id, args.access, target), target);
  if (!release) throw new Error(`Release ${args.template_id}@${args.to} with this digest is not published`);
  if (release.yanked) throw new Error(`${args.template_id}@${args.to} was yanked by its publisher (${release.yanked.reason})`);
  await ctx.db.patch(row._id, { pending_upgrade: { to: args.to, digest: args.digest, accepted_at: Date.now(), accepted_by: userId }, updated_at: Date.now() });
  return await ctx.db.get(row._id);
}

// ── Withdrawing: yank a release, retire a template ──────────────────────────

export type WithdrawArgs = { template_id: string; team_id?: Id<"teams">; as_codecast?: boolean };
async function ownTemplate(ctx: Ctx, userId: Id<"users">, args: WithdrawArgs) {
  const access = await publisherAccess(ctx, userId, args);
  const row = await templateRow(ctx, args.template_id, access);
  if (!row) throw new Error(`No template ${args.template_id} published in this workspace`);
  return row;
}
/**
 * Withdraw one release, its publisher's act (the same check publish makes).
 * The catalog, a hire and an update never offer it again; `latest` falls back
 * to the newest release nobody withdrew; an instance on it is offered that
 * fallback under any policy (updateFields), marked as a rollback when older.
 */
export async function performYank(ctx: Ctx, userId: Id<"users">, args: WithdrawArgs & { version: string; reason: string }) {
  const reason = args.reason.trim();
  if (reason.length < 8) throw new Error("Say why the release is withdrawn: the instances on it read the reason");
  const row = await ownTemplate(ctx, userId, args);
  const release = row.releases.find((r: any) => r.version === args.version);
  if (!release) throw new Error(`${args.template_id}@${args.version} is not published (published: ${row.releases.map((r: any) => r.version).join(", ")})`);
  if (release.yanked) return { template_id: row.template_id, version: args.version, yanked: release.yanked, latest: row.latest, already: true };
  const now = Date.now();
  const releases = row.releases.map((r: any) => (r === release ? { ...r, yanked: { reason, at: now, by: userId } } : r));
  const fallback = newestGood(releases);
  const patch: Record<string, unknown> = { releases, updated_at: now };
  if (fallback && (fallback.version !== row.latest.version || fallback.digest !== row.latest.digest)) Object.assign(patch, { latest: { version: fallback.version, digest: fallback.digest }, manifest: fallback.manifest, name: fallback.manifest.name, description: fallback.manifest.description, avatar: fallback.manifest.role.avatar });
  await ctx.db.patch(row._id, patch);
  const instances: any[] = await ctx.db.query("org_template_instances").withIndex("by_template", (q: any) => q.eq("template_id", row.template_id)).collect();
  const on = instances.filter((i) => i.version === release.version && i.digest === release.digest && i.phase !== "retired").length;
  return { template_id: row.template_id, version: args.version, yanked: { reason, at: now }, latest: patch.latest ?? row.latest, fallback: fallback?.version ?? null, instances_on_it: on };
}
/** Hide a template from every catalog, or bring it back (`undo`); its instances keep running on their releases. */
export async function performRetire(ctx: Ctx, userId: Id<"users">, args: WithdrawArgs & { reason?: string; undo?: boolean }) {
  const row = await ownTemplate(ctx, userId, args);
  const now = Date.now();
  const retired = args.undo ? undefined : { at: now, by: userId, ...(args.reason?.trim() ? { reason: args.reason.trim() } : {}) };
  await ctx.db.patch(row._id, { retired, updated_at: now });
  return { template_id: row.template_id, workspace: row.workspace, retired: retired ?? null };
}

// ── Activation (H8) ─────────────────────────────────────────────────────────

/**
 * A person activates a routine created paused: one mutation sets the first
 * run one interval out, clears the install's temporary gate and resumes.
 * Human only, like trust and caps (orgRoles.refuseUnlessHuman): a call that
 * carries an api token or a session is refused.
 */
export const activateRoutine = mutation({
  args: {api_token: v.optional(v.string()), from_session: v.optional(v.string()), task_id: v.id("agent_tasks") },
  handler: async (ctx, { api_token, from_session, task_id }) => {
    await refuseUnlessHuman(ctx, { api_token, from_session }, "Activating a routine");
    const userId = await requireCaller(ctx, api_token);
    const task = await getArmableTask(ctx as any, task_id, userId);
    if (!task) throw new Error("Routine not found");
    return applyActivate(ctx as any, task);
  },
});

// ── Wrappers ────────────────────────────────────────────────────────────────

const releaseStatus = v.union(v.literal("draft"), v.literal("canary"), v.literal("stable"));
export const publish = mutation({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")), as_codecast: v.optional(v.boolean()), manifest: v.any(), digest: v.string(), status: v.optional(releaseStatus), changelog: v.optional(v.string()), storage_id: v.optional(v.id("_storage")), review_project_id: v.optional(v.id("projects")), dry_run: v.optional(v.boolean()) },
  handler: async (ctx, { api_token, ...args }) => performPublish(ctx, await requireCaller(ctx, api_token), args),
});
const withdrawArgs = { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")), as_codecast: v.optional(v.boolean()), template_id: v.string() };
export const yank = mutation({
  args: { ...withdrawArgs, version: v.string(), reason: v.string() },
  handler: async (ctx, { api_token, ...args }) => performYank(ctx, await requireCaller(ctx, api_token), args),
});
export const retire = mutation({
  args: { ...withdrawArgs, reason: v.optional(v.string()), undo: v.optional(v.boolean()) },
  handler: async (ctx, { api_token, ...args }) => performRetire(ctx, await requireCaller(ctx, api_token), args),
});
export const catalog = query({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")) },
  handler: async (ctx, { api_token, ...args }) => performCatalog(ctx, await requireCaller(ctx, api_token), args),
});
export const get = query({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")), template_id: v.string() },
  handler: async (ctx, { api_token, ...args }) => performGetTemplate(ctx, await requireCaller(ctx, api_token), args),
});
export const release = query({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")), template_id: v.string(), version: v.string(), digest: v.string() },
  handler: async (ctx, { api_token, ...args }) => performRelease(ctx, await requireCaller(ctx, api_token), args),
});
const sealedSecret = v.object({ key: v.string(), payload: v.object({ provider: v.string(), epk: v.string(), iv: v.string(), ct: v.string() }) });
export const requestBind = mutation({
  args: { api_token: v.optional(v.string()), from_session: v.optional(v.string()), instance_key: v.string(), secrets: v.optional(v.array(sealedSecret)), device_id: v.optional(v.string()) },
  handler: async (ctx, { api_token, from_session, ...args }) => {
    await refuseUnlessHuman(ctx, { api_token, from_session }, "Host step");
    return performRequestBind(ctx, await requireCaller(ctx, api_token), args);
  },
});
export const upsertInstance = mutation({
  args: {
    api_token: v.optional(v.string()), instance_key: v.string(), instance: v.string(), template_id: v.string(), version: v.string(), digest: v.string(), project_id: v.id("projects"),
    role_id: v.optional(v.id("org_roles")), host: v.optional(v.object({ machine: v.string(), dir: v.string() })),
    phase: v.optional(v.union(v.literal("awaiting_host"), v.literal("ready"), v.literal("upgrading"), v.literal("retired"))),
    update_policy: v.optional(v.union(v.literal("manual"), v.literal("canary"), v.literal("stable"))),
    config: v.optional(v.record(v.string(), v.string())),
    bindings: v.optional(v.record(v.string(), v.object({ host: v.string(), path_hash: v.string(), bound_at: v.number() }))),
    ledgers: v.optional(v.record(v.string(), v.object({ taskId: v.string(), shortId: v.string() }))),
    routines: v.optional(v.record(v.string(), v.object({ triggerId: v.optional(v.string()), external: v.optional(v.boolean()), retired: v.optional(v.boolean()) }))),
    setup_text: v.optional(v.record(v.string(), v.object({ title: v.string(), price: v.optional(v.string()), guide: v.optional(v.string()) }))),
    from_session: v.optional(v.string()),
  },
  handler: async (ctx, { api_token, ...args }) => performUpsertInstance(ctx, await requireCaller(ctx, api_token), args),
});
export const recordEvidenceCheck = mutation({
  args: { api_token: v.optional(v.string()), instance_key: v.string(), check: v.string(), status: v.string(), source: v.optional(v.string()), detail: v.optional(v.array(v.string())) },
  handler: async (ctx, { api_token, ...args }) => performRecordEvidence(ctx, await requireCaller(ctx, api_token), args),
});
export const report = mutation({
  args: { api_token: v.optional(v.string()), instance_key: v.string(), entries: v.array(v.string()), source: v.optional(v.string()), observed_at: v.optional(v.number()) },
  handler: async (ctx, { api_token, ...args }) => performRecordScores(ctx, await requireCaller(ctx, api_token), args),
});
export const setup = mutation({
  args: { api_token: v.optional(v.string()), instance_key: v.string(), id: v.string(), status: v.string(), evidence: v.optional(v.string()), from_agent: v.boolean() },
  handler: async (ctx, { api_token, ...args }) => performMarkSetup(ctx, await requireCaller(ctx, api_token), args),
});
export const instanceStatus = query({
  args: { api_token: v.optional(v.string()), instance_key: v.string() },
  handler: async (ctx, { api_token, ...args }) => performInstanceStatus(ctx, await requireCaller(ctx, api_token), args),
});
export const instanceForRole = query({
  args: { api_token: v.optional(v.string()), role_id: v.id("org_roles") },
  handler: async (ctx, { api_token, ...args }) => performInstanceForRole(ctx, await requireCaller(ctx, api_token), args),
});
export const listInstances = query({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")), template_id: v.optional(v.string()) },
  handler: async (ctx, { api_token, ...args }) => performListInstances(ctx, await requireCaller(ctx, api_token), args),
});
export const fileLesson = mutation({
  args: { api_token: v.optional(v.string()), instance_key: v.string(), body: v.string(), evidence: v.optional(v.array(v.object({ label: v.string(), href: v.string() }))) },
  handler: async (ctx, { api_token, ...args }) => performFileLesson(ctx, await requireCaller(ctx, api_token), args),
});
export const listLessons = query({
  args: { api_token: v.optional(v.string()), template_id: v.optional(v.string()), instance_key: v.optional(v.string()), team_id: v.optional(v.id("teams")), as_codecast: v.optional(v.boolean()) },
  handler: async (ctx, { api_token, ...args }) => performListLessons(ctx, await requireCaller(ctx, api_token), args),
});
export const setLessonStatus = mutation({
  args: { api_token: v.optional(v.string()), lesson_id: v.id("org_template_lessons"), status: v.union(v.literal("accepted"), v.literal("declined"), v.literal("released")), released_in: v.optional(v.string()), task_id: v.optional(v.id("tasks")) },
  handler: async (ctx, { api_token, ...args }) => performSetLessonStatus(ctx, await requireCaller(ctx, api_token), args),
});
