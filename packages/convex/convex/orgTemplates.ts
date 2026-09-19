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
import { getAuthenticatedUserId } from "./pendingMessages";
import { canAccessProject, requireTeamAdmin, requireTeamMembership, resolveWorkspaceKey, workspaceGrantsAccess, workspaceKey, type WorkspaceKey } from "./lib/access";
import { validateTemplate, type OrgTemplate } from "@codecast/shared/contracts/orgTemplateManifest";
import { markSetup, nextHumanAsk, readiness, recordEvidence, recordScores, setupRows, type InstanceState } from "@codecast/shared/contracts/orgTemplateState";

/** The one value beside a workspace key that grants visibility: a template every workspace may hire. */
export const CODECAST_TEMPLATE_ACCESS = "codecast";
const RELEASE_STATUSES = ["draft", "canary", "stable"] as const;
type ReleaseStatus = (typeof RELEASE_STATUSES)[number];
const digestRe = /^[a-f0-9]{64}$/;

type Ctx = { db: any; storage?: any };

async function requireCaller(ctx: Ctx, apiToken?: string): Promise<Id<"users">> {
  const userId = await getAuthenticatedUserId(ctx, apiToken);
  if (!userId) throw new Error("Authentication failed: invalid token or session");
  return userId;
}

/** The key a caller publishes or hires under: a team they belong to, else their own. */
async function callerWorkspace(ctx: Ctx, userId: Id<"users">, teamId?: Id<"teams">): Promise<WorkspaceKey> {
  if (teamId) { await requireTeamMembership(ctx as any, userId, teamId); return workspaceKey({ type: "team", teamId }); }
  return workspaceKey({ type: "personal", userId });
}

/** Publishing as Codecast is the Codecast team's admins' act; the team is named on the deployment. */
async function requireCodecastPublisher(ctx: Ctx, userId: Id<"users">): Promise<void> {
  const teamId = process.env.CODECAST_TEMPLATES_TEAM_ID as Id<"teams"> | undefined;
  if (!teamId) throw new Error("Publishing as codecast is not enabled on this deployment (CODECAST_TEMPLATES_TEAM_ID)");
  await requireTeamAdmin(ctx as any, userId, teamId);
}

async function templateRow(ctx: Ctx, templateId: string, access: WorkspaceKey): Promise<any> {
  const rows: any[] = await ctx.db.query("org_templates").withIndex("by_template_id", (q: any) => q.eq("template_id", templateId)).collect();
  return rows.find((r) => r.workspace === access) ?? null;
}
/** The template a viewer in `access` may hire: their own workspace's, else Codecast's. */
async function visibleTemplate(ctx: Ctx, templateId: string, access: WorkspaceKey): Promise<any> {
  return (await templateRow(ctx, templateId, access)) ?? (await templateRow(ctx, templateId, CODECAST_TEMPLATE_ACCESS));
}

// ── Publish and catalog (H1) ────────────────────────────────────────────────

export type PublishArgs = { team_id?: Id<"teams">; as_codecast?: boolean; manifest: unknown; digest: string; status?: ReleaseStatus; changelog?: string; storage_id?: Id<"_storage">; review_project_id?: Id<"projects"> };

/**
 * Write or advance a template from a validated manifest and its release
 * digest. Same version with another digest is refused; the same version and
 * digest again only moves its status or changelog. A new version becomes
 * latest and its manifest replaces the row's.
 */
export async function performPublish(ctx: Ctx, userId: Id<"users">, args: PublishArgs) {
  const manifest = validateTemplate(args.manifest);
  if (!digestRe.test(args.digest)) throw new Error("digest must be a SHA-256 hex string");
  const status: ReleaseStatus = args.status ?? "draft";
  if (!RELEASE_STATUSES.includes(status)) throw new Error("status must be draft, canary or stable");
  let access: WorkspaceKey;
  if (args.as_codecast) { await requireCodecastPublisher(ctx, userId); access = CODECAST_TEMPLATE_ACCESS; }
  else access = await callerWorkspace(ctx, userId, args.team_id);
  if (args.review_project_id) {
    const project = await ctx.db.get(args.review_project_id);
    if (!project || !(await canAccessProject(ctx as any, userId, project))) throw new Error("Review project not found");
  }
  const now = Date.now();
  const existing = await templateRow(ctx, manifest.id, access);
  const release = { version: manifest.version, digest: args.digest, status, changelog: args.changelog, storage_id: args.storage_id, manifest, published_at: now, published_by: userId };
  if (!existing) {
    const id = await ctx.db.insert("org_templates", {
      template_id: manifest.id, workspace: access, name: manifest.name, description: manifest.description, avatar: manifest.role.avatar,
      latest: { version: manifest.version, digest: args.digest }, releases: [release], manifest, review_project_id: args.review_project_id,
      created_by: userId, created_at: now, updated_at: now,
    });
    return { ...(await ctx.db.get(id)), action: "created" as const };
  }
  const same = existing.releases.find((r: any) => r.version === manifest.version);
  if (same && same.digest !== args.digest) throw new Error(`Version ${manifest.version} is already published with different content; publish a new version`);
  const releases = same
    ? existing.releases.map((r: any) => (r.version === manifest.version ? { ...r, status, changelog: args.changelog ?? r.changelog, storage_id: args.storage_id ?? r.storage_id } : r))
    : [...existing.releases, release];
  const advances = !same && compareVersions(manifest.version, existing.latest.version) > 0;
  const patch: Record<string, unknown> = { releases, updated_at: now, ...(args.review_project_id ? { review_project_id: args.review_project_id } : {}) };
  if (advances || (same && manifest.version === existing.latest.version)) Object.assign(patch, { latest: { version: manifest.version, digest: args.digest }, manifest, name: manifest.name, description: manifest.description, avatar: manifest.role.avatar });
  await ctx.db.patch(existing._id, patch);
  return { ...(await ctx.db.get(existing._id)), action: same ? ("updated" as const) : ("released" as const) };
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  return 0;
}

/** What the hire form lists: a viewer's own templates and Codecast's, with what each asks for. */
export async function performCatalog(ctx: Ctx, userId: Id<"users">, args: { team_id?: Id<"teams"> }) {
  const access = await callerWorkspace(ctx, userId, args.team_id);
  const own: any[] = await ctx.db.query("org_templates").withIndex("by_workspace", (q: any) => q.eq("workspace", access)).collect();
  const shared: any[] = access === CODECAST_TEMPLATE_ACCESS ? [] : await ctx.db.query("org_templates").withIndex("by_workspace", (q: any) => q.eq("workspace", CODECAST_TEMPLATE_ACCESS)).collect();
  return [...own, ...shared].map(catalogEntry);
}
export function catalogEntry(row: any) {
  const m = row.manifest as OrgTemplate;
  return {
    template_id: row.template_id, workspace: row.workspace, name: row.name, description: row.description, avatar: row.avatar,
    latest: row.latest, releases: row.releases.map((r: any) => ({ version: r.version, status: r.status, published_at: r.published_at })),
    asks: { inputs: (m.inputs ?? []).length, secrets: (m.inputs ?? []).filter((i) => i.kind === "secret").length, authority: (m.authority ?? []).length, setup: (m.setup ?? []).length, routines: m.routines.length },
    manifest: m,
  };
}
export async function performGetTemplate(ctx: Ctx, userId: Id<"users">, args: { template_id: string; team_id?: Id<"teams"> }) {
  const row = await visibleTemplate(ctx, args.template_id, await callerWorkspace(ctx, userId, args.team_id));
  if (!row) throw new Error("Template not found");
  return catalogEntry(row);
}

// ── The instance row (H1, H3) ───────────────────────────────────────────────

export type UpsertInstanceArgs = {
  instance_key: string; instance: string; template_id: string; version: string; digest: string; project_id: Id<"projects">;
  role_id?: Id<"org_roles">; host?: { machine: string; dir: string }; phase?: "awaiting_host" | "ready" | "upgrading" | "retired"; update_policy?: "manual" | "canary" | "stable";
  config?: Record<string, string>; bindings?: Record<string, { host: string; path_hash: string; bound_at: number }>; ledgers?: Record<string, { taskId: string; shortId: string }>;
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
  const template = await visibleTemplate(ctx, args.template_id, access);
  if (!template) throw new Error(`Template ${args.template_id} is not available to this workspace`);
  const release = template.releases.find((r: any) => r.version === args.version && r.digest === args.digest);
  if (!release) throw new Error(`Release ${args.template_id}@${args.version} with this digest is not published`);
  const manifest = template.manifest as OrgTemplate;
  const secrets = new Set((manifest.inputs ?? []).filter((i) => i.kind === "secret").map((i) => i.key));
  for (const key of Object.keys(args.config ?? {})) if (secrets.has(key)) throw new Error(`Secret input ${key} is bound on the host, never stored as an answer`);
  if (args.role_id) {
    const role = await ctx.db.get(args.role_id);
    if (!role || role.status === "retired" || !(role.scope?.project_ids ?? []).some((id: any) => String(id) === String(args.project_id))) throw new Error("Role not found or does not lead this project");
  }
  const now = Date.now();
  const existing = await ctx.db.query("org_template_instances").withIndex("by_instance_key", (q: any) => q.eq("instance_key", args.instance_key)).first();
  const fields = {
    instance: args.instance, template_id: args.template_id, version: args.version, digest: args.digest, project_id: args.project_id,
    ...(args.role_id ? { role_id: args.role_id } : {}), ...(args.host ? { host: args.host } : {}),
    ...(args.config ? { config: args.config } : {}), ...(args.bindings ? { bindings: args.bindings } : {}), ...(args.ledgers ? { ledgers: args.ledgers } : {}),
    updated_at: now,
  };
  if (existing) {
    if (existing.workspace !== access || String(existing.project_id) !== String(args.project_id)) throw new Error("Instance belongs to another project or workspace");
    await ctx.db.patch(existing._id, { ...fields, phase: args.phase ?? existing.phase, update_policy: args.update_policy ?? existing.update_policy });
    return await ctx.db.get(existing._id);
  }
  const id = await ctx.db.insert("org_template_instances", { instance_key: args.instance_key, workspace: access, phase: args.phase ?? "ready", update_policy: args.update_policy ?? "manual", ...fields, created_by: userId, created_at: now });
  return await ctx.db.get(id);
}

async function instanceFor(ctx: Ctx, userId: Id<"users">, instanceKey: string): Promise<{ row: any; manifest: OrgTemplate }> {
  const row = await ctx.db.query("org_template_instances").withIndex("by_instance_key", (q: any) => q.eq("instance_key", instanceKey)).first();
  if (!row || !(await workspaceGrantsAccess(ctx as any, userId, row.workspace))) throw new Error("Instance not found");
  const template = await visibleTemplate(ctx, row.template_id, row.workspace);
  if (!template) throw new Error("The instance's template is no longer available");
  // The instance runs its pinned release; the template's latest manifest may differ.
  const release = template.releases.find((r: any) => r.version === row.version && r.digest === row.digest);
  if (!release) throw new Error("The instance's pinned release is no longer published");
  return { row, manifest: release.manifest as OrgTemplate };
}
const stateOf = (row: any): InstanceState => ({ evidence: row.evidence, scoreboard: row.scoreboard, setup: row.setup, authority: row.authority });

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
  const { row, manifest } = await instanceFor(ctx, userId, args.instance_key);
  const role = row.role_id ? await ctx.db.get(row.role_id) : null;
  const state = stateOf(row);
  return { ...row, trust: role?.trust ?? "understand", setup: setupRows(manifest, state), ask: nextHumanAsk(manifest, state), readiness: readiness(manifest, state, role?.trust ?? "understand") };
}
export async function performListInstances(ctx: Ctx, userId: Id<"users">, args: { team_id?: Id<"teams">; template_id?: string }) {
  const access = await callerWorkspace(ctx, userId, args.team_id);
  const rows: any[] = await ctx.db.query("org_template_instances").withIndex("by_workspace", (q: any) => q.eq("workspace", access)).collect();
  return rows.filter((r) => !args.template_id || r.template_id === args.template_id);
}

// ── Lessons (H9) ────────────────────────────────────────────────────────────

/** A lesson leaves the hiring workspace as a row the publisher sees; the writer keeps only its status. */
export async function performFileLesson(ctx: Ctx, userId: Id<"users">, args: { instance_key: string; body: string; evidence?: { label: string; href: string }[] }) {
  const { row } = await instanceFor(ctx, userId, args.instance_key);
  const body = args.body.trim();
  if (body.length < 20) throw new Error("Say what was learned, with its evidence: at least a sentence");
  if (body.length > 20000) throw new Error("A lesson is a proposal, not a report; keep it under 20000 characters");
  for (const e of args.evidence ?? []) if (!e.label.trim() || !/^(https?:\/\/|ct-\d+|pl-\d+|tr-\d+|doc:[a-z0-9]+|jx[a-z0-9]+)/i.test(e.href)) throw new Error("Each evidence entry needs a label and a link or short id");
  const template = await visibleTemplate(ctx, row.template_id, row.workspace);
  const now = Date.now();
  const id = await ctx.db.insert("org_template_lessons", {
    template_id: row.template_id, workspace: template.workspace, from_workspace: row.workspace, instance_key: row.instance_key,
    release: { version: row.version, digest: row.digest }, body, evidence: args.evidence ?? [], status: "open", created_by: userId, created_at: now, updated_at: now,
  });
  const lesson = await ctx.db.get(id);
  return { id: lesson._id, status: lesson.status, created_at: lesson.created_at };
}
/** The publisher reads its lessons; an instance reads the status of its own. */
export async function performListLessons(ctx: Ctx, userId: Id<"users">, args: { template_id?: string; instance_key?: string; team_id?: Id<"teams">; as_codecast?: boolean }) {
  if (args.instance_key) {
    const { row } = await instanceFor(ctx, userId, args.instance_key);
    const rows: any[] = await ctx.db.query("org_template_lessons").withIndex("by_instance", (q: any) => q.eq("instance_key", row.instance_key)).collect();
    return rows.map((l) => ({ id: l._id, status: l.status, released_in: l.released_in, created_at: l.created_at, body: l.body }));
  }
  if (!args.template_id) throw new Error("Name a template or an instance");
  const access = args.as_codecast ? CODECAST_TEMPLATE_ACCESS : await callerWorkspace(ctx, userId, args.team_id);
  if (args.as_codecast) await requireCodecastPublisher(ctx, userId);
  const rows: any[] = await ctx.db.query("org_template_lessons").withIndex("by_template_status", (q: any) => q.eq("template_id", args.template_id)).collect();
  return rows.filter((l) => l.workspace === access);
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

// ── Wrappers ────────────────────────────────────────────────────────────────

const releaseStatus = v.union(v.literal("draft"), v.literal("canary"), v.literal("stable"));
export const publish = mutation({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")), as_codecast: v.optional(v.boolean()), manifest: v.any(), digest: v.string(), status: v.optional(releaseStatus), changelog: v.optional(v.string()), storage_id: v.optional(v.id("_storage")), review_project_id: v.optional(v.id("projects")) },
  handler: async (ctx, { api_token, ...args }) => performPublish(ctx, await requireCaller(ctx, api_token), args),
});
export const catalog = query({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")) },
  handler: async (ctx, { api_token, ...args }) => performCatalog(ctx, await requireCaller(ctx, api_token), args),
});
export const get = query({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")), template_id: v.string() },
  handler: async (ctx, { api_token, ...args }) => performGetTemplate(ctx, await requireCaller(ctx, api_token), args),
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
