"use client";
// The scope page's Settings tab (docs/architecture/scopes-and-feed.md F3;
// org-roles-standing.md T4, T6): the scope editor with overlap warnings, who
// the role reports to, trust stage, daily caps, host and model, the channels it
// follows, and retire. Every edit is a store action that paints in the same
// tick and rides dispatch to the orgRoles mutation.
import { useMemo, useState } from "react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import Link from "next/link";
import { TriangleAlert, Hash, MessageSquare, Trash2 } from "lucide-react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../../../store/inboxStore";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { useWorkflows } from "../../../hooks/useSyncWorkflows";
import { lineOptions } from "./lineBoard";
import { lineIntentEchoed, orgRoleReparentMakesCycle, type OrgIntent, type OrgUpdateRoleInput } from "../../../store/orgSlice";
import { SelectBox } from "../../ui/select-box";
import { cn } from "../../../lib/utils";
import { InlineEdit, ScopeEditor } from "../OrgScopePanel";
import { parentName } from "../orgMeta";
import { RetireRoleConfirm } from "../RetireRoleConfirm";
import { sameParent, type OrgParentRef, type OrgRole, type OrgTree } from "../orgTypes";
import { DEFAULT_CAPS, TRUST_META, TRUST_STAGES, type RoleCaps, type RoleCounters, type ScopeOverlap, type TrustStage } from "./scopeTypes";

const NO_INTENTS: OrgIntent[] = [];

const api = _api as any;

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border px-4 py-3.5" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 28%, transparent)", background: "var(--sol-card)" }}>
      <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>{title}</h3>
      {hint && <p className="mt-0.5 text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>{hint}</p>}
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

export function OverlapWarning({ overlaps, projectName, planName }: { overlaps: ScopeOverlap[]; projectName: (id: string) => string; planName: (id: string) => string }) {
  if (overlaps.length === 0) return null;
  return (
    <div className="mt-2.5 rounded-lg px-3 py-2 border flex items-start gap-2" style={{ borderColor: "color-mix(in srgb, var(--sol-yellow) 40%, transparent)", background: "color-mix(in srgb, var(--sol-yellow) 7%, transparent)" }}>
      <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-[2px]" style={{ color: "var(--sol-yellow)" }} />
      <div className="text-[12px] min-w-0" style={{ color: "var(--sol-text-secondary)" }}>
        {overlaps.map((o) => (
          <p key={o.role_id} className="truncate">
            <Link href={`/org/${o.short_id}`} className="font-medium hover:underline" style={{ color: "var(--sol-text)" }}>{o.name}</Link>
            <span style={{ color: "var(--sol-text-dim)" }}> @{o.handle}</span> also watches {[...o.project_ids.map(projectName), ...o.plan_ids.map(planName)].join(", ")}.
          </p>
        ))}
      </div>
    </div>
  );
}

export type ScopeSettingsProps = {
  tree: OrgTree;
  role: OrgRole;
  canEdit: boolean;
  overlaps: ScopeOverlap[];
  hostName: string;
  model: string | null;
  /** Today's counters, already checked against the UTC day by the header. */
  counters: RoleCounters | null;
  /** The header's Retire lands here with the confirmation open. */
  armRetire?: boolean;
  onUpdate: (fields: OrgUpdateRoleInput) => void;
  onReparent: (target: OrgParentRef) => void;
  /** S16: for the chief of staff the confirm also says what becomes of its
   *  standing agent; any other seat passes nothing and the server decides. */
  onRetire: (standingSession?: "keep" | "retire") => void;
};

export function ScopeSettings({ tree, role, canEdit, overlaps, hostName, model, counters, armRetire, onUpdate, onReparent, onRetire }: ScopeSettingsProps) {
  const [confirmRetire, setConfirmRetire] = useState(!!armRetire);
  // Keeping the standing agent is the default (S16).
  useWatchEffect(() => { if (armRetire) setConfirmRetire(true); }, [armRetire]);
  const caps: RoleCaps = role.caps ?? DEFAULT_CAPS;
  const [capsDraft, setCapsDraft] = useState<RoleCaps>(caps);
  // The server value moves under the tab (a `cast role caps`, another window,
  // the echo after Save): the draft follows it, so Save never offers to write
  // stale numbers back over the change that just landed.
  useWatchEffect(() => { setCapsDraft(caps); }, [caps.hands_per_day, caps.wakes_per_day, caps.tokens_per_day]);
  const capsDirty = capsDraft.hands_per_day !== caps.hands_per_day || capsDraft.wakes_per_day !== caps.wakes_per_day || capsDraft.tokens_per_day !== caps.tokens_per_day;
  const trust: TrustStage = role.trust ?? "understand";
  const channels = useInboxStore((s) => (s as any).chatChannels as Record<string, any> | undefined);
  const followed = useMemo(() => (role.follow_channel_ids ?? []).map((id) => ({ id, name: channels?.[id]?.name ?? id.slice(0, 8) })), [role.follow_channel_ids, channels]);

  // The line (the-line.md L2). The org tree does not carry the slug, so the
  // tab reads it once per view from orgRoles.line; the store's line intent
  // (setRoleLine) wins until that read echoes the slug, which is when the
  // intent is dropped: the tree cannot settle it on its own.
  const { data: lineRow } = useQueryNoThrow(api.orgRoles.line, { role_id: role._id });
  const { workflows } = useWorkflows();
  const lineSlug: string = (role as any).line_workflow_slug ?? lineRow?.line_workflow_slug ?? "line";
  const lineChoices = useMemo(() => lineOptions(workflows, lineSlug), [workflows, lineSlug]);
  const setRoleLine = useInboxStore((s) => (s as any).setRoleLine as (roleId: string, slug: string) => void);
  const dropOrgIntent = useInboxStore((s) => (s as any).dropOrgIntent as (id: string) => void);
  const orgIntents = useInboxStore((s) => ((s as any).orgIntents ?? NO_INTENTS) as OrgIntent[]);
  const echoedIds = useMemo(() => lineIntentEchoed(orgIntents, role._id, lineRow?.line_workflow_slug).map((i) => i.id).join(","), [orgIntents, role._id, lineRow?.line_workflow_slug]);
  useWatchEffect(() => { for (const id of echoedIds.split(",")) if (id) dropOrgIntent(id); }, [echoedIds]);

  const projectName = (id: string) => role.scope_names.projects.find((p) => p.id === id)?.title ?? "a project";
  const planName = (id: string) => role.scope_names.plans.find((p) => p.id === id)?.short_id ?? "a plan";

  const targets = useMemo(() => {
    const people = tree.people.map((p) => ({ key: `user:${p.user_id}`, label: p.name, ref: { kind: "user", user_id: p.user_id } as OrgParentRef }));
    const roles = tree.roles
      .filter((r) => r._id !== role._id && r.status !== "retired" && !orgRoleReparentMakesCycle(tree, role._id, { kind: "role", role_id: r._id }))
      .map((r) => ({ key: `role:${r._id}`, label: `${r.name} (@${r.handle})`, ref: { kind: "role", role_id: r._id } as OrgParentRef }));
    return [...people, ...roles];
  }, [tree, role]);
  const currentKey = role.reports_to.kind === "user" ? `user:${role.reports_to.user_id}` : `role:${role.reports_to.role_id}`;

  return (
    <div className="space-y-3 max-w-[760px]">
      <Section title="Seat" hint="The name people see and the handle sessions address.">
        <div className="grid sm:grid-cols-[1fr_220px] gap-3">
          <div>
            <div className="text-[10.5px] mb-1" style={{ color: "var(--sol-text-dim)" }}>Name</div>
            <InlineEdit canEdit={canEdit} value={role.name} onSave={(v) => v && onUpdate({ name: v })} className="text-[15px] font-semibold" style={{ color: "var(--sol-text)", fontFamily: "var(--font-serif)" }} />
          </div>
          <div>
            <div className="text-[10.5px] mb-1" style={{ color: "var(--sol-text-dim)" }}>Handle</div>
            <InlineEdit canEdit={canEdit} value={role.handle} onSave={(v) => v && onUpdate({ handle: v.replace(/^@/, "") })} className="text-[13px]" style={{ color: "var(--sol-violet)", fontFamily: "var(--font-mono)" }} />
          </div>
        </div>
      </Section>

      <Section title="Scope" hint="What this seat owns: projects and plans. Empty means the whole workspace. Human only; a change wakes the role.">
        <ScopeEditor role={role} canEdit={canEdit} onChange={(scope) => onUpdate({ scope })} />
        <OverlapWarning overlaps={overlaps} projectName={projectName} planName={planName} />
      </Section>

      <Section title="The line" hint="The workflow this scope's tasks run on. A shipped template, or a workflow you pushed with cast workflow push. Human only; a change wakes the role.">
        <div className="flex items-center gap-2 flex-wrap">
          {!canEdit && <span className="text-[13px] font-medium" style={{ color: "var(--sol-text)", fontFamily: "var(--font-mono)" }}>{lineSlug}</span>}
          {canEdit && (
            <SelectBox
              value={lineSlug}
              onChange={(e) => { const next = e.target.value; if (next && next !== lineSlug) setRoleLine(role._id, next); }}
              className="text-[12px]"
              aria-label="The line"
              data-line-picker
            >
              {lineChoices.map((o) => <option key={o.slug} value={o.slug}>{o.label}</option>)}
            </SelectBox>
          )}
          <span className="text-[11px]" style={{ color: "var(--sol-text-dim)" }}>cast role line @{role.handle} --set {lineSlug}</span>
        </div>
      </Section>

      <Section title="Reports to" hint="Where the role's decisions escalate and whose brief reads its state line.">
        <div className="flex items-center gap-2 flex-wrap">
          {!canEdit && <span className="text-[13px] font-medium" style={{ color: "var(--sol-text)" }}>{parentName(tree, role.reports_to)}</span>}
          {canEdit && (
            <SelectBox
              value={currentKey}
              onChange={(e) => { const t = targets.find((x) => x.key === e.target.value); if (t && !sameParent(t.ref, role.reports_to)) onReparent(t.ref); }}
              className="text-[12px]"
              aria-label="Reports to"
            >
              {targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </SelectBox>
          )}
        </div>
      </Section>

      <Section title="Trust" hint="What the role may do on its own. Each step is a person's decision and is logged on the charter.">
        <div className="grid sm:grid-cols-3 gap-2">
          {TRUST_STAGES.map((stage, i) => {
            const m = TRUST_META[stage];
            const on = stage === trust;
            return (
              <button
                key={stage}
                type="button"
                disabled={!canEdit || on}
                onClick={() => onUpdate({ trust: stage })}
                aria-pressed={on}
                className={cn("text-left rounded-lg border px-3 py-2.5 transition-colors disabled:cursor-default", !on && canEdit && "hover:bg-sol-bg-highlight/60")}
                style={{ borderColor: on ? m.color : "color-mix(in srgb, var(--sol-border) 40%, transparent)", background: on ? `color-mix(in srgb, ${m.color} 9%, transparent)` : undefined }}
              >
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full inline-flex items-center justify-center text-[10px] font-bold tabular-nums" style={{ background: on ? m.color : "color-mix(in srgb, var(--sol-border) 40%, transparent)", color: on ? "var(--sol-bg)" : "var(--sol-text-dim)" }}>{i + 1}</span>
                  <span className="text-[13px] font-semibold" style={{ color: on ? m.color : "var(--sol-text)" }}>{m.label}</span>
                </div>
                <p className="mt-1.5 text-[11.5px] leading-snug" style={{ color: "var(--sol-text-muted)" }}>{m.sentence}</p>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Daily caps" hint="Hands the role may start, wakes it may receive, and tokens it may spend per UTC day. Today's counters reset at midnight.">
        <div className="grid grid-cols-3 gap-2">
          {([["hands_per_day", "hands"], ["wakes_per_day", "wakes"], ["tokens_per_day", "tokens"]] as const).map(([k, label]) => (
            <label key={k} className="block">
              <span className="block text-[10.5px] mb-1" style={{ color: "var(--sol-text-dim)" }}>{label}</span>
              <input
                type="number"
                min={0}
                disabled={!canEdit}
                value={capsDraft[k]}
                onChange={(e) => setCapsDraft((c) => ({ ...c, [k]: Math.max(0, Math.floor(Number(e.target.value) || 0)) }))}
                className="w-full h-8 rounded-md px-2 border text-[13px] tabular-nums outline-none bg-sol-bg-alt disabled:opacity-60"
                style={{ borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)", color: "var(--sol-text)" }}
              />
              <span className="block text-[10px] mt-1 tabular-nums" style={{ color: "var(--sol-text-dim)" }}>today {counters?.[label] ?? 0}</span>
            </label>
          ))}
        </div>
        {canEdit && capsDirty && (
          <div className="mt-2.5 flex items-center gap-2">
            <button type="button" onClick={() => onUpdate({ caps: capsDraft })} className="h-7 px-3 rounded-md text-[12px] font-semibold" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}>Save caps</button>
            <button type="button" onClick={() => setCapsDraft(caps)} className="h-7 px-3 rounded-md text-[12px]" style={{ color: "var(--sol-text-muted)" }}>Reset</button>
          </div>
        )}
      </Section>

      <Section title="Host and model" hint="The person whose machine runs the standing session, and the model it runs. Change the model from the session's own model picker.">
        <dl className="grid grid-cols-[110px_1fr] gap-y-1.5 text-[12.5px]">
          <dt style={{ color: "var(--sol-text-dim)" }}>host</dt><dd style={{ color: "var(--sol-text)" }}>{hostName}</dd>
          <dt style={{ color: "var(--sol-text-dim)" }}>model</dt><dd style={{ color: "var(--sol-text)", fontFamily: "var(--font-mono)" }}>{model ?? (role.anchor_id ? "not reported yet" : "no standing session")}</dd>
          <dt style={{ color: "var(--sol-text-dim)" }}>reviews on</dt><dd style={{ color: "var(--sol-text)", fontFamily: "var(--font-mono)" }}>{role.review_backend ?? "default"}</dd>
        </dl>
      </Section>

      {/* S16: seating this role fresh retired the workspace's previous standing
          agent, and the seat dialog promises its thread is kept and linked from
          here. This is that link — without it the promise is empty. */}
      {role.previous_standing_conversation_id && (
        <Section title="Previous standing agent" hint="The agent this seat replaced. Its thread is kept and readable; it no longer wakes.">
          <Link
            href={`/conversation/${role.previous_standing_conversation_id}`}
            className="inline-flex items-center gap-1.5 text-[12.5px] hover:underline"
            style={{ color: "var(--sol-cyan)" }}
          >
            <MessageSquare className="w-3.5 h-3.5" /> Open the retired agent's thread
          </Link>
        </Section>
      )}

      <Section title="Channels" hint="Chat channels whose lines ride the role's wake frame. Edit with cast role follow / unfollow.">
        {followed.length === 0 ? (
          <p className="text-[12px]" style={{ color: "var(--sol-text-dim)" }}>Follows no channel.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {followed.map((c) => <li key={c.id} className="inline-flex items-center gap-1 h-[22px] px-2 rounded-md text-[11px]" style={{ background: "color-mix(in srgb, var(--sol-cyan) 12%, transparent)", color: "var(--sol-cyan)" }}><Hash className="w-3 h-3" />{c.name}</li>)}
          </ul>
        )}
      </Section>

      {canEdit && (
        <section className="rounded-xl border px-4 py-3.5" style={{ borderColor: "color-mix(in srgb, var(--sol-red) 30%, transparent)" }}>
          <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-red)" }}>Retire</h3>
          {!confirmRetire ? (
            <div className="mt-2 flex items-center justify-between gap-3 flex-wrap">
              <p className="text-[12px]" style={{ color: "var(--sol-text-muted)" }}>Its {role.total} session{role.total === 1 ? "" : "s"} go back to their owners; roles under it report to {parentName(tree, role.reports_to)}. The standing session is kept but stops waking.</p>
              <button type="button" onClick={() => setConfirmRetire(true)} className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-medium hover:bg-sol-red/10" style={{ color: "var(--sol-red)" }}><Trash2 className="w-3.5 h-3.5" /> Retire role</button>
            </div>
          ) : (
            <div className="mt-2">
              <RetireRoleConfirm role={role} onRetire={onRetire} onCancel={() => setConfirmRetire(false)} />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
