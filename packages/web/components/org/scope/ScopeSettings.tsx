"use client";
// The role page's Settings tab (docs/architecture/scopes-and-feed.md F3;
// org-roles-standing.md T4, T6): the area editor with overlap warnings, who
// the role reports to, the switch (Starts work on its own) with the limits
// behind a disclosure (org-staffing.md S23), where it runs, and the channels
// it follows. Pause and retire are the page header's menu. Every edit is a store action that paints in the same
// tick and rides dispatch to the orgRoles mutation.
import { useMemo, useState } from "react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import Link from "next/link";
import { TriangleAlert, Hash, MessageSquare, X } from "lucide-react";
import { describeLimitRecovery, fallbackProfiles, nextPressuredReset, switchUsagePercent } from "@codecast/shared/contracts";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { Avatar } from "../../tasks/TaskCommentStream";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../../../store/inboxStore";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { useWorkflows } from "../../../hooks/useSyncWorkflows";
import { lineOptions } from "./lineBoard";
import { lineSlugOf } from "@codecast/shared/contracts/orgProposal";
import { useLineForks } from "../../../hooks/useLineForks";
import { lineSettingsHref } from "../../../lib/lineSettings";
import { lineIntentEchoed, orgRoleReparentMakesCycle, type OrgIntent, type OrgUpdateRoleInput } from "../../../store/orgSlice";
import { SelectBox } from "../../ui/select-box";
import { GatedScopeEditor, InlineEdit } from "./ScopeEditors";
import { parentName } from "../orgMeta";
import { sameParent, type OrgParentRef, type OrgRole, type OrgTree } from "../orgTypes";
import { DEFAULT_CAPS, type RoleCaps, type RoleCounters, type ScopeOverlap } from "./scopeTypes";
import { AUTONOMY_LABEL, autonomyOn, autonomySentence, trustForSwitch } from "@codecast/shared/contracts/roleAutonomy";
import { isHeadOfPeopleRole } from "../orgStaffingTypes";
import { SlackConnect } from "../../anchor/SlackConnect";
import { OrgObjectLink } from "../company/OrgObjectLink";
import { HandingOverSection, MergeStepSwitch, SplitRoleSection, SuccessionSection } from "./RoleHandoffSections";

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
            <OrgObjectLink kind="role" objRef={o.short_id} className="font-medium hover:underline" style={{ color: "var(--sol-text)" }}>{o.name}</OrgObjectLink>
            <span style={{ color: "var(--sol-text-dim)" }}> @{o.handle}</span> also looks after {[...o.project_ids.map(projectName), ...o.plan_ids.map(planName)].join(", ")}.
          </p>
        ))}
      </div>
    </div>
  );
}

type SeatMachine = { device_id: string; label?: string; platform?: string; is_remote: boolean };

/** The seat's account is parked on a usage limit (R7): what codecast does
 *  about it on that machine, in the sentence `cast usage` prints there, and
 *  what a person can do. The roster carries only the viewer's machines, so a
 *  seat on someone else's machine gets the general sentence. */
function SeatLimitNote({ standingId, deviceId, machineLabel }: { standingId: string; deviceId: string | null; machineLabel: string }) {
  const now = useCoarseNow(30_000);
  const { data } = useQueryNoThrow(api.accountSwitch.listAccountProfiles, {});
  const device = deviceId ? (data?.devices ?? []).find((d: any) => d.device_id === deviceId) : undefined;
  const what = device
    ? describeLimitRecovery({
        now,
        next_reset: nextPressuredReset(device.profiles.find((p: any) => p.email && p.email === device.active_email)?.usage, now),
        fallbacks: fallbackProfiles(device.profiles, device.active_email, now).map((p: any) => ({ name: p.name, worst: switchUsagePercent(p.usage, now) })),
        recovery: { auto_switch: device.auto_switch, auto_continue: device.auto_continue, mode: device.ask_first ? "ask" : undefined },
      })
    : "Codecast switches the machine to a saved account with room when it may, or continues the session when the limit resets.";
  return (
    <p className="mt-3 rounded-lg border px-3 py-2 text-[12px] leading-relaxed" style={{ borderColor: "color-mix(in srgb, var(--sol-yellow) 40%, transparent)", background: "color-mix(in srgb, var(--sol-yellow) 7%, transparent)", color: "var(--sol-text-secondary)" }} data-seat-limit>
      The account this role runs on has reached a usage limit, so the role waits until it continues. {what} You can also <Link href={`/conversation/${standingId}`} className="underline" style={{ color: "var(--sol-text)" }}>open its session</Link> and move it to another machine from the chip in its header, or add another account on {machineLabel}.
    </p>
  );
}

/** Who reports to the role (R6): the people whose goals it keeps. A person
 *  adds or removes themself; an admin of the role anyone in the workspace.
 *  The list is a role field, so the edit paints in this tick and rides
 *  updateOrgRole's dispatch to orgRoles.setReports. */
function ReportingPeople({ tree, role, canEdit, onUpdate }: { tree: OrgTree; role: OrgRole; canEdit: boolean; onUpdate: (fields: OrgUpdateRoleInput) => void }) {
  const ids = role.reports_user_ids ?? [];
  const me = tree.people.find((p) => p.is_me);
  const people = ids.map((id) => tree.people.find((p) => p.user_id === id)).filter((p): p is OrgTree["people"][number] => !!p);
  const addable = canEdit ? tree.people.filter((p) => !ids.includes(p.user_id)) : [];
  const set = (next: string[]) => onUpdate({ reports_user_ids: next });
  return (
    <Section title="People whose focus it keeps" hint="The role keeps each person's priorities in its notes, reads their sessions against them every time it runs, and tells them when an important one stalls. It has no say over their work.">
      {people.length === 0 && <p className="text-[12px]" style={{ color: "var(--sol-text-dim)" }}>It keeps nobody's focus yet.</p>}
      <ul className="flex flex-wrap gap-1.5" data-reporting-people={people.length}>
        {people.map((p) => (
          <li key={p.user_id} className="inline-flex items-center gap-1.5 h-7 pl-1 pr-1.5 rounded-full border text-[12px]" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)", color: "var(--sol-text)" }}>
            <Avatar name={p.name} image={p.image} size="sm" />{p.name}
            {(canEdit || p.is_me) && (
              <button type="button" onClick={() => set(ids.filter((id) => id !== p.user_id))} aria-label={`Stop keeping ${p.name}'s focus`} className="inline-flex items-center justify-center w-4 h-4 rounded-full hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-dim)" }}><X className="w-3 h-3" /></button>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-2.5 flex items-center gap-2 flex-wrap">
        {me && !ids.includes(me.user_id) && (
          <button type="button" onClick={() => set([...ids, me.user_id])} className="h-7 px-3 rounded-md text-[12px] font-semibold" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }} data-report-self>Add my focus</button>
        )}
        {addable.filter((p) => !p.is_me).length > 0 && (
          <SelectBox value="" onChange={(e) => { if (e.target.value) set([...ids, e.target.value]); }} className="text-[12px]" aria-label="Add a person">
            <option value="">Add a person</option>
            {addable.filter((p) => !p.is_me).map((p) => <option key={p.user_id} value={p.user_id}>{p.name}</option>)}
          </SelectBox>
        )}
      </div>
    </Section>
  );
}

export type ScopeSettingsProps = {
  tree: OrgTree;
  role: OrgRole;
  canEdit: boolean;
  overlaps: ScopeOverlap[];
  hostName: string;
  model: string | null;
  /** The standing session, for the machine it runs on and a limit park. */
  standingId: string | null;
  /** Today's counters, already checked against the UTC day by the header. */
  counters: RoleCounters | null;
  /** The record of what changed this role (org-staffing.md S21): it reads
   *  where the role is changed. */
  history?: React.ReactNode;
  /** `opts.leave_sessions` is the person's one edit on a scope that gains refs (R1). */
  onUpdate: (fields: OrgUpdateRoleInput, opts?: { leave_sessions?: boolean }) => void;
  onReparent: (target: OrgParentRef) => void;
};

export function ScopeSettings({ tree, role, canEdit, overlaps, hostName, model, standingId, counters, history, onUpdate, onReparent }: ScopeSettingsProps) {
  const caps: RoleCaps = role.caps ?? DEFAULT_CAPS;
  const [capsDraft, setCapsDraft] = useState<RoleCaps>(caps);
  // The server value moves under the tab (the CLI, another window,
  // the echo after Save): the draft follows it, so Save never offers to write
  // stale numbers back over the change that just landed.
  useWatchEffect(() => { setCapsDraft(caps); }, [caps.hands_per_day, caps.wakes_per_day, caps.tokens_per_day]);
  const capsDirty = capsDraft.hands_per_day !== caps.hands_per_day || capsDraft.wakes_per_day !== caps.wakes_per_day || capsDraft.tokens_per_day !== caps.tokens_per_day;
  // The switch (S23.1): on is direct, off is understand; the root stays off.
  const startsOnItsOwn = autonomyOn(role.trust);
  const isRoot = isHeadOfPeopleRole(role);
  const channels = useInboxStore((s) => (s as any).chatChannels as Record<string, any> | undefined);
  const followed = useMemo(() => (role.follow_channel_ids ?? []).map((id) => ({ id, name: channels?.[id]?.name ?? "a channel" })), [role.follow_channel_ids, channels]);
  // The channels it could follow: this workspace's rooms, never a direct message.
  const followable = useMemo(() => Object.values(channels ?? {})
    .filter((c: any) => c.kind !== "dm" && !(role.follow_channel_ids ?? []).includes(c._id) && (tree.workspace.kind === "team" ? c.team_id === tree.workspace.id : !c.team_id))
    .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name))), [channels, role.follow_channel_ids, tree.workspace]);
  const follow = (channelId: string, on: boolean) => (useInboxStore.getState() as any).followOrgChannel(role.short_id, channelId, on);

  // The line (the-line.md L2). The org tree does not carry the slug, so the
  // tab reads it once per view from orgRoles.line; the store's line intent
  // (setRoleLine) wins until that read echoes the slug, which is when the
  // intent is dropped: the tree cannot settle it on its own.
  const { data: lineRow } = useQueryNoThrow(api.orgRoles.line, { role_id: role._id });
  const { workflows } = useWorkflows();
  const lineSlug: string = lineSlugOf({ line_workflow_slug: (role as any).line_workflow_slug ?? lineRow?.line_workflow_slug });
  const lineChoices = useMemo(() => lineOptions(workflows, lineSlug), [workflows, lineSlug]);
  // Where "Edit this line" goes: the project whose customized copy the slug
  // is, else the one project in the role's area; with several, the settings
  // page asks which.
  const forks = useLineForks();
  const forkOf = forks.get(lineSlug) ?? null;
  const onlyProject = role.scope.project_ids.length === 1 ? role.scope.project_ids[0] : null;
  const lineProject = forkOf
    ?? (onlyProject ? { _id: onlyProject, short_id: role.scope_names.projects.find((p) => p.id === onlyProject)?.short_id } : null);
  const setRoleLine = useInboxStore((s) => s.setRoleLine);
  const dropOrgIntent = useInboxStore((s) => (s as any).dropOrgIntent as (id: string) => void);
  const orgIntents = useInboxStore((s) => ((s as any).orgIntents ?? NO_INTENTS) as OrgIntent[]);
  const echoedIds = useMemo(() => lineIntentEchoed(orgIntents, role._id, lineRow?.line_workflow_slug).map((i) => i.id).join(","), [orgIntents, role._id, lineRow?.line_workflow_slug]);
  useWatchEffect(() => { for (const id of echoedIds.split(",")) if (id) dropOrgIntent(id); }, [echoedIds]);

  // Where the seat runs (org-roles-run-work.md R7): the standing session's
  // machine. Enrichment, so the tab still says the host without it.
  const machine = useQueryNoThrow(api.devices.getConversationMachine, standingId ? { conversation_id: standingId } : "skip").data as SeatMachine | null | undefined;
  // A boolean out of the selector: the standing session heartbeats every
  // second, and only a change of this answer may re-render the tab.
  const limitParked = useInboxStore((s) => {
    const row = standingId ? (s.sessions[standingId] as any) : undefined;
    return row?.pending_api_error === true && row?.pending_api_error_kind === "limit";
  });

  const projectName = (id: string) => role.scope_names.projects.find((p) => p.id === id)?.title ?? "a project";
  const planName = (id: string) => role.scope_names.plans.find((p) => p.id === id)?.title ?? "a plan";

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
      <HandingOverSection tree={tree} role={role} canEdit={canEdit} />
      <Section title="Name" hint="The name people see, and the handle to mention it by.">
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

      <Section title="Area" hint={isRoot ? "The projects and plans it looks after. With none picked, the Head of People covers the whole workspace." : "The projects and plans it looks after. Optional: with none picked it has no area of its own, runs its check and answers what it is asked."}>
        <GatedScopeEditor workspace={tree.workspace} role={role} canEdit={canEdit} onChange={(scope, opts) => onUpdate({ scope }, opts)} />
        <OverlapWarning overlaps={overlaps} projectName={projectName} planName={planName} />
      </Section>

      <Section title="Workflow" hint="The steps a task in its area goes through, from started to done.">
        <div className="flex items-center gap-2 flex-wrap">
          {!canEdit && <span className="text-[13px] font-medium" style={{ color: "var(--sol-text)", fontFamily: "var(--font-mono)" }}>{lineSlug}</span>}
          {canEdit && (
            <SelectBox
              value={lineSlug}
              onChange={(e) => { const next = e.target.value; if (next && next !== lineSlug) setRoleLine(role._id, next); }}
              className="text-[12px]"
              aria-label="Workflow"
              data-line-picker
            >
              {lineChoices.map((o) => <option key={o.slug} value={o.slug}>{o.label}</option>)}
            </SelectBox>
          )}
          {forkOf && (
            <span className="text-[11.5px]" style={{ color: "var(--sol-magenta)" }} data-line-customized-note>
              {forkOf.title ? `${forkOf.title}'s customized line` : "a customized line"}
            </span>
          )}
          <Link href={lineSettingsHref({ project: lineProject, section: "stations" })} className="ml-auto text-[11.5px] hover:underline" style={{ color: "var(--sol-text-dim)" }} data-line-edit-link>
            Edit this line
          </Link>
        </div>
        {!isRoot && <MergeStepSwitch role={role} canEdit={canEdit} merge={lineRow?.merge ?? null} />}
      </Section>

      <SuccessionSection tree={tree} role={role} />
      <SplitRoleSection tree={tree} role={role} canEdit={canEdit} />

      <Section title="Reports to" hint="Who it answers to. What it cannot settle itself goes to them, with its recommendation.">
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

      <ReportingPeople tree={tree} role={role} canEdit={canEdit} onUpdate={onUpdate} />

      <Section title={AUTONOMY_LABEL} hint={isRoot ? "The Head of People proposes and you decide, so it never starts work on its own." : autonomySentence(startsOnItsOwn)}>
        <button
          type="button"
          role="switch"
          aria-checked={startsOnItsOwn}
          aria-label={AUTONOMY_LABEL}
          disabled={!canEdit || isRoot}
          onClick={() => onUpdate({ trust: trustForSwitch(!startsOnItsOwn) })}
          data-autonomy-switch={startsOnItsOwn ? "on" : "off"}
          className="inline-flex items-center gap-2.5 rounded-full pl-1 pr-3 h-8 border transition-colors disabled:cursor-default disabled:opacity-60"
          style={{ borderColor: startsOnItsOwn ? "var(--sol-green)" : "color-mix(in srgb, var(--sol-border) 45%, transparent)", background: startsOnItsOwn ? "color-mix(in srgb, var(--sol-green) 10%, transparent)" : undefined }}
        >
          <span className="relative inline-block w-9 h-5 rounded-full transition-colors" style={{ background: startsOnItsOwn ? "var(--sol-green)" : "color-mix(in srgb, var(--sol-text-dim) 35%, transparent)" }}>
            <span className="absolute top-0.5 w-4 h-4 rounded-full transition-[left]" style={{ left: startsOnItsOwn ? 18 : 2, background: "var(--sol-bg)" }} />
          </span>
          <span className="text-[12.5px] font-semibold" style={{ color: startsOnItsOwn ? "var(--sol-green)" : "var(--sol-text-muted)" }}>{startsOnItsOwn ? "On" : "Off"}</span>
        </button>
      </Section>

      <Section title="Limits" hint="A safety net with the defaults filled in: the most it may do in one day. When it reaches one it waits for tomorrow and says so in its notes; nothing reaches you.">
        <details data-role-limits>
        <summary className="cursor-pointer text-[12px] select-none" style={{ color: "var(--sol-text-muted)" }}>Show the limits</summary>
        <div className="mt-2.5 grid grid-cols-3 gap-2">
          {([["hands_per_day", "hands", "sessions started"], ["wakes_per_day", "wakes", "turns"], ["tokens_per_day", "tokens", "tokens"]] as const).map(([k, counter, label]) => (
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
              <span className="block text-[10px] mt-1 tabular-nums" style={{ color: "var(--sol-text-dim)" }}>today {counters?.[counter] ?? 0}</span>
            </label>
          ))}
        </div>
        {canEdit && capsDirty && (
          <div className="mt-2.5 flex items-center gap-2">
            <button type="button" onClick={() => onUpdate({ caps: capsDraft })} className="h-7 px-3 rounded-md text-[12px] font-semibold" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}>Save limits</button>
            <button type="button" onClick={() => setCapsDraft(caps)} className="h-7 px-3 rounded-md text-[12px]" style={{ color: "var(--sol-text-muted)" }}>Undo</button>
          </div>
        )}
        </details>
      </Section>

      <Section title="Where it runs" hint="Whose machine runs its session, which machine, and which model. Change the model from the model picker in its session.">
        <dl className="grid grid-cols-[110px_1fr] gap-y-1.5 text-[12.5px]">
          <dt style={{ color: "var(--sol-text-dim)" }}>person</dt><dd style={{ color: "var(--sol-text)" }}>{hostName}</dd>
          <dt style={{ color: "var(--sol-text-dim)" }}>machine</dt><dd style={{ color: "var(--sol-text)" }} data-seat-machine>{machine ? `${machine.label || "an unnamed machine"}${machine.is_remote ? " (remote)" : ""}` : standingId ? "not reported yet" : "not started yet"}</dd>
          <dt style={{ color: "var(--sol-text-dim)" }}>model</dt><dd style={{ color: "var(--sol-text)", fontFamily: "var(--font-mono)" }}>{model ?? (role.anchor_id ? "not reported yet" : "not started yet")}</dd>
          <dt style={{ color: "var(--sol-text-dim)" }}>reviews on</dt><dd style={{ color: "var(--sol-text)", fontFamily: "var(--font-mono)" }}>{role.review_backend ?? "default"}</dd>
        </dl>
        {limitParked && standingId && <SeatLimitNote standingId={standingId} deviceId={machine?.device_id ?? null} machineLabel={machine?.label || "its machine"} />}
      </Section>

      {/* S16: starting this role fresh retired the workspace's previous agent,
          and the hire dialog promises its thread is kept and linked from here. */}
      {role.previous_standing_conversation_id && (
        <Section title="The agent before it" hint="The agent this role replaced. Its thread is kept and readable; it no longer runs.">
          <Link
            href={`/conversation/${role.previous_standing_conversation_id}`}
            className="inline-flex items-center gap-1.5 text-[12.5px] hover:underline"
            style={{ color: "var(--sol-cyan)" }}
          >
            <MessageSquare className="w-3.5 h-3.5" /> Open the retired agent's thread
          </Link>
        </Section>
      )}

      {/* The Head of People is the workspace's agent (S22): its Slack lives here. */}
      {isHeadOfPeopleRole(role) && canEdit && (
        <Section title="Slack" hint="Connect a Slack workspace so a mention there reaches it, and it can post as itself.">
          <SlackConnect scope={tree.workspace.kind} teamId={tree.workspace.kind === "team" ? tree.workspace.id : null} agentName={role.name} />
        </Section>
      )}

      <Section title="Channels" hint="Chat channels it reads. What is said there reaches it the next time it runs.">
        {followed.length === 0 && <p className="text-[12px]" style={{ color: "var(--sol-text-dim)" }}>It follows no channel.</p>}
        <ul className="flex flex-wrap gap-1.5" data-followed-channels={followed.length}>
          {followed.map((c) => (
            <li key={c.id} className="inline-flex items-center gap-1 h-[22px] pl-2 pr-1 rounded-md text-[11px]" style={{ background: "color-mix(in srgb, var(--sol-cyan) 12%, transparent)", color: "var(--sol-cyan)" }}>
              <Hash className="w-3 h-3" />{c.name}
              {canEdit && <button type="button" onClick={() => follow(c.id, false)} aria-label={`Stop following ${c.name}`} className="inline-flex items-center justify-center w-4 h-4 rounded-full hover:bg-sol-bg-highlight"><X className="w-3 h-3" /></button>}
            </li>
          ))}
        </ul>
        {canEdit && followable.length > 0 && (
          <SelectBox value="" onChange={(e) => { if (e.target.value) follow(e.target.value, true); }} className="mt-2.5 text-[12px]" aria-label="Follow a channel" data-follow-channel>
            <option value="">Follow a channel</option>
            {followable.map((c: any) => <option key={c._id} value={c._id}>#{c.name}</option>)}
          </SelectBox>
        )}
      </Section>

      {history && (
        <Section title="History" hint="What changed this role, newest first, each entry with its way back.">
          <div data-scope-section="history">{history}</div>
        </Section>
      )}

    </div>
  );
}
