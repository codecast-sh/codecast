import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { applyProposalChanges, extractOrgProposal } from "@codecast/shared/contracts/orgProposal";
import { registerOrgTemplateCommands } from "./orgTemplate";
import { atomicJson, canonicalDirectory, readArtifact, substitute, validateTemplate, type OrgTemplate } from "./orgTemplateArtifact";
import { bindTemplate, installTemplate, quoteTemplateArg, readReceipt, receiptPath, reconcileTemplate, templateInstructions, templateStatus, upgradeTemplate, type TemplateOptions } from "./orgTemplateRun";
import type { OrgInitDeps } from "./orgInit";

const dirs: string[] = [];
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "org-template-")); dirs.push(dir); return canonicalDirectory(dir); };
afterEach(() => {
  const writable = (dir: string) => {
    fs.chmodSync(dir, 0o700);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) writable(path.join(dir, entry.name));
  };
  for (const dir of dirs.splice(0)) { writable(dir); fs.rmSync(dir, { recursive: true, force: true }); }
});
const manifest = (): OrgTemplate => ({ schemaVersion: 1, id: "growth", version: "1.2.0", name: "CMO", description: "One project CMO", role: { name: "CMO", handle: "{{instance}}-cmo", charter: "org/charter.md", caps: { hands_per_day: 4, wakes_per_day: 12, tokens_per_day: 200000 } }, routines: [{ id: "weekly", title: "CMO portfolio review", every: "7d", prompt: "org/weekly.md" }, { id: "ads", title: "Ads monitoring", every: "1d", prompt: "org/ads.md" }] });
function folder(m = manifest()): string {
  const root = tmp();
  fs.mkdirSync(path.join(root, "org"));
  fs.writeFileSync(path.join(root, "org-template.json"), JSON.stringify(m));
  fs.writeFileSync(path.join(root, "org/charter.md"), "Own {{project.name}} only. Read {{instance.file}}.");
  for (const r of m.routines) fs.writeFileSync(path.join(root, r.prompt), `Run ${r.id} for {{instance}} in {{project.dir}}. Read {{template.root}}.`);
  return root;
}
class Server {
  project: any;
  roles: any[] = [];
  anchors: any[] = [];
  stacks: any[] = [];
  decisions: any[] = [];
  triggers: any[] = [];
  work: any[] = [];
  calls: Array<{ endpoint: string; body: any }> = [];
  failAfter?: string;
  failBefore?: string;
  pauseWorks = true;
  standingPath?: string;
  constructor(readonly dir: string) { this.project = { _id: "project-1", short_id: "pr-1", title: "Product", project_path: dir, workspace: "team:team-1" }; }
  deps: OrgInitDeps = {
    readWorkspace: async (team) => ({ kind: "team", teamId: team || "unrelated-active-team" }),
    workspaceArgs: (ws) => ws.kind === "team" ? { team_id: ws.teamId } : {},
    workspaceLabel: (ws) => ws.kind,
    webUrl: () => "https://codecast.sh/",
    callingSession: () => undefined,
    realCwd: () => this.dir,
    cliPost: async (endpoint, body) => {
      this.calls.push({ endpoint, body });
      if (this.failBefore === endpoint) { this.failBefore = undefined; throw new Error("Connection lost before request"); }
      const result = this.route(endpoint, body);
      if (this.failAfter === endpoint) { this.failAfter = undefined; throw new Error("Connection lost after server success"); }
      return structuredClone(result);
    },
  };
  route(endpoint: string, body: any): any {
    switch (endpoint) {
      case "/cli/org/tree": return { workspace: body.team_id ? { kind: "team", id: body.team_id } : { kind: "user", id: "user-1" }, roles: this.roles, anchors: this.anchors };
      case "/cli/projects/get": return this.project._id === body.id ? this.project : null;
      case "/cli/stack/ls": return { stacks: this.stacks };
      case "/cli/stack/create": {
        const row = { _id: `stack-${this.stacks.length + 1}`, short_id: `ds-${this.stacks.length + 1}`, title: body.title, team_id: body.team_id, scope_user_id: body.team_id ? undefined : "user-1", status: "open" };
        this.stacks.push(row); return { id: row._id, short_id: row.short_id };
      }
      case "/cli/stack/show": return { stack: this.stacks.find((s) => s.short_id === body.stack), decisions: this.decisions };
      case "/cli/decide": {
        const row = { ...body, _id: "decision-1", short_id: "sd-1", status: "pending" }; this.decisions.push(row); return { id: row._id, short_id: row.short_id };
      }
      case "/cli/org/apply-decision": {
        const decision = this.decisions[0];
        if (decision.applied_at) return { status: "skipped", note: `already applied: ${decision.applied_note}` };
        if (decision.status !== "answered" || decision.answered_by?.kind !== "user") throw new Error("Human answer required");
        const base = extractOrgProposal(decision.context_md)!;
        const proposal: any = decision.answer_index === 1 ? applyProposalChanges(base, decision.answer_text).proposal : base;
        if (this.roles.some((r) => r.handle === proposal.handle)) return { status: "error", error: "Role handle exists" };
        const role = { _id: "role-1", short_id: "or-1", handle: proposal.handle, name: proposal.name, scope: { project_ids: [this.project._id], plan_ids: [] }, charter: proposal.charter, caps: proposal.caps, trust: "understand", status: "active" };
        this.roles.push(role); decision.applied_at = Date.now(); decision.applied_note = `created @${role.handle} (${role.short_id})`;
        return { status: "applied", role: { id: role._id, short_id: role.short_id }, note: decision.applied_note };
      }
      case "/cli/role/provision": {
        this.roles[0].anchor_id = "anchor-1";
        this.anchors = [{ anchor_id: "anchor-1", org_role_id: "role-1", conversation_id: "standing-1" }];
        return { anchor_id: "anchor-1", conversation_id: "standing-1" };
      }
      case "/cli/sessions": return { conversations: this.anchors.map((a) => ({ conversation_id: a.conversation_id, project_path: this.standingPath || this.dir })) };
      case "/cli/tasks/list": return this.triggers;
      case "/cli/tasks/create": {
        const row = { ...body, _id: `trigger-${this.triggers.length + 1}`, short_id: `tr-${this.triggers.length + 1}`, status: "scheduled", run_count: 0 };
        this.triggers.push(row); return { task_id: row._id, short_id: row.short_id };
      }
      case "/cli/tasks/pause": { if (this.pauseWorks) this.triggers.find((t) => t._id === body.task_id).status = "paused"; return { success: this.pauseWorks }; }
      case "/cli/tasks/update": Object.assign(this.triggers.find((t) => t._id === body.task_id), body); return { success: true };
      case "/cli/work/list": return { tasks: this.work.filter((t) => !body.label || (t.labels ?? []).includes(body.label)) };
      case "/cli/work/create": {
        const existing = this.work.find((t) => t.client_key === body.client_key);
        if (existing) return existing;
        const row = { ...body, _id: `work-${this.work.length + 1}`, short_id: `ct-${this.work.length + 1}` }; this.work.push(row); return row;
      }
      default: throw new Error(`Unexpected API: ${endpoint}`);
    }
  }
  approve(index = 0, by = "user") { Object.assign(this.decisions[0], { status: "answered", answer_index: index, answered_by: { kind: by } }); }
  writes() { return this.calls.filter((c) => /\/(create|decide|apply-decision|provision|pause|update)$/.test(c.endpoint)); }
}
function fixture() {
  const dir = tmp();
  const root = folder();
  const server = new Server(dir);
  const options: TemplateOptions = { dir, project: "project-1", team: "team-1", session: "session-1" };
  const install = () => installTemplate(server.deps, root, "product", options);
  const reconcile = () => reconcileTemplate(server.deps, "product", options);
  return { dir, root, server, options, install, reconcile };
}
async function ready() { const f = fixture(); await f.install(); f.server.approve(); await f.reconcile(); return f; }

describe("folder validation and pinning", () => {
  test("strict schema, unique routines, paths and tokens", () => {
    expect(() => validateTemplate({ ...manifest(), hooks: {} })).toThrow("unknown fields");
    const m = manifest(); m.routines.push(m.routines[0]); expect(() => validateTemplate(m)).toThrow("duplicate");
    for (const file of ["../escape", "/etc/passwd", "org/../secret", "org\\file"]) { const m = manifest(); m.role.charter = file; expect(() => validateTemplate(m)).toThrow("Unsafe artifact path"); }
    expect(() => substitute("{{unknown}}", {})).toThrow("Unknown template token");
    expect(() => substitute("{{instance", {})).toThrow("Malformed");
    expect(substitute("{{instance}}", { instance: "$(touch bad)" })).toBe("$(touch bad)");
  });
  test("normal macOS temp root works, in-artifact symlink escapes fail", () => {
    const root = folder();
    expect(readArtifact(root).manifest.id).toBe("growth");
    fs.symlinkSync(tmp(), path.join(root, "escape"));
    expect(() => readArtifact(root)).toThrow("Symlink refused");
  });
  test("snapshot preserves executable scripts and older version content stays pinned", async () => {
    const f = fixture(); fs.writeFileSync(path.join(f.root, "script.sh"), "exit 0\n", { mode: 0o755 });
    const receipt = await f.install(); expect(fs.statSync(path.join(receipt.template.root, "script.sh")).mode & 0o111).toBe(0o111);
    f.server.approve(); await f.reconcile(); const m = manifest(); m.version = "1.3.0";
    await upgradeTemplate(f.server.deps, "product", folder(m), { ...f.options, apply: true });
    fs.writeFileSync(path.join(f.root, "script.sh"), "exit 1\n");
    await expect(upgradeTemplate(f.server.deps, "product", f.root, f.options)).rejects.toThrow("already pinned with different content");
  });
  test("snapshot excludes mutable registry and git metadata, rejects instance state", async () => {
    const f = fixture(); fs.writeFileSync(path.join(f.root, "INSTANCES.toml"), "customer=secret");
    fs.mkdirSync(path.join(f.root, ".git")); fs.writeFileSync(path.join(f.root, ".git/config"), "private");
    const receipt = await f.install();
    expect(fs.existsSync(path.join(receipt.template.root, "INSTANCES.toml"))).toBe(false);
    fs.writeFileSync(path.join(f.root, "INSTANCES.toml"), "changed");
    expect(readArtifact(f.root).hash).toBe(receipt.template.hash);
    fs.mkdirSync(path.join(f.root, ".codecast")); expect(() => readArtifact(f.root)).toThrow("Mutable state");
  });
  test("source edits do not alter frozen copy; corrupt snapshot fails all runtime reads", async () => {
    const f = await ready(); const receipt = readReceipt(f.dir, "product");
    fs.writeFileSync(path.join(f.root, "org/weekly.md"), "new source");
    expect(readArtifact(receipt.template.root).hash).toBe(receipt.template.hash);
    await expect(f.install()).rejects.toThrow("explicit upgrade");
    const file = path.join(receipt.template.root, "org/weekly.md"); fs.chmodSync(file, 0o644); fs.writeFileSync(file, "corruption");
    await expect(templateInstructions(f.server.deps, "product", "charter", f.options)).rejects.toThrow("failed verification");
    await expect(f.reconcile()).rejects.toThrow("failed verification");
  });
  test("receipt release cannot redirect to an arbitrary or symlinked path", async () => {
    const f = fixture(); const receipt = await f.install(); receipt.template.root = f.root; atomicJson(receiptPath(f.dir, "product"), receipt);
    expect(() => readReceipt(f.dir, "product")).toThrow("outside its pinned");
    const other = fixture(); const r = await other.install(); const real = r.template.root + "-moved"; fs.chmodSync(r.template.root, 0o755); fs.renameSync(r.template.root, real); fs.symlinkSync(real, r.template.root);
    await expect(other.reconcile()).rejects.toThrow("Symlink refused");
  });
});

describe("proposal and lifecycle fake API", () => {
  test("install dry-run verifies project and adoption without any writes", async () => {
    const f = fixture();
    const r = await installTemplate(f.server.deps, f.root, "product", { ...f.options, dryRun: true });
    expect(r.proposal.scope?.projects).toEqual(["pr-1"]); expect(fs.existsSync(path.join(f.dir, ".codecast"))).toBe(false); expect(f.server.writes()).toHaveLength(0);
    await expect(installTemplate(f.server.deps, f.root, "product", { ...f.options, team: "wrong", dryRun: true })).rejects.toThrow("outside the selected workspace");
  });
  test("killed process lock and server-success receipt recover without duplication", async () => {
    const f = fixture(); f.server.failAfter = "/cli/stack/create"; await expect(f.install()).rejects.toThrow("after server success");
    const child = Bun.spawn([process.execPath, "-e", 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, at: Date.now() })); process.stdout.write("ready"); setInterval(() => {}, 1000)', receiptPath(f.dir, "product") + ".lock"], { stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader(); await reader.read(); child.kill("SIGKILL"); await child.exited;
    await f.install(); expect(f.server.stacks).toHaveLength(1); expect(f.server.decisions).toHaveLength(1);
  });
  test("fresh install only proposes one CMO; reruns preserve one stack and role", async () => {
    const f = fixture(); const receipt = await f.install(); await f.install();
    expect(f.server.stacks).toHaveLength(1); expect(f.server.decisions).toHaveLength(1); expect(f.server.roles).toHaveLength(0); expect(f.server.triggers).toHaveLength(0);
    expect(receipt.proposal.scope).toEqual({ projects: ["pr-1"], plans: [] });
    expect(f.server.decisions[0].options.map((o: any) => o.label)).toEqual(["Create as proposed", "Create with changes", "Skip"]);
    f.server.approve(); await f.reconcile(); await f.reconcile();
    expect(f.server.roles).toHaveLength(1); expect(f.server.triggers).toHaveLength(2);
    expect(f.server.calls.find((c) => c.endpoint === "/cli/org/apply-decision")?.body.provision).toBe(false);
    expect(f.server.calls.find((c) => c.endpoint === "/cli/role/provision")?.body.project_path).toBe(f.dir);
    for (const t of f.server.triggers) { expect(t.status).toBe("paused"); expect(t.precheck).toBe("exit 1"); expect(t.run_at).toBeGreaterThan(Date.now() + 300 * 86400000); expect(t.originating_conversation_id).toBe("standing-1"); expect(t.run_count).toBe(0); }
  });
  test("unanswered, rejected, advisory and delegated answers cannot create roles", async () => {
    const f = fixture(); await f.install(); await f.reconcile(); expect(f.server.roles).toHaveLength(0);
    f.server.approve(0, "role"); await expect(f.reconcile()).rejects.toThrow("answered by a person");
    f.server.approve(); f.server.decisions[0].blocking = false; await expect(f.reconcile()).rejects.toThrow("blocking decision");
    f.server.decisions[0].blocking = true; f.server.approve(2); expect((await f.reconcile()).phase).toBe("declined"); expect(f.server.roles).toHaveLength(0);
  });
  test("changed scope, changed proposal, and invalid trust stop before apply", async () => {
    const f = fixture(); await f.install(); f.server.approve(1);
    f.server.decisions[0].answer_text = '{"scope":{"projects":[]}}'; await expect(f.reconcile()).rejects.toThrow("Approved scope differs");
    f.server.decisions[0].answer_text = '{"trust":"act"}'; await expect(f.reconcile()).rejects.toThrow("start at understand");
    f.server.decisions[0].answer_text = ''; f.server.decisions[0].context_md = f.server.decisions[0].context_md.replace('"handle": "product-cmo"', '"handle": "other"');
    await expect(f.reconcile()).rejects.toThrow("Proposal changed"); expect(f.server.roles).toHaveLength(0);
  });
  for (const endpoint of ["/cli/stack/create", "/cli/decide", "/cli/org/apply-decision", "/cli/role/provision", "/cli/tasks/create", "/cli/tasks/pause"]) {
    test(`recovers server success before receipt update: ${endpoint}`, async () => {
      const f = fixture();
      if (["/cli/stack/create", "/cli/decide"].includes(endpoint)) { f.server.failAfter = endpoint; await expect(f.install()).rejects.toThrow("after server success"); await f.install(); }
      else { await f.install(); f.server.approve(); f.server.failAfter = endpoint; await expect(f.reconcile()).rejects.toThrow("after server success"); await f.reconcile(); }
      expect(f.server.stacks).toHaveLength(1); expect(f.server.decisions).toHaveLength(1); expect(f.server.roles.length).toBeLessThanOrEqual(1); expect(f.server.triggers.length).toBeLessThanOrEqual(2);
      expect(f.server.calls.filter((c) => c.endpoint === endpoint).length).toBe(endpoint === "/cli/org/apply-decision" ? 2 : endpoint === "/cli/tasks/create" || endpoint === "/cli/tasks/pause" ? 2 : 1);
    });
  }
  test("dead holder lock is recovered, live holder is never stolen", async () => {
    const f = fixture(); await f.install();
    const lock = receiptPath(f.dir, "product") + ".lock";
    fs.writeFileSync(lock, JSON.stringify({ pid: 999999999, at: Date.now() }));
    await f.install(); expect(f.server.stacks).toHaveLength(1);
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: 1 }));
    await expect(f.install()).rejects.toThrow("another `cast org template`"); expect(fs.existsSync(lock)).toBe(true); fs.unlinkSync(lock);
  });
  test("unknown create outcome stops rather than retrying blindly", async () => {
    const f = fixture(); f.server.failBefore = "/cli/stack/create";
    await expect(f.install()).rejects.toThrow("before request");
    await expect(f.install()).rejects.toThrow("outcome unknown"); expect(f.server.stacks).toHaveLength(0);
  });
  test("wrong project, workspace and missing explicit workspace fail before writes", async () => {
    for (const patch of [{ project: "missing" }, { team: "team-2" }, { team: undefined }, { team: "team-1", personal: true }]) {
      const f = fixture(); await expect(installTemplate(f.server.deps, f.root, "product", { ...f.options, ...patch })).rejects.toThrow(); expect(f.server.writes()).toHaveLength(0);
    }
    const f = fixture(); await f.install(); const writes = f.server.writes().length; await expect(reconcileTemplate(f.server.deps, "product", { ...f.options, team: "team-2" })).rejects.toThrow("Workspace"); expect(f.server.writes()).toHaveLength(writes);
  });
  test("one project on two hosts uses the approved local directory, never global metadata", async () => {
    const f = fixture(); f.server.project.project_path = "/Users/another-person/dev/product";
    const preview = await installTemplate(f.server.deps, f.root, "product", { ...f.options, dryRun: true });
    expect(preview.project.dir).toBe(f.dir); expect(preview.warnings?.[0]).toContain("another-person"); expect(f.server.writes()).toHaveLength(0);
    await f.install(); expect(f.server.decisions[0].context_md).toContain(f.dir); expect(f.server.decisions[0].context_md).toContain("another-person");
    f.server.approve(); await f.reconcile(); expect(f.server.calls.find((c) => c.endpoint === "/cli/role/provision")?.body.project_path).toBe(f.dir);
    f.server.project.project_path = "/home/third-person/product";
    const status = await templateStatus(f.server.deps, "product", f.options);
    expect(status.project.dir).toBe(f.dir); expect(status.warnings.join(" ")).toContain("changed since approval");
    const repeat = await installTemplate(f.server.deps, f.root, "product", { ...f.options, dryRun: true }); expect(repeat.warnings?.join(" ")).toContain("changed since approval");
    await f.reconcile(); expect(readReceipt(f.dir, "product").project.dir).toBe(f.dir);
    await expect(reconcileTemplate(f.server.deps, "product", { ...f.options, dir: tmp() })).rejects.toThrow();
    f.server.project.workspace = "team:other"; await expect(f.reconcile()).rejects.toThrow("outside the selected workspace");
  });
  test("personal workspace is explicitly pinned regardless of active team", async () => {
    const f = fixture(); f.server.project.workspace = "user:user-1"; f.options.team = undefined; f.options.personal = true;
    const r = await f.install(); expect(r.workspace.kind).toBe("user"); expect(f.server.stacks[0].team_id).toBeUndefined();
    expect(f.server.calls.find((c) => c.endpoint === "/cli/stack/create")?.body.session_id).toBeUndefined();
  });
  test("wrong standing path, scope drift and failed pause prevent ready", async () => {
    const f = fixture(); await f.install(); f.server.approve(); f.server.standingPath = tmp();
    await expect(f.reconcile()).rejects.toThrow("pinned project directory"); expect(f.server.triggers).toHaveLength(0);
    f.server.standingPath = f.dir; f.server.pauseWorks = false;
    await expect(f.reconcile()).rejects.toThrow("Pause verification failed"); expect(readReceipt(f.dir, "product").phase).toBe("provisioning"); expect(f.server.triggers[0].precheck).toBe("exit 1");
    f.server.pauseWorks = true; await f.reconcile(); f.server.roles[0].scope.project_ids = [];
    await expect(f.reconcile()).rejects.toThrow("exactly the instance project");
  });
  test("human charter changes are applied once and never overwritten", async () => {
    const f = fixture(); await f.install(); f.server.approve(1); f.server.decisions[0].answer_text = '{"charter":"Only report, never buy", "handle":"approved-cmo"}';
    await f.reconcile(); expect(f.server.roles[0].charter).toBe("Only report, never buy"); expect(readReceipt(f.dir, "product").role?.handle).toBe("approved-cmo");
    f.server.roles[0].charter = "Later human charter"; await f.reconcile(); expect(f.server.roles[0].charter).toBe("Later human charter");
  });
  test("status and instructions read only; paused/gated routines refuse execution", async () => {
    const f = await ready(); const count = f.server.writes().length;
    await templateStatus(f.server.deps, "product", f.options);
    await expect(templateInstructions(f.server.deps, "product", "weekly", f.options)).rejects.toThrow("paused or gated");
    f.server.triggers[0].status = "scheduled"; f.server.triggers[0].precheck = undefined;
    expect(await templateInstructions(f.server.deps, "product", "weekly", f.options)).toContain("growth@1.2.0");
    expect(f.server.writes()).toHaveLength(count);
  });
  test("activation guidance preserves a custom human precheck", async () => {
    const f = await ready(); f.server.triggers[0].precheck = "test -f ready.txt";
    const status = await templateStatus(f.server.deps, "product", f.options);
    expect(status.routines.weekly.gated).toBe(true); expect(status.routines.weekly.activation.commands).toEqual([]);
    expect(f.server.triggers[0].precheck).toBe("test -f ready.txt");
  });
});

describe("upgrades and adoption", () => {
  test("content-only upgrade and recovery wait for a running managed routine", async () => {
    const f = await ready(); const original = readReceipt(f.dir, "product"); const m = manifest(); m.version = "1.3.0"; const next = folder(m);
    fs.writeFileSync(path.join(next, "org/weekly.md"), "New instructions"); f.server.triggers[0].status = "running";
    await expect(upgradeTemplate(f.server.deps, "product", next, { ...f.options, apply: true })).rejects.toThrow("must finish");
    expect(readReceipt(f.dir, "product").template.hash).toBe(original.template.hash); expect(readReceipt(f.dir, "product").upgrade).toBeUndefined();
    f.server.triggers[0].status = "paused"; m.routines[0].every = "14d"; const changed = folder(m); f.server.failAfter = "/cli/tasks/update";
    await expect(upgradeTemplate(f.server.deps, "product", changed, { ...f.options, apply: true })).rejects.toThrow();
    f.server.triggers[1].status = "running";
    await expect(upgradeTemplate(f.server.deps, "product", changed, { ...f.options, apply: true })).rejects.toThrow("must finish");
    expect(readReceipt(f.dir, "product").phase).toBe("upgrading"); expect(readReceipt(f.dir, "product").template.hash).toBe(original.template.hash);
  });
  test("failed added routine leaves upgrading state and blocks runtime and reconcile", async () => {
    const f = await ready(); const m = manifest(); m.version = "1.3.0"; m.routines.push({ id: "social", title: "Social", every: "3d", prompt: "org/social.md" });
    f.server.failBefore = "/cli/tasks/create";
    await expect(upgradeTemplate(f.server.deps, "product", folder(m), { ...f.options, apply: true })).rejects.toThrow("before request");
    const status = await templateStatus(f.server.deps, "product", f.options); expect(status.phase).toBe("upgrading"); expect(status.upgrade.from.version).toBe("1.2.0"); expect(status.upgrade.to.version).toBe("1.3.0");
    expect(status.routines.weekly.activation).toBeUndefined();
    await expect(templateInstructions(f.server.deps, "product", "weekly", f.options)).rejects.toThrow("pending");
    await expect(f.reconcile()).rejects.toThrow("upgrade is incomplete");
  });
  for (const direction of ["forward", "rollback"] as const) {
    test(`lost cadence response recovers ${direction} without calling its own write a human override`, async () => {
      const f = await ready(); const m = manifest(); m.version = "1.3.0"; m.routines[0].every = "14d"; m.routines[1].every = "2d"; const next = folder(m);
      f.server.failAfter = "/cli/tasks/update";
      await expect(upgradeTemplate(f.server.deps, "product", next, { ...f.options, apply: true })).rejects.toThrow("after server success");
      const pending = readReceipt(f.dir, "product"); expect(pending.phase).toBe("upgrading"); expect(pending.upgrade?.cadence.weekly.before).toBe(7 * 86400000); expect(f.server.triggers[0].interval_ms).toBe(14 * 86400000);
      const result = await upgradeTemplate(f.server.deps, "product", direction === "forward" ? next : f.root, { ...f.options, apply: true });
      expect(result.unchanged).toBeUndefined(); expect(result.recovery).toBe(direction); expect(result.receipt.phase).toBe("ready"); expect(result.receipt.upgrade).toBeUndefined();
      expect(f.server.triggers[0].interval_ms).toBe((direction === "forward" ? 14 : 7) * 86400000); expect(f.server.triggers[1].interval_ms).toBe((direction === "forward" ? 2 : 1) * 86400000);
      expect(f.server.triggers.every((r) => r.status === "paused")).toBe(true);
    });
  }
  test("interrupted rollback can retry without resuming or duplicating routines", async () => {
    const f = await ready(); const m = manifest(); m.version = "1.3.0"; m.routines[0].every = "14d"; const next = folder(m);
    f.server.failAfter = "/cli/tasks/update"; await expect(upgradeTemplate(f.server.deps, "product", next, { ...f.options, apply: true })).rejects.toThrow();
    f.server.failAfter = "/cli/tasks/update"; await expect(upgradeTemplate(f.server.deps, "product", f.root, { ...f.options, apply: true })).rejects.toThrow();
    expect(readReceipt(f.dir, "product").upgrade?.direction).toBe("rollback");
    await upgradeTemplate(f.server.deps, "product", f.root, { ...f.options, apply: true }); expect(f.server.triggers[0].interval_ms).toBe(7 * 86400000); expect(f.server.triggers).toHaveLength(2);
  });
  test("human drift during an interrupted upgrade is never overwritten by recovery", async () => {
    const f = await ready(); const m = manifest(); m.version = "1.3.0"; m.routines[0].every = "14d"; const next = folder(m);
    f.server.failAfter = "/cli/tasks/update"; await expect(upgradeTemplate(f.server.deps, "product", next, { ...f.options, apply: true })).rejects.toThrow();
    f.server.triggers[0].interval_ms = 3 * 86400000;
    for (const source of [next, f.root]) await expect(upgradeTemplate(f.server.deps, "product", source, { ...f.options, apply: true })).rejects.toThrow("outside this upgrade");
    expect(f.server.triggers[0].interval_ms).toBe(3 * 86400000); expect(readReceipt(f.dir, "product").phase).toBe("upgrading");
    const newer = manifest(); newer.version = "1.4.0"; await expect(upgradeTemplate(f.server.deps, "product", folder(newer), { ...f.options, apply: true })).rejects.toThrow("upgrade is incomplete");
  });
  test("rollback after added trigger server success retains and pauses its id", async () => {
    const f = await ready(); const m = manifest(); m.version = "1.3.0"; m.routines.push({ id: "social", title: "Social", every: "3d", prompt: "org/social.md" });
    const next = folder(m);
    f.server.failAfter = "/cli/tasks/create"; await expect(upgradeTemplate(f.server.deps, "product", next, { ...f.options, apply: true })).rejects.toThrow();
    const result = await upgradeTemplate(f.server.deps, "product", f.root, { ...f.options, apply: true });
    expect(result.receipt.template.version).toBe("1.2.0"); expect(result.receipt.routines.social.retired).toBe(true); expect(result.receipt.routines.social.triggerId).toBe(f.server.triggers[2]._id); expect(f.server.triggers[2].status).toBe("paused");
    expect(f.server.triggers[2].precheck).toBe("exit 1"); expect(result.receipt.routines.social.attempted).toBe(false);
    const forward = await upgradeTemplate(f.server.deps, "product", next, { ...f.options, apply: true });
    expect(forward.receipt.routines.social.triggerId).toBe(result.receipt.routines.social.triggerId); expect(forward.receipt.routines.social.retired).toBe(false); expect(f.server.triggers).toHaveLength(3);
  });
  test("interrupted upgrade reruns finish the same new routine without duplicates", async () => {
    const f = await ready(); const m = manifest(); m.version = "1.3.0"; m.routines.push({ id: "social", title: "Social", every: "1d", prompt: "org/social.md" });
    const source = folder(m); f.server.failAfter = "/cli/tasks/create";
    await expect(upgradeTemplate(f.server.deps, "product", source, { ...f.options, apply: true })).rejects.toThrow("after server success");
    const r = await upgradeTemplate(f.server.deps, "product", source, { ...f.options, apply: true });
    expect(r.applied).toBe(true); expect(f.server.triggers).toHaveLength(3); expect(f.server.triggers[2].status).toBe("paused");
  });
  test("preview is read only; preserve ids, human charter, caps, grants and pauses", async () => {
    const f = await ready();
    const receipt: any = readReceipt(f.dir, "product"); receipt.grants = { ads: 0 }; saveReceipt(f.dir, receipt);
    f.server.roles[0].charter = "Human charter"; f.server.roles[0].trust = "propose";
    f.server.triggers[0].status = "scheduled"; f.server.triggers[0].precheck = undefined;
    const m = manifest(); m.version = "1.3.0"; m.routines = [m.routines[0], { id: "social", title: "Social", every: "3d", prompt: "org/social.md" }];
    const next = folder(m); const originalWrites = f.server.writes().length;
    const preview = await upgradeTemplate(f.server.deps, "product", next, f.options);
    expect(preview.added).toEqual(["social"]); expect(preview.removed).toEqual(["ads"]); expect(f.server.writes()).toHaveLength(originalWrites);
    const applied = await upgradeTemplate(f.server.deps, "product", next, { ...f.options, apply: true });
    expect(applied.receipt.role).toEqual(receipt.role); expect(applied.receipt.grants).toEqual({ ads: 0 }); expect(f.server.roles[0].charter).toBe("Human charter"); expect(f.server.roles[0].trust).toBe("propose");
    expect(f.server.triggers[0].status).toBe("scheduled"); expect(f.server.triggers[1].status).toBe("paused"); expect(f.server.triggers[2].status).toBe("paused");
    expect(applied.receipt.routines.ads.retired).toBe(true);
    await expect(templateInstructions(f.server.deps, "product", "ads", f.options)).rejects.toThrow("retired");
  });
  test("same-version changed digest and caps changes require explicit human path", async () => {
    const f = await ready(); fs.writeFileSync(path.join(f.root, "org/weekly.md"), "changed");
    await expect(upgradeTemplate(f.server.deps, "product", f.root, { ...f.options, apply: true })).rejects.toThrow("Same-version");
    const m = manifest(); m.version = "1.3.0"; m.role.caps.hands_per_day = 100;
    await expect(upgradeTemplate(f.server.deps, "product", folder(m), { ...f.options, apply: true })).rejects.toThrow("identity or caps");
  });
  test("explicit adoption never duplicates or rewrites existing channel triggers", async () => {
    const f = fixture(); const external = { _id: "external-1", short_id: "tr-462", project_path: f.dir, originating_conversation_id: "old-standing-session", status: "scheduled", prompt: "existing channel", interval_ms: 3 * 86400000 };
    f.server.triggers.push(structuredClone(external)); f.options.adopt = ["ads=tr-462"];
    await f.install(); f.server.approve(); await f.reconcile();
    expect(f.server.triggers.filter((t) => t._id === "external-1")).toEqual([external]); expect(f.server.triggers).toHaveLength(2);
    const m = manifest(); m.version = "1.3.0"; m.routines[1].every = "2d";
    const result = await upgradeTemplate(f.server.deps, "product", folder(m), { ...f.options, apply: true });
    expect(result.receipt.routines.ads.actualIntervalMs).toBe(3 * 86400000); expect(f.server.triggers[0]).toEqual(external);
    expect(result.cadenceOverrides).toContainEqual({ id: "ads", interval_ms: 3 * 86400000, external: true });
  });
  test("adoption requires exact known trigger and matching directory", async () => {
    const f = fixture(); f.server.triggers.push({ _id: "external", short_id: "tr-10", project_path: tmp() });
    await expect(installTemplate(f.server.deps, f.root, "product", { ...f.options, adopt: ["ads=tr-10"] })).rejects.toThrow("different project");
    expect(f.server.stacks).toHaveLength(0); expect(f.server.triggers).toHaveLength(1);
  });
  test("live cadence override survives manifest change; unchanged managed cadence is updated paused", async () => {
    const f = await ready(); f.server.triggers[1].interval_ms = 3 * 86400000;
    const m = manifest(); m.version = "1.3.0"; m.routines[0].every = "2w"; m.routines[1].every = "2d";
    const result = await upgradeTemplate(f.server.deps, "product", folder(m), { ...f.options, apply: true });
    expect(f.server.triggers[0].interval_ms).toBe(14 * 86400000); expect(f.server.triggers[0].status).toBe("paused");
    expect(f.server.triggers[1].interval_ms).toBe(3 * 86400000); expect(result.cadenceOverrides[0].id).toBe("ads");
  });
  test("removed external routine is recorded retired without changing its server object", async () => {
    const f = fixture(); const external = { _id: "external", short_id: "tr-10", project_path: f.dir, status: "scheduled", interval_ms: 86400000 };
    f.server.triggers.push({ ...external }); f.options.adopt = ["ads=tr-10"]; await f.install(); f.server.approve(); await f.reconcile();
    const m = manifest(); m.version = "1.3.0"; m.routines = [m.routines[0]];
    await upgradeTemplate(f.server.deps, "product", folder(m), { ...f.options, apply: true }); expect(f.server.triggers[0]).toEqual(external);
  });
});
function saveReceipt(dir: string, receipt: any) { atomicJson(receiptPath(dir, receipt.instance), receipt); }

describe("manifest v2 hires", () => {
  test("answers substitute into the handle, charter, routine titles and instructions; secrets never enter the receipt", async () => {
    const m: any = { ...manifest(), schemaVersion: 2, version: "2.0.0", inputs: [
      { key: "product.slug", label: "Short name", kind: "string", required: true },
      { key: "budget.monthly_envelope_usd", label: "Envelope", kind: "money", required: true },
      { key: "accounts.ads", label: "Ads credentials", kind: "secret" },
      { key: "voice", label: "Voice", kind: "choice", choices: ["plain", "playful"], default: "plain" },
    ], authority: [{ id: "ads-spend", kind: "spend", label: "Paid search", limit: { usd_per_month: "{{input.budget.monthly_envelope_usd}}" }, requires: ["accounts.ads"] }] };
    m.role.handle = "{{input.product.slug}}-cmo";
    m.routines[1].title = "Ads for {{input.product.slug}}";
    m.routines[1].requires = { authority: ["ads-spend"] };
    const source = folder(m);
    fs.writeFileSync(path.join(source, "org/charter.md"), "Own {{project.name}} as {{input.product.slug}} within {{input.budget.monthly_envelope_usd}} a month, voice {{input.voice}}.");
    const server = new Server(tmp());
    const options: TemplateOptions = { dir: server.dir, project: "project-1", team: "team-1", session: "sess-1", input: ["product.slug=acme", "budget.monthly_envelope_usd=300"] };
    await expect(installTemplate(server.deps, source, "acme-growth", { ...options, input: ["product.slug=acme"] })).rejects.toThrow(/Required input not answered/);
    await installTemplate(server.deps, source, "acme-growth", options);
    const receipt = readReceipt(server.dir, "acme-growth");
    expect(receipt.config).toEqual({ "product.slug": "acme", "budget.monthly_envelope_usd": "300", voice: "plain" });
    expect(receipt.proposal.handle).toBe("acme-cmo");
    expect(JSON.stringify(receipt)).not.toContain("accounts.ads");
    expect(server.decisions[0].context_md).toContain("Own Product as acme within 300 a month, voice plain.");
    server.approve();
    await reconcileTemplate(server.deps, "acme-growth", options);
    expect(server.triggers.map((t: any) => t.title)).toContain("Ads for acme");
    const text = await templateInstructions(server.deps, "acme-growth", "charter", options);
    expect(text).toContain("as acme within 300 a month, voice plain");
  });
  test("bind writes the instance file, binds secrets by hash only, and finds or creates ledgers by marker", async () => {
    const m: any = { ...manifest(), schemaVersion: 2, version: "2.0.0", instance_file: ".codecast/packs/growth.toml", inputs: [
      { key: "product.slug", label: "Short name", kind: "string", required: true },
      { key: "accounts.ads", label: "Ads credentials", kind: "secret" },
    ], ledgers: [{ id: "cmo", title: "CMO ledger for {{input.product.slug}}" }, { id: "ads", title: "Ads ledger" }] };
    const source = folder(m);
    const server = new Server(tmp());
    const options: TemplateOptions = { dir: server.dir, project: "project-1", team: "team-1", session: "sess-1", input: ["product.slug=acme"] };
    await installTemplate(server.deps, source, "acme-growth", options);
    await expect(bindTemplate(server.deps, "acme-growth", options)).rejects.toThrow(/reconcile first/);
    server.approve();
    await reconcileTemplate(server.deps, "acme-growth", options);
    const secret = path.join(tmp(), "ads.json");
    fs.writeFileSync(secret, "{\"token\":\"never-copied\"}", { mode: 0o644 });
    await expect(bindTemplate(server.deps, "acme-growth", { ...options, secret: [`accounts.ads=${secret}`] })).rejects.toThrow(/chmod 600/);
    fs.chmodSync(secret, 0o600);
    await expect(bindTemplate(server.deps, "acme-growth", { ...options, secret: ["product.slug=" + secret] })).rejects.toThrow(/Not a secret input/);
    // An older ledger with the marker already exists in the project: adopted, not duplicated.
    server.work.push({ _id: "work-old", short_id: "ct-41", title: "Ads ledger (old)", labels: ["ledger", `org-template:${readReceipt(server.dir, "acme-growth").key}:ledger:ads`] });
    const bound = await bindTemplate(server.deps, "acme-growth", { ...options, secret: [`accounts.ads=${secret}`] });
    expect(bound.ledgers).toEqual({ cmo: { taskId: "work-1", shortId: "ct-1" }, ads: { taskId: "work-old", shortId: "ct-41" } });
    expect(server.work.find((t) => t.short_id === "ct-1")).toMatchObject({ title: "CMO ledger for acme", task_type: "chore", project_id: "project-1" });
    expect(bound.bindings!["accounts.ads"]).toMatchObject({ host: expect.any(String), path_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const receiptText = fs.readFileSync(receiptPath(server.dir, "acme-growth"), "utf8");
    expect(receiptText).not.toContain("never-copied");
    expect(receiptText).not.toContain(secret);
    const instanceFile = fs.readFileSync(path.join(server.dir, ".codecast/packs/growth.toml"), "utf8");
    expect(Bun.TOML.parse(instanceFile)).toEqual({ product: { slug: "acme" }, accounts: { ads: secret }, ledgers: { cmo: "ct-1", ads: "ct-41" } });
    expect(instanceFile).not.toContain("never-copied");
    // Rerun: nothing new created, same ledgers.
    const again = await bindTemplate(server.deps, "acme-growth", options);
    expect(again.ledgers).toEqual(bound.ledgers);
    expect(server.work).toHaveLength(2);
  });
});

test("registers lazy org template commands and UI install flags", () => {
  const program = new Command(); program.command("org"); registerOrgTemplateCommands(program, new Server(tmp()).deps);
  const template = program.commands[0].commands[0]; expect(template.name()).toBe("template");
  expect(template.commands.map((c) => c.name())).toEqual(["inspect", "install", "status", "reconcile", "upgrade", "instructions"]);
  expect(template.commands.find((c) => c.name() === "install")!.options.map((o) => o.long)).toEqual(expect.arrayContaining(["--instance", "--project", "--dir", "--team", "--personal", "--adopt"]));
});

test("loader and follow-up shell arguments remain literal", () => {
  const value = "/tmp/it's $(printf INJECTED) `printf INJECTED`";
  const result = spawnSync("bash", ["-c", `printf '%s' ${quoteTemplateArg(value)}`], { encoding: "utf8" });
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message }).toEqual({ status: 0, stdout: value, stderr: "", error: undefined });
});
