import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { applyProposalChanges, extractOrgProposal, orgProposalBlock, ORG_PROPOSAL_OPTIONS, type OrgRoleProposal } from "@codecast/shared/contracts/orgProposal";
import type { OrgInitDeps } from "./orgInit.js";
import { acquireFileLock } from "./lockFile.js";
import { sessionIdFromEnv } from "./sessionIdentity.js";
import { atomicJson, canonicalDirectory, checkReleaseVersion, freezeArtifact, inputToken, inputTokens, intervalMs, noSymlink, readArtifact, releaseRoot, substitute, templateSlug, type OrgTemplate, type TemplateArtifact } from "./orgTemplateArtifact.js";
import { writeInstanceFile } from "./orgTemplateInstance.js";
import { markSetup, nextHumanAsk, readiness, readinessHeader, recordEvidence, recordScores, setupRows, type InstanceState } from "./orgTemplateState.js";

export type TemplateOptions = { dir: string; project?: string; team?: string; personal?: boolean; session?: string; adopt?: string[]; input?: string[]; secret?: string[]; reportsTo?: string; apply?: boolean; dryRun?: boolean; status?: string; source?: string; detail?: string[]; evidence?: string; observedAt?: string; done?: boolean; skip?: boolean; open?: boolean };
export type TemplateReceipt = InstanceState & {
  schemaVersion: 1;
  instance: string;
  key: string;
  template: { id: string; version: string; hash: string; root: string };
  project: { id: string; ref: string; name: string; dir: string; registeredDir?: string | null };
  workspace: { kind: "team" | "user"; id: string };
  sourceSession: string;
  phase: "proposal" | "declined" | "provisioning" | "upgrading" | "ready";
  warnings?: string[];
  upgrade?: TemplateUpgrade;
  stack: { title: string; attempted?: boolean; id?: string; decisionAttempted?: boolean; decisionId?: string };
  proposal: OrgRoleProposal;
  /** Hire-time answers to the manifest's inputs (org-hire.md H2, H3); secrets are bound on the host, never answered here. */
  config?: Record<string, string>;
  /** Secret inputs bound on this host (H4): the path's hash, never the path's contents. */
  bindings?: Record<string, { host: string; path_hash: string; bound_at: number }>;
  /** Ledger tasks (H7), one per manifest ledger, found or created by marker. */
  ledgers?: Record<string, { taskId: string; shortId: string }>;
  /** The server's instance row (org_template_instances), once the host step registered it. */
  instanceId?: string;
  role?: { id: string; handle: string; sessionId?: string };
  routines: Record<string, { triggerId?: string; attempted?: boolean; external?: boolean; paused?: boolean; retired?: boolean; actualIntervalMs?: number; every: string }>;
};
type TemplateUpgrade = {
  from: TemplateReceipt["template"];
  to: TemplateReceipt["template"];
  direction: "forward" | "rollback";
  originalRoutines: TemplateReceipt["routines"];
  added: string[];
  removed: string[];
  cadence: Record<string, { triggerId: string; before: number; after: number }>;
};
export const quoteTemplateArg = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
export function receiptPath(dir: string, instance: string): string {
  if (!templateSlug(instance)) throw new Error("Instance must be a lowercase slug (at most 48 characters)");
  const file = path.join(canonicalDirectory(dir), ".codecast", "org-templates", `${instance}.json`);
  noSymlink(file);
  return file;
}
export function readReceipt(dir: string, instance: string): TemplateReceipt {
  const value = JSON.parse(fs.readFileSync(receiptPath(dir, instance), "utf8")) as TemplateReceipt;
  if (value.schemaVersion !== 1 || value.instance !== instance || !value.key || !value.project?.id || !value.project.ref || value.project.dir !== canonicalDirectory(dir) || !value.workspace?.id || !["team", "user"].includes(value.workspace.kind) || !value.stack?.title || !value.routines || !value.proposal) throw new Error("Invalid template receipt or project directory mismatch");
  if (value.template.root !== releaseRoot(value.project.dir, value.template)) throw new Error("Receipt points outside its pinned release directory");
  return value;
}
function verifiedArtifact(receipt: TemplateReceipt): TemplateArtifact {
  noSymlink(receipt.template.root);
  const artifact = readArtifact(receipt.template.root);
  if (artifact.hash !== receipt.template.hash || artifact.manifest.id !== receipt.template.id || artifact.manifest.version !== receipt.template.version) throw new Error("Pinned template artifact failed verification");
  return artifact;
}
function values(receipt: TemplateReceipt, manifest?: Pick<OrgTemplate, "inputs">): Record<string, string> {
  const base: Record<string, string> = { instance: receipt.instance, "project.ref": receipt.project.ref, "project.name": receipt.project.name, "project.dir": receipt.project.dir, "template.root": receipt.template.root, "instance.file": receiptPath(receipt.project.dir, receipt.instance) };
  // Every declared input substitutes: the answer, or the empty string for an
  // unanswered optional one (a required one never reaches here unanswered).
  for (const input of manifest?.inputs ?? []) base[inputToken(input.key)] = receipt.config?.[input.key] ?? "";
  return base;
}
/**
 * Parse `--input key=value` answers against the manifest (org-hire.md H2):
 * unknown keys refused; secrets refused (bound on the host, never typed);
 * numbers and money numeric; booleans true/false; choices from the list;
 * every required non-secret input answered. Returns the answers keyed by input.
 */
export function parseInputs(manifest: OrgTemplate, raw: string[] = []): Record<string, string> {
  const declared = new Map((manifest.inputs ?? []).map((input) => [input.key, input]));
  const config: Record<string, string> = {};
  for (const entry of raw) {
    const at = entry.indexOf("=");
    if (at <= 0) throw new Error(`Input must be key=value: ${entry}`);
    const key = entry.slice(0, at);
    const value = entry.slice(at + 1);
    const input = declared.get(key);
    if (!input) throw new Error(`Unknown input: ${key}`);
    if (input.kind === "secret") throw new Error(`Secret input ${key} is bound on the host with --secret, never answered as text`);
    if (key in config) throw new Error(`Input answered twice: ${key}`);
    if (value.includes("\0") || value.includes("{{") || value.includes("}}")) throw new Error(`Invalid value for ${key}`);
    if ((input.kind === "number" || input.kind === "money") && (!/^-?\d+(\.\d+)?$/.test(value) || (input.kind === "money" && Number(value) < 0))) throw new Error(`${key} must be a number`);
    if (input.kind === "boolean" && value !== "true" && value !== "false") throw new Error(`${key} must be true or false`);
    if (input.kind === "choice" && !input.choices!.includes(value)) throw new Error(`${key} must be one of: ${input.choices!.join(", ")}`);
    config[key] = value;
  }
  for (const input of declared.values()) {
    if (input.kind === "secret" || key_in(config, input.key)) continue;
    if (input.default !== undefined) config[input.key] = String(input.default);
    else if (input.required) throw new Error(`Required input not answered: ${input.key}`);
  }
  return config;
}
const key_in = (row: Record<string, string>, key: string) => Object.prototype.hasOwnProperty.call(row, key);
export function loaderPrompt(receipt: TemplateReceipt, routine: string): string {
  return `Read the pinned instance receipt ${receiptPath(receipt.project.dir, receipt.instance)}. Run this command before doing any work:\n\ncast org template instructions ${quoteTemplateArg(receipt.instance)} ${quoteTemplateArg(routine)} --dir ${quoteTemplateArg(receipt.project.dir)}\n\nUse only the verified instructions it returns. If verification fails, stop and report the error. The role's human charter, trust, grants and project scope still apply. This loader grants no spending, publishing, credentials or filesystem isolation.`;
}
async function request(deps: OrgInitDeps, endpoint: string, body: Record<string, unknown>): Promise<any> {
  const result = await deps.cliPost(endpoint, body);
  if (result == null || result.error) throw new Error(result?.error || `${endpoint}: empty response`);
  return result;
}
function boundary(receipt: TemplateReceipt): { team_id?: string } {
  return receipt.workspace.kind === "team" ? { team_id: receipt.workspace.id } : {};
}
function sameWorkspace(actual: any, expected: TemplateReceipt["workspace"]): void {
  if (!actual || actual.kind !== expected.kind || actual.id !== expected.id) throw new Error("Workspace does not match the instance receipt");
}
async function currentWorkspace(deps: OrgInitDeps, options: Pick<TemplateOptions, "team" | "personal">): Promise<any> {
  if (!!options.team === !!options.personal) throw new Error("Select exactly one explicit workspace: --team or --personal");
  const ws = options.personal ? { kind: "personal" as const } : await deps.readWorkspace(options.team);
  const args = deps.workspaceArgs(ws);
  if (ws.kind === "team" && !args.team_id) throw new Error("Team workspace is unresolved");
  const tree = await request(deps, "/cli/org/tree", args);
  if (!tree.workspace?.id || !["team", "user"].includes(tree.workspace.kind)) throw new Error("Workspace is unresolved");
  if ((ws.kind === "team") !== (tree.workspace.kind === "team") || (args.team_id && tree.workspace.id !== args.team_id)) throw new Error("Workspace resolution mismatch");
  return tree;
}
async function verifiedProject(deps: OrgInitDeps, tree: any, dir: string, ref: string): Promise<TemplateReceipt["project"]> {
  const project = await request(deps, "/cli/projects/get", { id: ref });
  if (project._id !== ref || project.workspace !== `${tree.workspace.kind}:${tree.workspace.id}`) throw new Error("Explicit project is outside the selected workspace");
  return { id: project._id, ref: project.short_id || project._id, name: project.title, dir, registeredDir: project.project_path ?? null };
}
async function checkContext(deps: OrgInitDeps, receipt: TemplateReceipt, options: TemplateOptions): Promise<any> {
  verifiedArtifact(receipt);
  const tree = await currentWorkspace(deps, options.team || options.personal ? options : receipt.workspace.kind === "team" ? { team: receipt.workspace.id } : { personal: true });
  sameWorkspace(tree.workspace, receipt.workspace);
  const project = await verifiedProject(deps, tree, receipt.project.dir, options.project || receipt.project.id);
  if (project.id !== receipt.project.id) throw new Error("Project does not match the instance receipt");
  const warnings = projectWarnings(project);
  if (project.registeredDir !== receipt.project.registeredDir) warnings.push("The project's registered path changed since approval; this instance remains pinned to its approved local directory.");
  return { ...tree, templateWarnings: warnings };
}
function projectWarnings(project: TemplateReceipt["project"]): string[] {
  return project.registeredDir === project.dir ? [] : [`Project registered path is ${project.registeredDir || "not set"}; this host will use the explicitly selected directory ${project.dir}, subject to the human role decision.`];
}
function save(receipt: TemplateReceipt): void { atomicJson(receiptPath(receipt.project.dir, receipt.instance), receipt); }
async function locked<T>(dir: string, instance: string, work: () => Promise<T>): Promise<T> {
  const lock = receiptPath(dir, instance) + ".lock";
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  noSymlink(lock);
  const release = await acquireFileLock(lock, { staleMs: Infinity, waitMs: 0, describe: "cast org template" });
  try { return await work(); } finally { release(); }
}
function stackBoundary(stack: any, receipt: TemplateReceipt): boolean {
  return receipt.workspace.kind === "team" ? stack.team_id === receipt.workspace.id : !stack.team_id && stack.scope_user_id === receipt.workspace.id;
}
async function recoverStack(deps: OrgInitDeps, receipt: TemplateReceipt): Promise<void> {
  if (!receipt.stack.id) {
    const listed = await request(deps, "/cli/stack/ls", { include_done: true });
    const matches = (listed.stacks ?? []).filter((s: any) => s.title === receipt.stack.title && stackBoundary(s, receipt));
    if (matches.length > 1) throw new Error("Multiple template stacks found; reconcile manually");
    if (matches[0]) receipt.stack.id = matches[0].short_id || matches[0]._id;
    else {
      if (receipt.stack.attempted) throw new Error("Stack creation outcome unknown; refusing a duplicate request. Inspect the server before repairing the receipt.");
      receipt.stack.attempted = true;
      save(receipt);
      const created = await request(deps, "/cli/stack/create", { title: receipt.stack.title, ...boundary(receipt) });
      receipt.stack.id = created.short_id || created.id;
      if (!receipt.stack.id) throw new Error("Stack creation returned no id");
    }
    save(receipt);
  }
  const shown = await request(deps, "/cli/stack/show", { stack: receipt.stack.id });
  if (!stackBoundary(shown.stack, receipt) || shown.stack.title !== receipt.stack.title) throw new Error("Template stack boundary or identity changed");
  const marker = `Template instance ${receipt.key}`;
  const matches = (shown.decisions ?? []).filter((d: any) => d.context_md?.includes(marker));
  if (matches.length > 1 || (shown.decisions ?? []).length > 1) throw new Error("Template stack must contain exactly its one role decision");
  if (receipt.stack.decisionId) {
    if (!matches.some((d: any) => (d.short_id || d._id) === receipt.stack.decisionId)) throw new Error("Template decision is missing or changed");
    return;
  }
  if (matches[0]) receipt.stack.decisionId = matches[0].short_id || matches[0]._id;
  else {
    if (receipt.stack.decisionAttempted) throw new Error("Decision creation outcome unknown; refusing a duplicate request");
    receipt.stack.decisionAttempted = true;
    save(receipt);
    const artifact = verifiedArtifact(receipt);
    const context = `${marker}\n\n${orgProposalBlock(receipt.proposal)}\n\n${artifact.manifest.description}\n\nProject: ${receipt.project.ref} (${receipt.project.dir}). ${(receipt.warnings ?? []).join(" ")} One standing role; channel routines are not extra managers. Starts at understand. Routines are created gated and paused only after your answer.\n\nProposed shared charter:\n${substitute(artifact.files.get(artifact.manifest.role.charter)!.toString("utf8"), values(receipt, artifact.manifest), inputTokens(artifact.manifest))}`;
    const created = await request(deps, "/cli/decide", { session_id: receipt.sourceSession, stack: receipt.stack.id, question: `Create ${receipt.proposal.name} for ${receipt.project.name}? (${receipt.instance})`, kind: "single", category: "access", blocking: true, options: ORG_PROPOSAL_OPTIONS.role.map((label) => ({ label })), context_md: context });
    receipt.stack.decisionId = created.short_id || created.id;
    if (!receipt.stack.decisionId) throw new Error("Decision creation returned no id");
  }
  save(receipt);
}
async function triggerRows(deps: OrgInitDeps): Promise<any[]> {
  const rows = await request(deps, "/cli/tasks/list", {});
  if (!Array.isArray(rows)) throw new Error("Trigger list did not return complete rows");
  return rows;
}
function triggerFor(rows: any[], ref: string): any {
  const found = rows.filter((r) => r._id === ref || r.short_id === ref);
  if (found.length !== 1) throw new Error(`Trigger ${ref} is missing or cannot be verified from this account`);
  return found[0];
}
function marker(receipt: TemplateReceipt, id: string): string { return `org-template:${receipt.key}:${id}`; }
function managedTrigger(row: any, receipt: TemplateReceipt, id: string): void {
  if (row.context_summary !== marker(receipt, id) || row.originating_conversation_id !== receipt.role?.sessionId || row.project_path !== receipt.project.dir || row.prompt !== loaderPrompt(receipt, id)) throw new Error(`Routine ${id} binding or loader changed; refusing to overwrite it`);
}
async function adoptRoutines(deps: OrgInitDeps, receipt: TemplateReceipt, adopt: string[], persist = true): Promise<void> {
  if (!adopt.length) return;
  const rows = await triggerRows(deps);
  const seen = new Set<string>();
  const changes: Array<[string, any]> = [];
  for (const spec of adopt) {
    const match = /^([a-z][a-z0-9-]*)=(tr-[a-z0-9]+)$/.exec(spec);
    if (!match || !receipt.routines[match[1]] || seen.has(match[1])) throw new Error(`Adoption requires a unique known routine=tr-N: ${spec}`);
    const [_, id, ref] = match;
    seen.add(id);
    const existing = receipt.routines[id];
    const row = triggerFor(rows, ref);
    if (row.project_path !== receipt.project.dir) throw new Error(`Adopted trigger ${ref} belongs to a different project directory`);
    if (existing.attempted || (existing.triggerId && existing.triggerId !== row._id)) throw new Error(`Routine ${id} already has a different trigger or pending creation`);
    if (changes.some(([, other]) => other._id === row._id) || Object.entries(receipt.routines).some(([otherId, r]) => otherId !== id && r.triggerId === row._id)) throw new Error("One trigger cannot be adopted by multiple routines");
    changes.push([id, row]);
  }
  for (const [id, row] of changes) receipt.routines[id] = { ...receipt.routines[id], triggerId: row._id, external: true, paused: row.status === "paused", actualIntervalMs: row.interval_ms };
  if (persist) save(receipt);
}
async function prepareInstall(deps: OrgInitDeps, artifact: TemplateArtifact, instance: string, dir: string, options: TemplateOptions): Promise<TemplateReceipt> {
  const tree = await currentWorkspace(deps, options);
  const project = await verifiedProject(deps, tree, dir, options.project!);
  const sourceSession = options.session || sessionIdFromEnv();
  if (!sourceSession && !options.dryRun) throw new Error("Install needs the proposing session (--session)");
  const root = releaseRoot(dir, { ...artifact.manifest, hash: artifact.hash });
  const key = randomUUID();
  const receipt: TemplateReceipt = { schemaVersion: 1, instance, key, project, workspace: tree.workspace, warnings: projectWarnings(project), sourceSession: sourceSession || "not-set", phase: "proposal", template: { id: artifact.manifest.id, version: artifact.manifest.version, hash: artifact.hash, root }, stack: { title: `Org template ${instance} for ${project.ref} [${key}]` }, proposal: { kind: "role", name: "", handle: "" }, config: parseInputs(artifact.manifest, options.input), routines: Object.fromEntries(artifact.manifest.routines.map((r) => [r.id, { every: r.every }])) };
  const handle = substitute(artifact.manifest.role.handle, values(receipt, artifact.manifest), inputTokens(artifact.manifest));
  if (!/^[a-z0-9-]{2,32}$/.test(handle)) throw new Error("Expanded role handle is invalid");
  if ((tree.roles ?? []).some((r: any) => r.handle === handle)) throw new Error(`Role @${handle} already exists; refusing to create or silently adopt another seat`);
  // Every project has one lead (R4, W9 I2). A hire never adds a second role
  // watching the same project beside its lead: it reports to that lead, or
  // the person names the lead as the seat instead (org-hire.md H3).
  const leads = (tree.roles ?? []).filter((r: any) => r.status !== "retired" && (r.scope?.project_ids ?? []).some((id: any) => String(id) === String(project.id)));
  const reportsTo = options.reportsTo?.trim() || "me";
  if (reportsTo !== "me") {
    if (!/^@[a-z0-9-]{2,32}$/.test(reportsTo)) throw new Error("--reports-to takes me or @handle");
    if (!(tree.roles ?? []).some((r: any) => r.status !== "retired" && `@${r.handle}` === reportsTo)) throw new Error(`No active role ${reportsTo} in this workspace`);
  }
  if (leads.length && !leads.some((r: any) => `@${r.handle}` === reportsTo)) throw new Error(`Project ${project.ref} already has a lead, @${leads[0].handle}. Hire under it with --reports-to @${leads[0].handle}, or name that role as the seat; a second role beside a project's lead is refused.`);
  receipt.proposal = { kind: "role", name: substitute(artifact.manifest.role.name, values(receipt, artifact.manifest), inputTokens(artifact.manifest)), handle, scope: { projects: [project.ref], plans: [] }, reports_to: reportsTo, ...(artifact.manifest.role.avatar ? { avatar: artifact.manifest.role.avatar } : {}), ...(artifact.manifest.role.tenure ? { tenure: artifact.manifest.role.tenure.kind === "standing" ? { kind: "standing" as const } : { kind: "program" as const, ends: { project: project.ref }, then: artifact.manifest.role.tenure.then } } : {}), trust: "understand", caps: artifact.manifest.role.caps, charter: loaderPrompt(receipt, "charter"), evidence: [`Explicit install into existing project ${project.ref}`, `Pinned ${receipt.template.id}@${receipt.template.version} sha256:${receipt.template.hash}`] };
  checkReleaseVersion(dir, artifact);
  return receipt;
}
export async function installTemplate(deps: OrgInitDeps, source: string, instance: string, options: TemplateOptions): Promise<TemplateReceipt> {
  const dir = canonicalDirectory(options.dir);
  if (!fs.statSync(dir).isDirectory() || !options.project?.trim()) throw new Error("Install requires --project and an existing --dir");
  const artifact = readArtifact(source);
  if (options.dryRun) {
    const receipt = fs.existsSync(receiptPath(dir, instance)) ? readReceipt(dir, instance) : await prepareInstall(deps, artifact, instance, dir, options);
    if (fs.existsSync(receiptPath(dir, instance))) receipt.warnings = (await checkContext(deps, receipt, options)).templateWarnings;
    if (artifact.manifest.id !== receipt.template.id || artifact.manifest.version !== receipt.template.version || artifact.hash !== receipt.template.hash) throw new Error("Installed release differs; use explicit upgrade preview and --apply");
    await adoptRoutines(deps, receipt, options.adopt ?? [], false);
    return receipt;
  }
  return locked(dir, instance, async () => {
    const file = receiptPath(dir, instance);
    if (fs.existsSync(file)) {
      const receipt = readReceipt(dir, instance);
      receipt.warnings = (await checkContext(deps, receipt, options)).templateWarnings;
      if (artifact.manifest.id !== receipt.template.id || artifact.manifest.version !== receipt.template.version || artifact.hash !== receipt.template.hash) throw new Error("Installed release differs; use explicit upgrade preview and --apply");
      await adoptRoutines(deps, receipt, options.adopt ?? []);
      await recoverStack(deps, receipt);
      return receipt;
    }
    const receipt = await prepareInstall(deps, artifact, instance, dir, options);
    freezeArtifact(dir, artifact);
    save(receipt);
    await adoptRoutines(deps, receipt, options.adopt ?? []);
    await recoverStack(deps, receipt);
    return receipt;
  });
}
function verifyRole(tree: any, receipt: TemplateReceipt, handle?: string): any {
  const candidates = (tree.roles ?? []).filter((r: any) => receipt.role ? r._id === receipt.role.id : r.handle === handle);
  if (candidates.length !== 1) throw new Error("Applied role cannot be verified; refusing to adopt an unrelated seat");
  const role = candidates[0];
  if (role.status === "retired" || role.scope?.project_ids?.length !== 1 || role.scope.project_ids[0] !== receipt.project.id || role.scope?.plan_ids?.length !== 0) throw new Error("Role scope must remain exactly the instance project; no whole-workspace fallback");
  if (receipt.role && role.handle !== receipt.role.handle) throw new Error("Role handle changed; review the receipt before reconciling");
  return role;
}
async function verifyStanding(deps: OrgInitDeps, tree: any, receipt: TemplateReceipt): Promise<string> {
  const role = verifyRole(tree, receipt);
  const anchors = (tree.anchors ?? []).filter((a: any) => a.org_role_id === role._id && a.anchor_id === role.anchor_id);
  if (anchors.length !== 1 || !anchors[0].conversation_id) throw new Error("Standing session is not yet verified; rerun reconcile after provisioning");
  const id = anchors[0].conversation_id;
  if (receipt.role?.sessionId && receipt.role.sessionId !== id) throw new Error("Standing session identity changed; routine bindings need explicit review");
  const sessions = await request(deps, "/cli/sessions", { session_ids: [id] });
  if (!sessions.conversations?.some((c: any) => c.conversation_id === id && c.project_path && canonicalDirectory(c.project_path) === receipt.project.dir)) throw new Error("Standing session does not run in the pinned project directory");
  return id;
}
async function ensureRoutines(deps: OrgInitDeps, receipt: TemplateReceipt): Promise<void> {
  const artifact = verifiedArtifact(receipt);
  for (const routine of artifact.manifest.routines) {
    const state = receipt.routines[routine.id];
    if (state.external || state.retired) continue;
    let rows = await triggerRows(deps);
    let row = state.triggerId ? triggerFor(rows, state.triggerId) : rows.find((r: any) => r.context_summary === marker(receipt, routine.id));
    if (!row) {
      if (state.attempted) throw new Error(`Routine ${routine.id} creation outcome unknown; refusing a duplicate request`);
      state.attempted = true;
      save(receipt);
      const created = await request(deps, "/cli/tasks/create", { title: substitute(routine.title, values(receipt, artifact.manifest), inputTokens(artifact.manifest)), prompt: loaderPrompt(receipt, routine.id), context_summary: marker(receipt, routine.id), originating_conversation_id: receipt.role!.sessionId, project_path: receipt.project.dir, schedule_type: "recurring", interval_ms: intervalMs(routine.every), status: "paused", mode: "propose" });
      state.triggerId = created.task_id;
      if (!state.triggerId) throw new Error("Trigger creation returned no id");
      save(receipt);
      rows = await triggerRows(deps);
      row = triggerFor(rows, state.triggerId);
    }
    if (rows.filter((r: any) => r.context_summary === marker(receipt, routine.id)).length !== 1) throw new Error(`Multiple triggers for routine ${routine.id}`);
    managedTrigger(row, receipt, routine.id);
    state.triggerId = row._id;
    if (state.attempted) {
      // Created paused (org-hire.md H8): no run_at, so nothing fires until a
      // person activates it. A row from an older install carries the year
      // ahead date and the exit 1 gate instead; both forms are inert.
      // A backend that ignores the status is paused at once instead.
      if (row.run_count !== 0 || row.status === "running" || row.schedule_type !== "recurring" || row.interval_ms !== intervalMs(routine.every)) throw new Error(`Routine ${routine.id} was not safely gated; manual review required`);
      if (row.status !== "paused") await request(deps, "/cli/tasks/pause", { task_id: row._id });
      row = triggerFor(await triggerRows(deps), row._id);
      if (row.status !== "paused" || row.run_count !== 0) throw new Error(`Pause verification failed for ${routine.id}`);
      state.attempted = false;
    }
    state.paused = row.status === "paused";
    state.actualIntervalMs = row.interval_ms;
    save(receipt);
  }
}

/** The marker a ledger task carries as a label, so a re-hire adopts it (H7). */
export const ledgerMarker = (receipt: TemplateReceipt, ledger: string) => `org-template:${receipt.key}:ledger:${ledger}`;

/**
 * The host step (H3): after the hire is approved and its routines exist,
 * write the instance file from the answers, bind secrets to files on this
 * machine, and find or create the ledger tasks. Reruns are safe: the file
 * is merged, bindings are rewritten, ledgers are found by marker.
 */
export async function bindTemplate(deps: OrgInitDeps, instance: string, options: TemplateOptions): Promise<TemplateReceipt> {
  const dir = canonicalDirectory(options.dir);
  return locked(dir, instance, async () => {
    const receipt = readReceipt(dir, instance);
    const artifact = verifiedArtifact(receipt);
    await checkContext(deps, receipt, options);
    if (receipt.phase !== "ready") throw new Error(`Instance is ${receipt.phase}; bind runs once the role and its routines exist (reconcile first)`);
    const manifest = artifact.manifest;
    const secrets = new Map((manifest.inputs ?? []).filter((i) => i.kind === "secret").map((i) => [i.key, i]));
    const paths: Record<string, string> = {};
    for (const entry of options.secret ?? []) {
      const at = entry.indexOf("=");
      if (at <= 0) throw new Error(`Secret must be key=path: ${entry}`);
      const key = entry.slice(0, at);
      if (!secrets.has(key)) throw new Error(`Not a secret input of this template: ${key}`);
      const file = path.resolve(entry.slice(at + 1).replace(/^~(?=$|\/)/, os.homedir()));
      noSymlink(file);
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (!stat?.isFile()) throw new Error(`Secret file for ${key} is not a regular file on this host`);
      if (stat.mode & 0o077) throw new Error(`Secret file for ${key} must not be readable by other users (chmod 600)`);
      paths[key] = file;
    }
    receipt.bindings ??= {};
    for (const [key, file] of Object.entries(paths)) receipt.bindings[key] = { host: os.hostname(), path_hash: createHash("sha256").update(file).digest("hex"), bound_at: Date.now() };
    receipt.ledgers ??= {};
    for (const ledger of manifest.ledgers ?? []) {
      if (receipt.ledgers[ledger.id]) continue;
      const marker = ledgerMarker(receipt, ledger.id);
      const found = (await request(deps, "/cli/work/list", { project_id: receipt.project.id, label: marker, include_done: true, ...boundary(receipt) })) as any;
      const rows: any[] = Array.isArray(found) ? found : found?.tasks ?? [];
      let row = rows.find((t) => (t.labels ?? []).includes(marker));
      if (!row) {
        row = await request(deps, "/cli/work/create", { title: substitute(ledger.title, values(receipt, manifest), inputTokens(manifest)), client_key: marker, task_type: "chore", labels: ["ledger", marker], project_id: receipt.project.id, project_path: receipt.project.dir, ...boundary(receipt) });
      }
      receipt.ledgers[ledger.id] = { taskId: row._id ?? row.id, shortId: row.short_id };
    }
    // The instance file carries the answers, the bound secret paths (paths,
    // never contents) and the ledger ids, for the release's own scripts.
    const config: Record<string, string> = { ...(receipt.config ?? {}), ...paths };
    const ledgerInputs = Object.fromEntries(Object.entries(receipt.ledgers).map(([id, l]) => [`ledgers.${id}`, l.shortId]));
    const file = writeInstanceFile(dir, instance, { inputs: [...(manifest.inputs ?? []), ...Object.keys(ledgerInputs).map((key) => ({ key, label: key, kind: "string" as const }))], instance_file: manifest.instance_file }, { ...config, ...ledgerInputs });
    // The server row is the record the web reads (org-hire.md H1); the receipt
    // keeps the pin. Registered by the receipt's key, so a rerun updates it.
    const row = await request(deps, "/cli/org/template/instance", {
      instance_key: receipt.key, instance, template_id: receipt.template.id, version: receipt.template.version, digest: receipt.template.hash,
      project_id: receipt.project.id, role_id: receipt.role!.id, host: { machine: os.hostname(), dir: receipt.project.dir }, phase: "ready",
      config: receipt.config ?? {}, bindings: receipt.bindings, ledgers: receipt.ledgers, ...boundary(receipt),
    });
    receipt.instanceId = String(row._id ?? row.id);
    save(receipt);
    return { ...receipt, instanceFile: file } as TemplateReceipt & { instanceFile: string };
  });
}


/**
 * The instance's own record (H5 to H7). The server row is the record; the
 * same rules run there (orgTemplateState, shared). Before the host step has
 * registered the row, the receipt alone holds it, so a run can record while
 * the hire is still being bound; the bind step then registers everything.
 */
async function withState<T>(deps: OrgInitDeps, options: TemplateOptions, instance: string, local: (manifest: OrgTemplate, receipt: TemplateReceipt) => T, remote: (receipt: TemplateReceipt) => Promise<unknown> | undefined): Promise<T> {
  const dir = canonicalDirectory(options.dir);
  return locked(dir, instance, async () => {
    const receipt = readReceipt(dir, instance);
    if (!receipt.role) throw new Error("Template role has not been approved and applied");
    const result = local(verifiedArtifact(receipt).manifest, receipt);
    if (receipt.instanceId) await remote(receipt);
    save(receipt);
    return result;
  });
}
export const evidenceTemplate = (deps: OrgInitDeps, instance: string, check: string, options: TemplateOptions) =>
  withState(deps, options, instance,
    (manifest, receipt) => recordEvidence(manifest, receipt, check, { status: options.status ?? "", source: options.source, detail: options.detail }),
    (receipt) => request(deps, "/cli/org/template/evidence", { instance_key: receipt.key, check, status: options.status, source: options.source, detail: options.detail }));
export const reportTemplate = (deps: OrgInitDeps, instance: string, entries: string[], options: TemplateOptions) =>
  withState(deps, options, instance,
    (manifest, receipt) => recordScores(manifest, receipt, entries, { source: options.source, observedAt: options.observedAt ? Date.parse(options.observedAt) : undefined }),
    (receipt) => request(deps, "/cli/org/template/report", { instance_key: receipt.key, entries, source: options.source, observed_at: options.observedAt ? Date.parse(options.observedAt) : undefined }));
export const setupTemplate = (deps: OrgInitDeps, instance: string, id: string | undefined, options: TemplateOptions) => {
  const chosen = [options.done && "done", options.skip && "skipped", options.open && "open"].filter(Boolean) as string[];
  const fromAgent = !!(options.session || sessionIdFromEnv());
  return withState(deps, options, instance,
    (manifest, receipt) => {
      if (!id) return setupRows(manifest, receipt);
      if (chosen.length !== 1) throw new Error("Give exactly one of --done, --skip or --open");
      return markSetup(manifest, receipt, id, { status: chosen[0]!, evidence: options.evidence, fromAgent });
    },
    (receipt) => (id ? request(deps, "/cli/org/template/setup", { instance_key: receipt.key, id, status: chosen[0], evidence: options.evidence, from_agent: fromAgent }) : undefined));
};

/** A lesson to the template's publisher (H9): a row on the template, never a task in their workspace. */
// The lesson's evidence is repeatable (label=link), while TemplateOptions
// carries the setup command's singular --evidence href: omitting it here keeps
// the two from intersecting into an impossible `string & string[]`, and the
// singular is accepted (as one entry) so a plain TemplateOptions still fits.
export async function lessonTemplate(deps: OrgInitDeps, instance: string, body: string, options: Omit<TemplateOptions, "evidence"> & { evidence?: string | string[] }): Promise<unknown> {
  const receipt = readReceipt(options.dir, instance);
  if (!receipt.instanceId) throw new Error("Bind the instance first; a lesson is filed on the server's record of it");
  const entries = options.evidence === undefined ? [] : Array.isArray(options.evidence) ? options.evidence : [options.evidence];
  const evidence = entries.map((entry) => { const at = entry.indexOf("="); if (at <= 0) throw new Error(`Evidence must be label=link: ${entry}`); return { label: entry.slice(0, at), href: entry.slice(at + 1) }; });
  return request(deps, "/cli/org/template/lesson", { instance_key: receipt.key, body, evidence });
}

/** Publish a release folder as a template (H1): the validated manifest and the folder's digest, under the caller's workspace or as Codecast. */
export async function publishTemplate(deps: OrgInitDeps, source: string, options: { team?: string; personal?: boolean; codecast?: boolean; status?: string; changelog?: string; reviewProject?: string }): Promise<unknown> {
  const artifact = readArtifact(source);
  const workspace = options.codecast ? undefined : (await currentWorkspace(deps, options)).workspace;
  return request(deps, "/cli/org/template/publish", {
    manifest: artifact.manifest, digest: artifact.hash, status: options.status, changelog: options.changelog, review_project_id: options.reviewProject,
    ...(options.codecast ? { as_codecast: true } : workspace?.kind === "team" ? { team_id: workspace.id } : {}),
  });
}
export async function catalogTemplates(deps: OrgInitDeps, options: { team?: string; personal?: boolean }): Promise<unknown> {
  const { workspace } = await currentWorkspace(deps, options);
  return request(deps, "/cli/org/template/catalog", workspace.kind === "team" ? { team_id: workspace.id } : {});
}

export async function reconcileTemplate(deps: OrgInitDeps, instance: string, options: TemplateOptions): Promise<TemplateReceipt> {
  return locked(options.dir, instance, async () => {
    const receipt = readReceipt(options.dir, instance);
    let tree = await checkContext(deps, receipt, options);
    receipt.warnings = tree.templateWarnings;
    if (receipt.upgrade) throw new Error("An upgrade is incomplete; rerun upgrade with its target release, or the original release to roll back");
    await adoptRoutines(deps, receipt, options.adopt ?? []);
    await recoverStack(deps, receipt);
    if (receipt.phase === "declined") return receipt;
    const shown = await request(deps, "/cli/stack/show", { stack: receipt.stack.id });
    const decision = shown.decisions.find((d: any) => (d.short_id || d._id) === receipt.stack.decisionId);
    if (!decision || decision.status !== "answered") return receipt;
    if (JSON.stringify(extractOrgProposal(decision.context_md)) !== JSON.stringify(receipt.proposal)) throw new Error("Proposal changed after installation; review rather than applying a different role");
    if (decision.blocking !== true || decision.answered_by?.kind !== "user") throw new Error("Template approval requires a blocking decision answered by a person");
    if (decision.answer_index === 2) { receipt.phase = "declined"; save(receipt); return receipt; }
    if (![0, 1].includes(decision.answer_index)) throw new Error("Unrecognized template decision answer");
    const proposed = decision.answer_index === 1 ? applyProposalChanges(receipt.proposal, decision.answer_text).proposal : receipt.proposal;
    if (proposed.scope?.projects?.length !== 1 || ![receipt.project.ref, receipt.project.id].includes(proposed.scope.projects[0]) || (proposed.scope.plans?.length ?? 0) !== 0) throw new Error("Approved scope differs from the explicit instance project; refusing provisioning");
    if (proposed.trust !== "understand") throw new Error("Template roles must start at understand");
    if (!receipt.role) {
      const applied = await request(deps, "/cli/org/apply-decision", { decision: receipt.stack.decisionId, provision: false });
      if (applied.status !== "applied" && !(applied.status === "skipped" && applied.note?.startsWith("already applied:"))) throw new Error(`Role was not applied: ${applied.note || applied.status}`);
      tree = await request(deps, "/cli/org/tree", boundary(receipt));
      sameWorkspace(tree.workspace, receipt.workspace);
      const role = verifyRole(tree, receipt, proposed.handle);
      if (applied.status === "skipped") {
        const recoveredRef = /^already applied: created @[^ ]+ \((or-\d+)\)/.exec(applied.note)?.[1];
        if (!recoveredRef || role.short_id !== recoveredRef) throw new Error("Previously applied role identity cannot be recovered safely");
      }
      if (applied.role && applied.role.id !== role._id) throw new Error("Applied role identity mismatch");
      if ((role.trust ?? "understand") !== "understand") throw new Error("New role is not at understand; manual review required");
      receipt.role = { id: role._id, handle: role.handle };
      receipt.phase = "provisioning";
      save(receipt);
    }
    const role = verifyRole(tree, receipt);
    if (!role.anchor_id) {
      await request(deps, "/cli/role/provision", { role_id: role._id, project_path: receipt.project.dir });
      tree = await request(deps, "/cli/org/tree", boundary(receipt));
      sameWorkspace(tree.workspace, receipt.workspace);
    }
    receipt.role.sessionId = await verifyStanding(deps, tree, receipt);
    save(receipt);
    await ensureRoutines(deps, receipt);
    receipt.phase = "ready";
    save(receipt);
    return receipt;
  });
}
export async function templateStatus(deps: OrgInitDeps, instance: string, options: TemplateOptions): Promise<any> {
  const receipt = readReceipt(options.dir, instance);
  const tree = await checkContext(deps, receipt, options);
  if (receipt.role) { verifyRole(tree, receipt); if (receipt.role.sessionId) await verifyStanding(deps, tree, receipt); }
  const rows = await triggerRows(deps);
  const artifact = verifiedArtifact(receipt);
  const roleRow = receipt.role ? verifyRole(tree, receipt) : undefined;
  const trust = roleRow?.trust ?? "understand";
  const held = { ...receipt, authority: (roleRow?.authority ?? []).map((g: any) => ({ id: g.id, expires_at: g.expires_at })) };
  return { ...receipt, setup: setupRows(artifact.manifest, receipt), ask: nextHumanAsk(artifact.manifest, receipt), readiness: readiness(artifact.manifest, held, trust), warnings: tree.templateWarnings, routines: Object.fromEntries(Object.entries(receipt.routines).map(([id, r]) => {
    const row = r.triggerId ? triggerFor(rows, r.triggerId) : null;
    if (row && !r.external) managedTrigger(row, receipt, id);
    if (row && r.external && row.project_path !== receipt.project.dir) throw new Error(`External routine ${id} changed project`);
    return [id, { ...r, status: row?.status ?? "not-created", gated: !!row?.precheck, shortId: row?.short_id, runAt: row?.run_at, intervalMs: row?.interval_ms, activation: receipt.phase === "ready" && !r.external && !r.retired && !r.attempted && row?.status === "paused" ? activationInstructions(receipt, row) : undefined }];
  })), next: receipt.phase === "upgrading" ? "Upgrade incomplete: rerun its target release to finish, or its original release to roll back; routines cannot run until recovery finishes." : receipt.phase === "proposal" ? `Answer ${receipt.stack.decisionId}, then reconcile` : "Review paused/gated routines before explicitly enabling them. External routines remain untouched." };
}
export async function templateInstructions(deps: OrgInitDeps, instance: string, routine: string, options: TemplateOptions): Promise<string> {
  const receipt = readReceipt(options.dir, instance);
  const artifact = verifiedArtifact(receipt);
  const tree = await checkContext(deps, receipt, options);
  if (!receipt.role) throw new Error("Template role has not been approved and applied");
  verifyRole(tree, receipt);
  let file = artifact.manifest.role.charter;
  let header = "";
  if (routine !== "charter") {
    const entry = artifact.manifest.routines.find((r) => r.id === routine);
    const state = receipt.routines[routine];
    if (receipt.phase !== "ready" || receipt.upgrade || !entry || !state?.triggerId || state.external || state.retired || state.attempted) throw new Error("Routine is unverified, external, pending, or retired");
    if (verifyRole(tree, receipt).status !== "active") throw new Error("Role is paused or inactive");
    await verifyStanding(deps, tree, receipt);
    const row = triggerFor(await triggerRows(deps), state.triggerId);
    managedTrigger(row, receipt, routine);
    if (!["scheduled", "running"].includes(row.status) || row.precheck === "exit 1") throw new Error("Routine remains paused or gated for review");
    file = entry.prompt;
    const roleRow = verifyRole(tree, receipt);
    header = readinessHeader(routine, readiness(artifact.manifest, { ...receipt, authority: (roleRow.authority ?? []).map((g: any) => ({ id: g.id, expires_at: g.expires_at })) }, roleRow.trust ?? "understand")[routine]);
  }
  return `Template ${receipt.template.id}@${receipt.template.version}\nSHA-256 ${receipt.template.hash}\nInstance ${instance}; project ${receipt.project.ref}\nHuman charter, trust and grants remain authoritative.${header ? `\n${header}` : ""}\n\n${substitute(artifact.files.get(file)!.toString("utf8"), values(receipt, artifact.manifest), inputTokens(artifact.manifest))}`;
}
export function activationInstructions(receipt: TemplateReceipt, row: { short_id?: string; _id: string; interval_ms: number; precheck?: string }): { note: string; commands: string[] } {
  if (row.precheck && row.precheck !== "exit 1") return { note: "This routine has a custom precheck. Keep it paused and review that gate explicitly; the template activation procedure must not remove a human override.", commands: [] };
  const seconds = row.interval_ms / 1000;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return { note: "The live cadence cannot be represented exactly by cast trigger update; keep paused and review it manually.", commands: [] };
  const ref = quoteTemplateArg(row.short_id || row._id);
  const gate = row.precheck === "exit 1" ? " --precheck ''" : "";
  return {
    note: "A person activates this routine, from the role page (one control) or with these commands after review: keep it paused, set its first run one cadence out with --every (resume alone would run it at once, or a year out on an older install), verify paused state, no gate and the new runAt, then resume.",
    commands: [
      `cast trigger update ${ref} --every ${quoteTemplateArg(`${seconds}s`)}${gate}`,
      `cast org template status ${quoteTemplateArg(receipt.instance)} --dir ${quoteTemplateArg(receipt.project.dir)}`,
      `cast trigger resume ${ref}`,
    ],
  };
}
/** The role page's control, from the shell: refused for an agent session by the server, with the reason. */
export async function activateTemplateRoutine(deps: OrgInitDeps, instance: string, routine: string, options: TemplateOptions): Promise<unknown> {
  const receipt = readReceipt(options.dir, instance);
  const state = receipt.routines[routine];
  if (!state?.triggerId || state.external || state.retired) throw new Error("Routine is unverified, external or retired");
  return request(deps, "/cli/org/template/activate", { task_id: state.triggerId, from_session: options.session || sessionIdFromEnv() || undefined });
}
function verifyRelease(receipt: TemplateReceipt, release: TemplateReceipt["template"]): TemplateArtifact {
  if (release.root !== releaseRoot(receipt.project.dir, release)) throw new Error("Upgrade release points outside its pinned directory");
  return verifiedArtifact({ ...receipt, template: release });
}
async function pauseRoutine(deps: OrgInitDeps, receipt: TemplateReceipt, id: string, ref: string): Promise<any> {
  let row = triggerFor(await triggerRows(deps), ref);
  managedTrigger(row, receipt, id);
  if (!["paused", "scheduled"].includes(row.status)) throw new Error(`Routine ${id} must finish before upgrade recovery`);
  if (row.status !== "paused") await request(deps, "/cli/tasks/pause", { task_id: row._id });
  row = triggerFor(await triggerRows(deps), ref);
  if (row.status !== "paused") throw new Error(`Pause verification failed for ${id}`);
  return row;
}
async function finishUpgrade(deps: OrgInitDeps, receipt: TemplateReceipt): Promise<void> {
  const intent = receipt.upgrade!;
  verifyRelease(receipt, intent.from);
  const target = verifyRelease(receipt, intent.direction === "forward" ? intent.to : intent.from);
  const live = await triggerRows(deps);
  for (const [id, state] of Object.entries(receipt.routines)) {
    if (!state.external && state.triggerId && triggerFor(live, state.triggerId).status === "running") throw new Error(`Routine ${id} must finish before upgrade recovery`);
  }
  for (const [id, change] of Object.entries(intent.cadence)) {
    let row = triggerFor(await triggerRows(deps), change.triggerId);
    managedTrigger(row, receipt, id);
    if (row.interval_ms !== change.before && row.interval_ms !== change.after) throw new Error(`Routine ${id} cadence changed outside this upgrade; keep paused and review before recovery`);
    row = await pauseRoutine(deps, receipt, id, change.triggerId);
    if (row.interval_ms !== change.before && row.interval_ms !== change.after) throw new Error(`Routine ${id} cadence changed outside this upgrade; review before recovery`);
    const wanted = intent.direction === "forward" ? change.after : change.before;
    if (row.interval_ms !== wanted) {
      const result = await request(deps, "/cli/tasks/update", { task_id: row._id, interval_ms: wanted });
      row = triggerFor(await triggerRows(deps), row._id);
      if (!result.success || row.interval_ms !== wanted || row.status !== "paused") throw new Error(`Cadence update verification failed for ${id}`);
    }
    receipt.routines[id].paused = true;
    receipt.routines[id].actualIntervalMs = wanted;
    save(receipt);
  }
  const retiring = intent.direction === "forward" ? intent.removed : intent.added;
  for (const id of retiring) {
    const state = receipt.routines[id];
    if (!state) continue;
    if (state.external) { state.retired = true; save(receipt); continue; }
    const rows = await triggerRows(deps);
    const matches = rows.filter((row: any) => row.context_summary === marker(receipt, id));
    if (matches.length > 1) throw new Error(`Multiple triggers for routine ${id}`);
    const row = state.triggerId ? triggerFor(rows, state.triggerId) : matches[0];
    if (!row && state.attempted) throw new Error(`Routine ${id} creation outcome unknown; cannot complete rollback safely`);
    if (row) {
      managedTrigger(row, receipt, id);
      state.triggerId = row._id;
      save(receipt);
      const paused = await pauseRoutine(deps, receipt, id, row._id);
      state.paused = true;
      state.actualIntervalMs = paused.interval_ms;
      state.attempted = false;
    }
    state.retired = true;
    save(receipt);
  }
  if (intent.direction === "rollback") {
    for (const [id, original] of Object.entries(intent.originalRoutines)) receipt.routines[id] = { ...original, paused: receipt.routines[id]?.paused ?? original.paused, actualIntervalMs: receipt.routines[id]?.actualIntervalMs ?? original.actualIntervalMs };
  } else {
    for (const r of target.manifest.routines) receipt.routines[r.id] = { ...receipt.routines[r.id], every: r.every, retired: false };
  }
  receipt.template = intent.direction === "forward" ? intent.to : intent.from;
  save(receipt);
  await ensureRoutines(deps, receipt);
  receipt.phase = "ready";
  delete receipt.upgrade;
  save(receipt);
}
export async function upgradeTemplate(deps: OrgInitDeps, instance: string, source: string, options: TemplateOptions): Promise<any> {
  const execute = async () => {
    const receipt = readReceipt(options.dir, instance);
    const tree = await checkContext(deps, receipt, options);
    verifyRole(tree, receipt);
    await verifyStanding(deps, tree, receipt);
    const next = readArtifact(source);
    if (receipt.upgrade) {
      const intent = receipt.upgrade;
      const direction = next.hash === intent.to.hash ? "forward" : next.hash === intent.from.hash ? "rollback" : undefined;
      if (!direction) throw new Error("An upgrade is incomplete; choose its pinned target release to finish or its original release to roll back");
      const recovery = { from: intent.from, to: intent.to, warnings: tree.templateWarnings, recovery: direction, cadence: intent.cadence, added: intent.added, removed: intent.removed, applied: false };
      if (!options.apply) return recovery;
      intent.direction = direction;
      receipt.phase = "upgrading";
      receipt.warnings = tree.templateWarnings;
      save(receipt);
      await finishUpgrade(deps, receipt);
      return { ...recovery, applied: true, receipt };
    }
    if (receipt.phase !== "ready") throw new Error("Finish reconciling the approved instance before upgrading");
    const before = verifiedArtifact(receipt);
    if (next.manifest.id !== receipt.template.id) throw new Error("Cannot change template identity");
    if (next.manifest.version === receipt.template.version && next.hash !== receipt.template.hash) throw new Error("Same-version changed artifact refused; publish a new version");
    checkReleaseVersion(receipt.project.dir, next);
    const added = next.manifest.routines.filter((r) => !receipt.routines[r.id]);
    const removed = before.manifest.routines.filter((r) => !next.manifest.routines.some((n) => n.id === r.id));
    const cadenceChanged = next.manifest.routines.filter((r) => receipt.routines[r.id] && receipt.routines[r.id].every !== r.every);
    const observed = await triggerRows(deps);
    const cadenceOverrides = Object.entries(receipt.routines).filter(([, r]) => r.triggerId && (r.external || triggerFor(observed, r.triggerId).interval_ms !== intervalMs(r.every))).map(([id, r]) => ({ id, interval_ms: triggerFor(observed, r.triggerId!).interval_ms, external: !!r.external }));
    const changedFiles = {
      added: [...next.files.keys()].filter((name) => !before.files.has(name)),
      removed: [...before.files.keys()].filter((name) => !next.files.has(name)),
      changed: [...next.files.keys()].filter((name) => before.files.has(name) && (!before.files.get(name)!.equals(next.files.get(name)!) || before.executable.has(name) !== next.executable.has(name))),
    };
    const sharedCharterChanged = before.manifest.role.charter !== next.manifest.role.charter || !before.files.get(before.manifest.role.charter)!.equals(next.files.get(next.manifest.role.charter)!);
    const preview = { changedFiles, sharedCharterChanged, cadenceOverrides, warnings: tree.templateWarnings, from: receipt.template, to: { id: next.manifest.id, version: next.manifest.version, hash: next.hash }, added: added.map((r) => r.id), removed: removed.map((r) => r.id), cadenceChanged: cadenceChanged.map((r) => r.id), roleChanges: JSON.stringify(before.manifest.role) !== JSON.stringify(next.manifest.role), applied: false };
    if (!options.apply) return preview;
    if (next.hash === receipt.template.hash) return { ...preview, applied: true, unchanged: true, receipt };
    if (next.manifest.role.handle !== before.manifest.role.handle || next.manifest.role.name !== before.manifest.role.name || JSON.stringify(next.manifest.role.caps) !== JSON.stringify(before.manifest.role.caps)) throw new Error("Upgrade cannot alter role identity or caps; use a separate human org decision");
    for (const [id, state] of Object.entries(receipt.routines)) {
      if (!state.triggerId) continue;
      const row = triggerFor(observed, state.triggerId);
      if (!state.external) managedTrigger(row, receipt, id);
      else if (row.project_path !== receipt.project.dir) throw new Error(`External routine ${id} changed project`);
      if (!state.external && row.status === "running") throw new Error(`Routine ${id} must finish before upgrade`);
      state.paused = row.status === "paused";
      state.actualIntervalMs = row.interval_ms;
    }
    const cadence = Object.fromEntries(cadenceChanged.filter((r) => !cadenceOverrides.some((o) => o.id === r.id) && receipt.routines[r.id].triggerId).map((r) => [r.id, { triggerId: receipt.routines[r.id].triggerId!, before: triggerFor(observed, receipt.routines[r.id].triggerId!).interval_ms as number, after: intervalMs(r.every) }]));
    for (const id of new Set([...removed.map((r) => r.id), ...Object.keys(cadence)])) {
      const state = receipt.routines[id];
      if (state.external || !state.triggerId) continue;
      if (!["paused", "scheduled"].includes(triggerFor(observed, state.triggerId).status)) throw new Error(`Routine ${id} must finish before upgrade`);
    }
    const root = freezeArtifact(receipt.project.dir, next);
    atomicJson(receiptPath(receipt.project.dir, instance) + `.before-${receipt.template.hash}.json`, receipt);
    receipt.upgrade = { from: { ...receipt.template }, to: { id: next.manifest.id, version: next.manifest.version, hash: next.hash, root }, direction: "forward", originalRoutines: structuredClone(receipt.routines), added: added.map((r) => r.id), removed: removed.map((r) => r.id), cadence };
    receipt.phase = "upgrading";
    receipt.warnings = tree.templateWarnings;
    save(receipt);
    await finishUpgrade(deps, receipt);
    return { ...preview, applied: true, receipt };
  };
  return options.apply ? locked(options.dir, instance, execute) : execute();
}
