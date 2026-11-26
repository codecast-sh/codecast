// The body of migrations.releaseFolderHeldSessions (its comment there says
// what it releases and keeps), apart from migrations.ts so the migration list
// stays a list. Called directly by its test with a plain { db, scheduler }.
import { rolesInBoundary } from "./lib/orgAccess";
import { sessionWork } from "./lib/orgOwnership";
import { ownsWork } from "@codecast/shared/contracts/orgLead";
import { roleSubject, withOrgChange } from "./lib/orgChangeLog";
import { performReparentSession } from "./sessionOwnership";
import { isHandBriefing } from "./spawn";

export async function releaseFolderHeld(ctx: { db: any; scheduler?: any }, args: { dryRun?: boolean; team?: string; role?: string; limit?: number }) {
  {
    const dryRun = args.dryRun ?? true;
    const limit = args.limit ?? 200;
    let roles = (await ctx.db.query("org_roles").collect()).filter((r: any) => r.status !== "retired");
    if (args.team) roles = roles.filter((r: any) => String(r.team_id ?? "") === args.team);
    if (args.role) {
      const handle = args.role.replace(/^@/, "").toLowerCase();
      roles = roles.filter((r: any) => r.handle === handle);
    }
    const byBoundary = new Map<string, any[]>();
    for (const r of roles) {
      const key = r.team_id ? `team:${r.team_id}` : `user:${r.scope_user_id}`;
      byBoundary.set(key, [...(byBoundary.get(key) ?? []), r]);
    }
    const rows: Array<{ role: string; session: string; title: string; state: string; work: string; updated_at: number; verdict: "release" | "keep" | "skip"; reason: string; return_to?: string }> = [];
    let released = 0;
    let stamped = 0;
    // A takeover leaves no row of its own per session: it folds into the row
    // of the change that caused it (lib/orgChangeLog noteOrgChange), listing
    // the sessions in `effects.takeover.sessions`. Read once per boundary, so
    // a released session can say which change took it.
    const takenBy = new Map<string, string>();
    for (const key of byBoundary.keys()) {
      const changes: any[] = await ctx.db.query("org_changes").withIndex("by_workspace_seq", (q: any) => q.eq("workspace", key)).collect();
      for (const ch of changes) {
        const t = ch.effects?.takeover;
        if (!t?.sessions?.length) continue;
        const batch: any = await ctx.db.get(ch.batch);
        const label = batch?.proposal?.short_id ?? `${ch.kind} change`;
        for (const s of t.sessions) if (s?.conversation_id) takenBy.set(String(s.conversation_id), label);
      }
    }
    for (const role of roles as any[]) {
      const boundaryRoles = await rolesInBoundary(ctx, role);
      const held: any[] = await ctx.db.query("conversations").withIndex("by_org_role", (q: any) => q.eq("org_role_id", role._id)).collect();
      const toRelease: any[] = [];
      for (const c of held) {
        if (c.standing_role_id || c.anchor_id) continue;
        const shortId = c.short_id ?? String(c._id).slice(0, 7);
        const state = c.inbox_killed_at ? "killed" : c.status ?? "active";
        const base = { role: role.handle, session: shortId, title: (c.title ?? "").trim(), state, work: c.thread_state_status ?? "-", updated_at: c.updated_at ?? 0 };
        if (c.inbox_killed_at) { rows.push({ ...base, verdict: "skip", reason: "killed: a retired row nobody reads" }); continue; }
        const keep = async (reason: string, hold: "bound" | "filed") => {
          rows.push({ ...base, verdict: "keep", reason });
          if (!dryRun && c.org_role_hold !== hold) { await ctx.db.patch(c._id, { org_role_hold: hold }); stamped++; }
        };
        if (ownsWork(role, await sessionWork(ctx, c), boundaryRoles)) { await keep("bound to work in its area", "bound"); continue; }
        if (c.org_role_hold === "filed") { await keep("filed by a person or role", "filed"); continue; }
        // Started by the role's line: a line run, a hand whose parent chain
        // reaches the role's standing session, or a hand briefed as one.
        let viaLine = !!c.workflow_run_id;
        let cur = c;
        for (let depth = 0; !viaLine && cur?.parent_conversation_id && depth < 8; depth++) {
          cur = await ctx.db.get(cur.parent_conversation_id);
          if (cur && String(cur.standing_role_id ?? "") === String(role._id)) viaLine = true;
        }
        if (!viaLine) {
          const first: any = await ctx.db.query("messages").withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", c._id)).order("asc").first();
          viaLine = isHandBriefing(first?.content);
        }
        if (viaLine) { await keep("started by the role's own line", "filed"); continue; }
        // The org log: a person's or role's own filing is a batch of kind
        // session; a takeover folds into a scope, role or hire batch.
        const last: any = await ctx.db.query("org_changes").withIndex("by_subject", (q: any) => q.eq("subject.id", String(c._id))).order("desc").first();
        const batch: any = last?.batch ? await ctx.db.get(last.batch) : null;
        const kinds = batch ? Object.keys(batch.kinds ?? {}) : [];
        if (batch && kinds.every((k) => k === "session")) { await keep(`filed by a person or role (${batch.door})`, "filed"); continue; }
        const returnTo = String(c.owner_user_id ?? c.user_id);
        const taken = takenBy.get(String(c._id)) ?? (batch ? `${kinds.join("+")} batch` : null);
        rows.push({ ...base, verdict: "release", reason: taken ? `taken over by the folder rule (${taken})` : `no record (folder ${c.project_path ?? "unknown"})`, return_to: returnTo });
        toRelease.push(c);
      }
      if (dryRun || !toRelease.length) continue;
      const slice = toRelease.slice(0, Math.max(0, limit - released));
      if (!slice.length) continue;
      await withOrgChange(ctx, role.host_user_id, { kind: "scope", subject: roleSubject(role), door: "cli", gesture: "command" }, async () => {
        for (const c of slice) {
          const starter = c.owner_user_id ?? c.user_id;
          await performReparentSession(ctx, starter, { session_id: String(c._id), target: { kind: "user", user_id: starter, mode: "add" }, note: `Folders decide nothing now: this session was under @${role.handle} only because of the folder it runs in.` });
          released++;
        }
      });
    }
    const counts = {
      release: rows.filter((r) => r.verdict === "release").length,
      release_live: rows.filter((r) => r.verdict === "release" && r.state === "active" && r.work !== "done").length,
      keep: rows.filter((r) => r.verdict === "keep").length,
      skipped: rows.filter((r) => r.verdict === "skip").length,
    };
    return { dryRun, roles: roles.length, ...counts, released, stamped, rows };
  }
}
