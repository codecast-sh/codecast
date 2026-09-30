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
import { applyActivate, getManageableTask } from "./agentTasks";
import { refuseUnlessHuman, standingConversationOf } from "./orgRoles";
import { DEVICE_ONLINE_MS, pickOwnerDevice } from "./deviceRouting";
import type { OrgTemplateBindArgs, OrgTemplateBindResult, OrgTemplateBindSecret } from "@codecast/shared/contracts/orgTemplateBind";

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
  // A release can be installed from the record only when publish uploaded its
  // snapshot (H1); a manifest alone lets a person read the template, not hire it.
  const latest = row.releases.find((r: any) => r.version === row.latest.version && r.digest === row.latest.digest);
  return {
    template_id: row.template_id, workspace: row.workspace, name: row.name, description: row.description, avatar: row.avatar,
    latest: row.latest, installable: !!latest?.storage_id, latest_status: latest?.status ?? null, changelog: latest?.changelog ?? null,
    releases: row.releases.map((r: any) => ({ version: r.version, status: r.status, published_at: r.published_at, installable: !!r.storage_id })),
    asks: { inputs: (m.inputs ?? []).length, secrets: (m.inputs ?? []).filter((i) => i.kind === "secret").length, authority: (m.authority ?? []).length, setup: (m.setup ?? []).length, routines: m.routines.length },
    manifest: m,
  };
}
export async function performGetTemplate(ctx: Ctx, userId: Id<"users">, args: { template_id: string; team_id?: Id<"teams"> }) {
  const row = await visibleTemplate(ctx, args.template_id, await callerWorkspace(ctx, userId, args.team_id));
  if (!row) throw new Error("Template not found");
  return catalogEntry(row);
}
/** One published release for the host step (H1, install from the record): its manifest and the snapshot's download URL, or null when publish uploaded none. */
export async function performRelease(ctx: Ctx, userId: Id<"users">, args: { template_id: string; version: string; digest: string; team_id?: Id<"teams"> }) {
  const row = await visibleTemplate(ctx, args.template_id, await callerWorkspace(ctx, userId, args.team_id));
  if (!row) throw new Error("Template not found");
  const release = row.releases.find((r: any) => r.version === args.version && r.digest === args.digest);
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
    updated_at: now,
  };
  if (existing) {
    if (existing.workspace !== access || String(existing.project_id) !== String(args.project_id)) throw new Error("Instance belongs to another project or workspace");
    await ctx.db.patch(existing._id, { ...fields, instance_key: args.instance_key, phase: args.phase ?? existing.phase, update_policy: args.update_policy ?? existing.update_policy });
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
/** The instance record plus the authority its role holds (org_roles.authority), for readiness. */
const stateOf = (row: any, role?: any): InstanceState => ({ evidence: row.evidence, scoreboard: row.scoreboard, setup: row.setup, authority: (role?.authority ?? []).map((g: any) => ({ id: g.id, expires_at: g.expires_at })) });

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
  const state = stateOf(row, role);
  return { ...row, trust: role?.trust ?? "understand", authority: role?.authority ?? [], handle: role?.handle, setup: setupRows(manifest, state), ask: nextHumanAsk(manifest, state), readiness: readiness(manifest, state, role?.trust ?? "understand") };
}
export async function performListInstances(ctx: Ctx, userId: Id<"users">, args: { team_id?: Id<"teams">; template_id?: string }) {
  const access = await callerWorkspace(ctx, userId, args.team_id);
  const rows: any[] = await ctx.db.query("org_template_instances").withIndex("by_workspace", (q: any) => q.eq("workspace", access)).collect();
  return rows.filter((r) => !args.template_id || r.template_id === args.template_id);
}
/** The role page's read (H11): the instance a role was hired as, with its status, or null for an ordinary role. */
export async function performInstanceForRole(ctx: Ctx, userId: Id<"users">, args: { role_id: Id<"org_roles"> }) {
  const rows: any[] = await ctx.db.query("org_template_instances").withIndex("by_role", (q: any) => q.eq("role_id", args.role_id)).collect();
  const row = rows.find((r) => r.phase !== "retired") ?? rows[0];
  if (!row || !(await workspaceGrantsAccess(ctx as any, userId, row.workspace))) return null;
  const status = await performInstanceStatus(ctx, userId, { instance_key: row.instance_key });
  const template = await visibleTemplate(ctx, row.template_id, row.workspace);
  const latest = template?.releases.filter((r: any) => r.status === "stable").map((r: any) => r.version).sort(compareVersions).at(-1);
  const pinned = template?.releases.find((r: any) => r.version === row.version && r.digest === row.digest)?.manifest as OrgTemplate | undefined;
  const routines = [] as any[];
  for (const r of pinned?.routines ?? []) {
    const bound = row.routines?.[r.id];
    const trigger = bound?.triggerId ? await ctx.db.get(bound.triggerId as Id<"agent_tasks">) : null;
    routines.push({ id: r.id, title: r.title, every: r.every, mode: r.mode ?? "propose", external: !!bound?.external, retired: !!bound?.retired, trigger: trigger ? { id: String(trigger._id), short_id: trigger.short_id, status: trigger.status, run_at: trigger.run_at, precheck: trigger.precheck, interval_ms: trigger.interval_ms } : null });
  }
  const secrets = (pinned?.inputs ?? []).filter((i) => i.kind === "secret").map((i) => ({ key: i.key, label: i.label, bound: !!row.bindings?.[i.key] }));
  const scoreboard = (pinned?.scoreboard ?? []).map((k) => ({ ...k, ...(row.scoreboard?.[k.key] ?? {}) }));
  // The host step from the web (H3): the machine it would run on and how the
  // last request went, so the page shows one button and its progress.
  const bind_host = await bindHostOf(ctx, userId, row);
  const host_step = await hostStepOf(ctx, row);
  return { ...status, routines, secrets, scoreboard, bind_host: { device: bind_host.device, dir: bind_host.dir, reason: bind_host.reason }, host_step, template: template ? { name: template.name, avatar: template.avatar, latest_stable: latest, changelog: template.releases.find((r: any) => r.version === latest)?.changelog } : null, update_available: latest && row.update_policy === "stable" && compareVersions(latest, row.version) > 0 ? latest : null };
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

// ── An accepted upgrade waits for the host (H9) ─────────────────────────────

export async function performAcceptUpgrade(ctx: Ctx, userId: Id<"users">, args: { access: WorkspaceKey; instance: string; template_id: string; to: string; digest: string }) {
  const rows: any[] = await ctx.db.query("org_template_instances").withIndex("by_workspace", (q: any) => q.eq("workspace", args.access)).collect();
  const row = rows.find((r) => r.instance === args.instance && r.template_id === args.template_id);
  if (!row) throw new Error(`No instance ${args.instance} of ${args.template_id} in this workspace`);
  const template = await visibleTemplate(ctx, args.template_id, args.access);
  if (!template?.releases.some((r: any) => r.version === args.to && r.digest === args.digest)) throw new Error(`Release ${args.template_id}@${args.to} with this digest is not published`);
  await ctx.db.patch(row._id, { pending_upgrade: { to: args.to, digest: args.digest, accepted_at: Date.now(), accepted_by: userId }, updated_at: Date.now() });
  return await ctx.db.get(row._id);
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
    const task = await getManageableTask(ctx as any, task_id, userId);
    if (!task) throw new Error("Routine not found");
    return applyActivate(ctx as any, task);
  },
});

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
