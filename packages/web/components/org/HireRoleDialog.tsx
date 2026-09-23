"use client";
// The hire form (docs/architecture/org-init.md O3): "Add a role" on /org and
// "Add a lead" on a project page open this one dialog. It reads the scope back
// as a preview (org.scopeSummary: what the seat will read and what the viewer
// cannot), proposes a charter from the projects picked, shows the trust ladder
// with the two higher stages locked, and takes caps. Submit is one store
// action (createOrgRole with provision) so the graph moves in the same tick.
import { useMemo, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { Lock } from "lucide-react";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { useScopeSummary } from "../../hooks/useScopeQueries";
import type { PlanItem, ProjectItem } from "../../store/inboxStore";
import type { OrgCreateRoleInput } from "../../store/orgSlice";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { SelectBox } from "../ui/select-box";
import { parentNodeId, parentRefOfNodeId, refMatches, refResolves } from "./orgLayout";
import type { OrgParentRef, OrgTree } from "./orgTypes";
import { DEFAULT_CAPS, TRUST_META, TRUST_STAGES, type RoleCaps, type TrustStage } from "./scope/scopeTypes";
import { OrgTemplateHire } from "./orgTemplateHire";
import { AVATAR_KEYS, avatarOf } from "@codecast/shared/contracts/orgAvatars";
import { ORG_TENURE_THEN, seatSentence, type OrgRoleSeat, type OrgTenureSpec } from "@codecast/shared/contracts/orgProposal";
import { RoleFace } from "./RoleFace";
import { TakeoverEdit } from "./TakeoverEdit";
import { useTakeoverPreviews } from "../../hooks/useTakeoverPreviews";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}

// Why the two higher stages are locked here: trust changes are a person's
// later act on the role page, logged on the charter (orgRoles.setTrust).
const TRUST_UNLOCK_SENTENCE: Record<Exclude<TrustStage, "understand">, string> = {
  decide: "Locked at creation. Raise it from the role's settings once its recommendations have held; the change is logged on the charter.",
  direct: "Locked at creation. Raise it from the role's settings after decide has held; hands then start within the caps below.",
};

/** The charter the form proposes from what was picked; editable, and replaced
 *  only while the person has not typed their own. */
function proposeCharter(name: string, projects: Array<{ title: string; description?: string }>, summary: { plans: Array<{ title: string }>; tasks: { open: number; total: number }; sessions: { total: number } } | null | undefined): string {
  const who = name.trim() || "This role";
  if (projects.length === 0) return `${who} owns the whole workspace: it keeps its plans and tasks moving, reports what changed and why, and raises what needs a person with a recommendation.`;
  const named = projects.map((p) => (p.description?.trim() ? `${p.title} (${p.description.trim().split(/\.\s|\n/)[0].slice(0, 120)})` : p.title));
  const owns = named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  const activity = summary
    ? ` Right now that is ${summary.tasks.open} open of ${summary.tasks.total} tasks across ${summary.plans.length} plan${summary.plans.length === 1 ? "" : "s"}${summary.plans[0] ? `, the newest being ${summary.plans[0].title}` : ""}, with ${summary.sessions.total} recent session${summary.sessions.total === 1 ? "" : "s"}.`
    : "";
  return `${who} owns ${owns}.${activity} It keeps the scope's plans and tasks moving, reports what changed and why, and raises what needs a person with a recommendation.`;
}

/** Prefill for "Edit" on a proposed role (org-staffing.md S5): the analyzer's
 *  fields land in the form and the submit reads as accepting with edits.
 *  `scope` carries the proposal's refs (a short id, an id or a title each);
 *  the form resolves them against the workspace's projects and plans, so a
 *  ref nothing answers to is simply not ticked. `reports_to` is resolved by
 *  the caller against the tree (resolveOrgParentRef). */
export type HireRoleInitial = { name?: string; handle?: string; charter?: string; caps?: Partial<RoleCaps>; scope?: { projects?: string[]; plans?: string[] }; reports_to?: OrgParentRef | null; tenure?: OrgTenureSpec; avatar?: string };

/** What the person changed in the form, so an edit sends only that: a scope
 *  ref the form could not resolve, or a parent the same proposal creates (a
 *  ghost the select cannot list), survives an untouched submit as proposed. */
export type HireRoleTouched = { scope: boolean; reports_to: boolean };
export type HireRoleOutput = OrgCreateRoleInput & { touched: HireRoleTouched };

export function HireRoleDialog({ open, onClose, tree, meId, onCreate, initialProjects = [], projectPath, title = "Add a role", initial, submitLabel = "Create and start", seat }: {
  open: boolean;
  onClose: () => void;
  tree: OrgTree;
  meId: string;
  onCreate: (input: HireRoleOutput) => void;
  /** "Add a lead" on a project page preselects that project. Passed as rows,
   *  not ids: the page may hold a project the workspace collection has not
   *  cached yet, and the preview and charter need its title and description. */
  initialProjects?: ProjectItem[];
  /** The cwd the standing session starts in (the project's path when known). */
  projectPath?: string;
  title?: string;
  initial?: HireRoleInitial;
  submitLabel?: string;
  /** "Make this a role" on a session (org-roles-run-work.md R2): the role is
   *  this session, so nothing new starts. The form says what naming changes,
   *  offers no template, and the create seats the session. */
  seat?: OrgRoleSeat;
}) {
  const [mode, setMode] = useState<"manual" | "template">("manual");
  const [name, setName] = useState(initial?.name ?? "");
  const [handle, setHandle] = useState(initial?.handle ?? "");
  const [handleTouched, setHandleTouched] = useState(!!initial?.handle);
  const [reportsTo, setReportsToState] = useState<string>(initial?.reports_to ? parentNodeId(initial.reports_to) : meId ? parentNodeId({ kind: "user", user_id: meId }) : "");
  const [touched, setTouched] = useState<HireRoleTouched>({ scope: false, reports_to: false });
  const setReportsTo = (v: string) => { setTouched((t) => ({ ...t, reports_to: true })); setReportsToState(v); };
  const [charter, setCharter] = useState(initial?.charter ?? "");
  const [charterTouched, setCharterTouched] = useState(!!initial?.charter);
  const wsProjects = useWorkspaceCollection<ProjectItem>("projects");
  const plans = useWorkspaceCollection<PlanItem>("plans");
  // A proposal's project refs resolve the way the server resolves them (an
  // exact id, short id or title, else a unique title substring); plans by
  // pl-N or id. A ref nothing answers to is simply not ticked, and stays in
  // the change unless the person touches the scope.
  const [projectIds, setProjectIdsState] = useState<string[]>(() => {
    const rows = wsProjects.map((p) => ({ id: p._id, title: p.title, short_id: (p as { short_id?: string }).short_id }));
    const fromRefs = (initial?.scope?.projects ?? []).map((ref) => refResolves(ref, rows)?.id).filter((id): id is string => !!id);
    return [...new Set([...initialProjects.map((p) => p._id), ...fromRefs])];
  });
  const [planIds, setPlanIdsState] = useState<string[]>(() => plans.filter((p) => (initial?.scope?.plans ?? []).some((ref) => refMatches(ref, { id: p._id, title: p.title, short_id: p.short_id }))).map((p) => p._id));
  const setProjectIds = (v: string[]) => { setTouched((t) => ({ ...t, scope: true })); setProjectIdsState(v); };
  const setPlanIds = (v: string[]) => { setTouched((t) => ({ ...t, scope: true })); setPlanIdsState(v); };
  const [caps, setCaps] = useState<RoleCaps>({ ...DEFAULT_CAPS, ...(initial?.caps ?? {}) });
  // The face (S13): a chosen avatar key, else the default derived from the
  // handle so every role has one. `avatar` is undefined until the person picks.
  const [avatar, setAvatar] = useState<string | undefined>(initial?.avatar);
  // Standing or program (S10). Standing by default; a program ends with a plan,
  // a project or a date, and then retires or comes up for review.
  const initProgram = initial?.tenure?.kind === "program" ? initial.tenure : null;
  const initEnds = initProgram?.ends as { plan?: string; project?: string; date?: number } | undefined;
  const [tenureKind, setTenureKind] = useState<"standing" | "program">(initProgram ? "program" : "standing");
  const [endKind, setEndKind] = useState<"plan" | "project" | "date">(initEnds?.plan ? "plan" : initEnds?.project ? "project" : initEnds?.date ? "date" : "plan");
  const [endPlan, setEndPlan] = useState<string>(initEnds?.plan ?? "");
  const [endProject, setEndProject] = useState<string>(initEnds?.project ?? "");
  const [endDate, setEndDate] = useState<string>(initEnds?.date ? new Date(initEnds.date).toISOString().slice(0, 10) : "");
  const [tenureThen, setTenureThen] = useState<"retire" | "review">(initProgram?.then ?? "retire");
  const [faceOpen, setFaceOpen] = useState(false);
  // Preset rows lead the list, then the rest of the workspace.
  const projects = useMemo(() => [...initialProjects, ...wsProjects.filter((p) => !initialProjects.some((q) => q._id === p._id))], [initialProjects, wsProjects]);
  const effHandle = handleTouched ? handle : slugify(name);
  const taken = tree.roles.some((r) => r.handle === effHandle && r.status !== "retired");
  // A program needs its end chosen; standing needs nothing.
  const tenureOk = tenureKind === "standing" || (endKind === "plan" ? !!endPlan : endKind === "project" ? !!endProject : !!endDate);
  const valid = name.trim().length > 0 && /^[a-z0-9-]{2,32}$/.test(effHandle) && !taken && !!reportsTo && tenureOk;
  const wholeWorkspace = projectIds.length + planIds.length === 0;
  const buildTenure = (): OrgTenureSpec => {
    if (tenureKind === "standing") return { kind: "standing" };
    const ends = endKind === "plan" ? { plan: endPlan } : endKind === "project" ? { project: endProject } : { date: new Date(`${endDate}T00:00:00Z`).getTime() };
    return { kind: "program", ends, then: tenureThen };
  };

  // The scope preview: what the seat will read. A whole-workspace scope reads
  // everything, so the query is skipped and the hint says so.
  const { data: summary } = useScopeSummary(
    open && mode === "manual" && !wholeWorkspace
      ? { scope: { project_ids: projectIds, plan_ids: planIds }, ...(tree.workspace.kind === "team" ? { team_id: tree.workspace.id } : {}) }
      : "skip",
  );
  // What the new role would take over (R1): the host's sessions in the picked
  // scope that report to no role, counted before the create, with the one edit.
  const [leaveSessions, setLeaveSessions] = useState(false);
  const takeover = useTakeoverPreviews(tree.workspace, open && mode === "manual" && !wholeWorkspace
    ? [{ key: "hire", says: effHandle, add: [...projectIds.map((id) => `project:${id}`), ...planIds.map((id) => `plan:${id}`)], seat: seat?.existing }]
    : []).byKey.hire;
  const picked = useMemo(() => projects.filter((p) => projectIds.includes(p._id)), [projects, projectIds]);
  const cannotRead = summary
    ? (projectIds.length - summary.projects.length) + planIds.filter((id) => !summary.plans.some((p) => p.id === id)).length
    : 0;

  const proposed = useMemo(() => proposeCharter(name, picked, wholeWorkspace ? null : summary), [name, picked, wholeWorkspace, summary]);
  useWatchEffect(() => { if (!charterTouched) setCharter(proposed); }, [proposed, charterTouched]);

  const me = tree.people.find((p) => p.user_id === meId);
  // The standing session's cwd: the caller's path, else the first picked
  // project's. The store's project row carries the path only when the server
  // set one, so it is read loosely.
  const cwd: string | undefined = projectPath ?? (picked[0] as { project_path?: string } | undefined)?.project_path ?? undefined;
  const submit = () => {
    if (mode !== "manual" || !valid) return;
    const ref = parentRefOfNodeId(reportsTo) ?? { kind: "user" as const, user_id: meId };
    onCreate({
      name: name.trim(),
      handle: effHandle,
      ...(tree.workspace.kind === "team" ? { team_id: tree.workspace.id } : {}),
      scope: { project_ids: projectIds, plan_ids: planIds },
      reports_to: ref,
      ...(charter.trim() ? { charter: charter.trim() } : {}),
      caps,
      tenure: buildTenure(),
      ...(avatar ? { avatar } : {}),
      provision: true,
      ...(seat ? { adopt_conversation_id: seat.existing } : cwd ? { project_path: cwd } : {}),
      host_user_id: meId,
      client_id: `orgrolestub-${Math.random().toString(36).slice(2)}`,
      ...(leaveSessions && takeover ? { leave_sessions: true } : {}),
      touched,
    });
  };
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const scopeHint = wholeWorkspace
    ? "nothing picked = the whole workspace"
    : summary
      ? `reads ${summary.plans.length} plan${summary.plans.length === 1 ? "" : "s"}, ${summary.tasks.total} task${summary.tasks.total === 1 ? "" : "s"}, ${summary.sessions.total} session${summary.sessions.total === 1 ? "" : "s"}${cannotRead ? ` · ${cannotRead} it cannot` : ""}`
      : `${projectIds.length} project${projectIds.length === 1 ? "" : "s"}, ${planIds.length} plan${planIds.length === 1 ? "" : "s"} · reading…`;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[520px] grid-cols-1 max-h-[92vh] overflow-y-auto" style={{ background: "var(--sol-card)", borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)" }}>
        <DialogHeader>
          <DialogTitle className="text-[17px]" style={{ fontFamily: "var(--font-serif)" }}>{title}</DialogTitle>
          <DialogDescription className="text-[12px]" style={{ color: "var(--sol-text-muted)" }}>{seat ? seatSentence(seat) : mode === "manual" ? "A standing seat: a scope it reads, a person it answers to, a charter it runs from. It starts reading and reporting the moment it exists." : "Bring a complete job template into one project, with your approval before setup."}</DialogDescription>
        </DialogHeader>
        <div className={seat ? "hidden" : "grid grid-cols-2 gap-1 rounded-lg bg-sol-bg-alt p-1"} role="group" aria-label="Role setup">
          {([["manual", "Write a role"], ["template", "From a template"]] as const).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)} className="rounded-md px-3 py-2 text-[12px] font-semibold transition-colors focus-visible:outline focus-visible:outline-sol-cyan" style={{ background: mode === value ? "var(--sol-card)" : undefined, color: mode === value ? "var(--sol-text)" : "var(--sol-text-muted)" }}>{label}</button>
          ))}
        </div>
        <div hidden={mode !== "template"}>
          <OrgTemplateHire projects={projects} workspace={tree.workspace} roles={tree.roles} initialProjectId={initialProjects.length === 1 ? initialProjects[0]._id : undefined} projectPath={initialProjects.length === 1 ? projectPath : undefined} onClose={onClose} />
        </div>
        <form className={mode === "manual" ? "flex flex-col gap-3" : "hidden"} onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <Field label="Name">
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Head of Growth" className={INPUT} style={INPUT_STYLE} />
            </Field>
            <Field label="Handle" hint={taken ? "already used in this workspace" : undefined}>
              <div className="flex items-center gap-1">
                <span className="text-[13px]" style={{ color: "var(--sol-violet)", fontFamily: "var(--font-mono)" }}>@</span>
                <input value={effHandle} onChange={(e) => { setHandleTouched(true); setHandle(slugify(e.target.value)); }} placeholder="growth" className={INPUT} style={{ ...INPUT_STYLE, width: 150, fontFamily: "var(--font-mono)", ...(taken ? { borderColor: "var(--sol-red)" } : {}) }} />
              </div>
            </Field>
          </div>

          <Field label="Face" hint={avatar ? "chosen" : "from the handle"}>
            <div className="flex items-center gap-2.5">
              <RoleFace role={{ avatar, handle: effHandle, name }} size={36} />
              <button type="button" onClick={() => setFaceOpen((o) => !o)} className="text-[11.5px] underline-offset-2 hover:underline" style={{ color: "var(--sol-text-muted)" }}>{faceOpen ? "Close" : "Choose a face"}</button>
              {avatar && <button type="button" onClick={() => setAvatar(undefined)} className="text-[11px] underline-offset-2 hover:underline" style={{ color: "var(--sol-text-dim)" }}>reset to default</button>}
            </div>
            {faceOpen && (
              <div className="mt-1.5 grid grid-cols-8 gap-1.5 rounded-lg border p-2" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)" }}>
                {AVATAR_KEYS.map((k) => {
                  const on = avatarOf({ avatar, handle: effHandle }) === k;
                  return (
                    <button key={k} type="button" onClick={() => { setAvatar(k); setFaceOpen(false); }} className="rounded-full inline-flex" style={{ outline: on ? "2px solid var(--sol-violet)" : "none", outlineOffset: 1 }} title={k}>
                      <RoleFace role={{ avatar: k, handle: effHandle, name }} size={28} />
                    </button>
                  );
                })}
              </div>
            )}
          </Field>

          <Field label="Scope" hint={scopeHint}>
            <div className="max-h-[132px] overflow-y-auto rounded-lg border p-1" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)" }}>
              {projects.length === 0 && plans.length === 0 && <p className="px-2 py-1.5 text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>No projects or plans in this workspace yet.</p>}
              {projects.map((p) => <ScopeOption key={p._id} checked={projectIds.includes(p._id)} onToggle={() => toggle(projectIds, setProjectIds, p._id)} tone="blue" label={p.title} sub="project" />)}
              {plans.map((p) => <ScopeOption key={p._id} checked={planIds.includes(p._id)} onToggle={() => toggle(planIds, setPlanIds, p._id)} tone="magenta" label={p.title} sub={p.short_id} />)}
            </div>
            {takeover && <TakeoverEdit className="mt-1.5" phrase={takeover.phrase} leave={leaveSessions} onLeave={setLeaveSessions} />}
          </Field>

          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Responsible person" hint="who it reports to">
              <SelectBox value={reportsTo} onChange={(e) => setReportsTo(e.target.value)} className="text-[13px]">
                <optgroup label="People">
                  {tree.people.map((p) => <option key={p.user_id} value={parentNodeId({ kind: "user", user_id: p.user_id })}>{p.name}{p.is_me ? " (you)" : ""}</option>)}
                </optgroup>
                {tree.roles.filter((r) => r.status !== "retired").length > 0 && (
                  <optgroup label="Roles">
                    {tree.roles.filter((r) => r.status !== "retired").map((r) => <option key={r._id} value={parentNodeId({ kind: "role", role_id: r._id })}>@{r.handle} · {r.name}</option>)}
                  </optgroup>
                )}
              </SelectBox>
            </Field>
            <Field label="Host and payer" hint="runs on your machine and account">
              <div className="h-9 px-2.5 rounded-lg border inline-flex items-center text-[13px]" style={{ ...INPUT_STYLE, color: "var(--sol-text-muted)" }}>{me?.name ?? "you"}</div>
            </Field>
          </div>

          <Field label="Charter" hint={charterTouched ? "edited" : "proposed from the scope; edit freely"}>
            <textarea value={charter} onChange={(e) => { setCharterTouched(true); setCharter(e.target.value); }} rows={4} className={INPUT} style={{ ...INPUT_STYLE, height: "auto", padding: "8px 10px", lineHeight: 1.45 }} />
            {charterTouched && charter !== proposed && (
              <button type="button" onClick={() => { setCharterTouched(false); setCharter(proposed); }} className="self-start text-[10.5px] underline-offset-2 hover:underline" style={{ color: "var(--sol-text-dim)" }}>Use the proposed text</button>
            )}
          </Field>

          <Field label="Tenure" hint={tenureKind === "standing" ? "an area that outlives any plan" : "a bounded effort with an end"}>
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-sol-bg-alt p-1">
              {([["standing", "Standing"], ["program", "Program"]] as const).map(([value, label]) => (
                <button key={value} type="button" aria-pressed={tenureKind === value} onClick={() => setTenureKind(value)} className="rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors" style={{ background: tenureKind === value ? "var(--sol-card)" : undefined, color: tenureKind === value ? "var(--sol-text)" : "var(--sol-text-muted)" }}>{label}</button>
              ))}
            </div>
            {tenureKind === "program" && (
              <div className="mt-2 flex flex-col gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] shrink-0" style={{ color: "var(--sol-text-dim)" }}>ends with</span>
                  <SelectBox value={endKind} onChange={(e) => setEndKind(e.target.value as "plan" | "project" | "date")} className="text-[12.5px]" style={{ width: 118 }}>
                    <option value="plan">a plan</option>
                    <option value="project">a project</option>
                    <option value="date">a date</option>
                  </SelectBox>
                  {endKind === "plan" && (
                    <SelectBox value={endPlan} onChange={(e) => setEndPlan(e.target.value)} className="text-[12.5px] flex-1" style={{ minWidth: 150 }}>
                      <option value="">Pick a plan…</option>
                      {plans.map((p) => <option key={p._id} value={p._id}>{p.short_id ? `${p.short_id} · ` : ""}{p.title}</option>)}
                    </SelectBox>
                  )}
                  {endKind === "project" && (
                    <SelectBox value={endProject} onChange={(e) => setEndProject(e.target.value)} className="text-[12.5px] flex-1" style={{ minWidth: 150 }}>
                      <option value="">Pick a folder…</option>
                      {projects.map((p) => <option key={p._id} value={p._id}>{p.title}</option>)}
                    </SelectBox>
                  )}
                  {endKind === "date" && (
                    <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={INPUT} style={{ ...INPUT_STYLE, width: "auto", flex: 1, minWidth: 150 }} />
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] shrink-0" style={{ color: "var(--sol-text-dim)" }}>then</span>
                  <div className="grid grid-cols-2 gap-1 rounded-lg bg-sol-bg-alt p-1" style={{ width: 220 }}>
                    {ORG_TENURE_THEN.map((t) => (
                      <button key={t} type="button" aria-pressed={tenureThen === t} onClick={() => setTenureThen(t)} className="rounded-md px-2 py-1 text-[11.5px] font-medium capitalize transition-colors" style={{ background: tenureThen === t ? "var(--sol-card)" : undefined, color: tenureThen === t ? "var(--sol-text)" : "var(--sol-text-muted)" }}>{t}</button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </Field>

          <Field label="Trust" hint="what it may do on its own">
            <div className="grid sm:grid-cols-3 gap-2">
              {TRUST_STAGES.map((stage, i) => {
                const m = TRUST_META[stage];
                const on = stage === "understand";
                return (
                  <div key={stage} aria-disabled={!on} title={on ? undefined : TRUST_UNLOCK_SENTENCE[stage as Exclude<TrustStage, "understand">]} className="rounded-lg border px-3 py-2.5" style={{ borderColor: on ? m.color : "color-mix(in srgb, var(--sol-border) 40%, transparent)", background: on ? `color-mix(in srgb, ${m.color} 9%, transparent)` : undefined, opacity: on ? 1 : 0.7 }}>
                    <div className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full inline-flex items-center justify-center text-[10px] font-bold tabular-nums" style={{ background: on ? m.color : "color-mix(in srgb, var(--sol-border) 40%, transparent)", color: on ? "var(--sol-bg)" : "var(--sol-text-dim)" }}>{i + 1}</span>
                      <span className="text-[12.5px] font-semibold" style={{ color: on ? m.color : "var(--sol-text)" }}>{m.label}</span>
                      {!on && <Lock className="w-3 h-3 ml-auto" style={{ color: "var(--sol-text-dim)" }} />}
                    </div>
                    <p className="mt-1.5 text-[11px] leading-snug" style={{ color: "var(--sol-text-muted)" }}>{on ? m.sentence : TRUST_UNLOCK_SENTENCE[stage as Exclude<TrustStage, "understand">]}</p>
                  </div>
                );
              })}
            </div>
          </Field>

          <Field label="Daily caps" hint="hands it may start, wakes it may receive, tokens it may spend per UTC day">
            <div className="grid grid-cols-3 gap-2">
              {([["hands_per_day", "hands"], ["wakes_per_day", "wakes"], ["tokens_per_day", "tokens"]] as const).map(([k, label]) => (
                <label key={k} className="flex flex-col gap-1">
                  <span className="text-[10.5px]" style={{ color: "var(--sol-text-dim)" }}>{label}</span>
                  <input type="number" min={0} step={k === "tokens_per_day" ? 10_000 : 1} value={caps[k]} onChange={(e) => setCaps({ ...caps, [k]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} className={INPUT} style={{ ...INPUT_STYLE, fontFamily: "var(--font-mono)" }} />
                </label>
              ))}
            </div>
          </Field>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="h-8 px-3 rounded-lg text-[12.5px] hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-muted)" }}>Cancel</button>
            <button type="submit" disabled={!valid} className="h-8 px-3.5 rounded-lg text-[12.5px] font-semibold disabled:opacity-50" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}>{submitLabel}</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const INPUT = "w-full h-9 px-2.5 rounded-lg border outline-none text-[13px] focus:border-sol-cyan";
const INPUT_STYLE: React.CSSProperties = { background: "var(--sol-bg-alt)", borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)", color: "var(--sol-text)" };

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] shrink-0" style={{ color: "var(--sol-text-dim)" }}>{label}</span>
        {hint && <span className="text-[10.5px] text-right" style={{ color: hint.startsWith("already") ? "var(--sol-red)" : "var(--sol-text-dim)" }}>{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function ScopeOption({ checked, onToggle, tone, label, sub }: { checked: boolean; onToggle: () => void; tone: "blue" | "magenta"; label: string; sub: string }) {
  const color = tone === "blue" ? "var(--sol-blue)" : "var(--sol-magenta)";
  return (
    <button type="button" onClick={onToggle} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left hover:bg-sol-bg-highlight/70">
      <span className="w-3.5 h-3.5 rounded-[4px] border inline-flex items-center justify-center shrink-0" style={{ borderColor: checked ? color : "color-mix(in srgb, var(--sol-border) 60%, transparent)", background: checked ? color : "transparent" }}>
        {checked && <span className="w-1.5 h-1.5 rounded-[1px]" style={{ background: "var(--sol-bg)" }} />}
      </span>
      <span className="flex-1 min-w-0 truncate text-[12.5px]" style={{ color: "var(--sol-text)" }}>{label}</span>
      <span className="text-[10.5px] shrink-0" style={{ color, fontFamily: tone === "magenta" ? "var(--font-mono)" : undefined }}>{sub}</span>
    </button>
  );
}
