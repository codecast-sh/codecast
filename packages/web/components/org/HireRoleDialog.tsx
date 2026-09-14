"use client";
// The hire form (docs/architecture/org-init.md O3): "Add a role" on /org and
// "Add a lead" on a project page open this one dialog. It reads the scope back
// as a preview (org.scopeSummary: what the seat will read and what the viewer
// cannot), proposes a charter from the projects picked, shows the trust ladder
// with the two higher stages locked, and takes caps. Submit is one store
// action (createOrgRole with provision) so the graph moves in the same tick.
import { useEffect, useMemo, useState } from "react";
import { Lock } from "lucide-react";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { useScopeSummary } from "../../hooks/useScopeQueries";
import type { PlanItem, ProjectItem } from "../../store/inboxStore";
import type { OrgCreateRoleInput } from "../../store/orgSlice";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { SelectBox } from "../ui/select-box";
import { parentNodeId, parentRefOfNodeId } from "./orgLayout";
import type { OrgTree } from "./orgTypes";
import { DEFAULT_CAPS, TRUST_META, TRUST_STAGES, type RoleCaps, type TrustStage } from "./scope/scopeTypes";

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}

// Why the two higher stages are locked here: trust changes are a person's
// later act on the role page, logged on the charter (orgRoles.setTrust).
export const TRUST_UNLOCK_SENTENCE: Record<Exclude<TrustStage, "understand">, string> = {
  decide: "Locked at creation. Raise it from the role's settings once its recommendations have held; the change is logged on the charter.",
  direct: "Locked at creation. Raise it from the role's settings after decide has held; hands then start within the caps below.",
};

/** The charter the form proposes from what was picked; editable, and replaced
 *  only while the person has not typed their own. */
export function proposeCharter(name: string, projects: Array<{ title: string; description?: string }>, summary: { plans: Array<{ title: string }>; tasks: { open: number; total: number }; sessions: { total: number } } | null | undefined): string {
  const who = name.trim() || "This role";
  if (projects.length === 0) return `${who} owns the whole workspace: it keeps its plans and tasks moving, reports what changed and why, and raises what needs a person with a recommendation.`;
  const named = projects.map((p) => (p.description?.trim() ? `${p.title} (${p.description.trim().split(/\.\s|\n/)[0].slice(0, 120)})` : p.title));
  const owns = named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  const activity = summary
    ? ` Right now that is ${summary.tasks.open} open of ${summary.tasks.total} tasks across ${summary.plans.length} plan${summary.plans.length === 1 ? "" : "s"}${summary.plans[0] ? `, the newest being ${summary.plans[0].title}` : ""}, with ${summary.sessions.total} recent session${summary.sessions.total === 1 ? "" : "s"}.`
    : "";
  return `${who} owns ${owns}.${activity} It keeps the scope's plans and tasks moving, reports what changed and why, and raises what needs a person with a recommendation.`;
}

export function HireRoleDialog({ open, onClose, tree, meId, onCreate, initialProjectIds = [], projectPath, title = "Add a role" }: {
  open: boolean;
  onClose: () => void;
  tree: OrgTree;
  meId: string;
  onCreate: (input: OrgCreateRoleInput) => void;
  /** "Add a lead" on a project page preselects that project. */
  initialProjectIds?: string[];
  /** The cwd the standing session starts in (the project's path when known). */
  projectPath?: string;
  title?: string;
}) {
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [handleTouched, setHandleTouched] = useState(false);
  const [reportsTo, setReportsTo] = useState<string>(meId ? parentNodeId({ kind: "user", user_id: meId }) : "");
  const [charter, setCharter] = useState("");
  const [charterTouched, setCharterTouched] = useState(false);
  const [projectIds, setProjectIds] = useState<string[]>(initialProjectIds);
  const [planIds, setPlanIds] = useState<string[]>([]);
  const [caps, setCaps] = useState<RoleCaps>({ ...DEFAULT_CAPS });
  const projects = useWorkspaceCollection<ProjectItem>("projects");
  const plans = useWorkspaceCollection<PlanItem>("plans");
  const effHandle = handleTouched ? handle : slugify(name);
  const taken = tree.roles.some((r) => r.handle === effHandle && r.status !== "retired");
  const valid = name.trim().length > 0 && /^[a-z0-9-]{2,32}$/.test(effHandle) && !taken && !!reportsTo;
  const wholeWorkspace = projectIds.length + planIds.length === 0;

  // The scope preview: what the seat will read. A whole-workspace scope reads
  // everything, so the query is skipped and the hint says so.
  const { data: summary } = useScopeSummary(
    open && !wholeWorkspace
      ? { scope: { project_ids: projectIds, plan_ids: planIds }, ...(tree.workspace.kind === "team" ? { team_id: tree.workspace.id } : {}) }
      : "skip",
  );
  const picked = useMemo(() => projects.filter((p) => projectIds.includes(p._id)), [projects, projectIds]);
  const cannotRead = summary
    ? (projectIds.length - summary.projects.length) + planIds.filter((id) => !summary.plans.some((p) => p.id === id)).length
    : 0;

  const proposed = useMemo(() => proposeCharter(name, picked, wholeWorkspace ? null : summary), [name, picked, wholeWorkspace, summary]);
  useEffect(() => { if (!charterTouched) setCharter(proposed); }, [proposed, charterTouched]);

  const me = tree.people.find((p) => p.user_id === meId);
  const submit = () => {
    if (!valid) return;
    const ref = parentRefOfNodeId(reportsTo) ?? { kind: "user" as const, user_id: meId };
    onCreate({
      name: name.trim(),
      handle: effHandle,
      ...(tree.workspace.kind === "team" ? { team_id: tree.workspace.id } : {}),
      scope: { project_ids: projectIds, plan_ids: planIds },
      reports_to: ref,
      ...(charter.trim() ? { charter: charter.trim() } : {}),
      caps,
      provision: true,
      ...(projectPath ?? picked[0]?.project_path ? { project_path: projectPath ?? picked[0]?.project_path } : {}),
      host_user_id: meId,
      client_id: `orgrolestub-${Math.random().toString(36).slice(2)}`,
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
          <DialogDescription className="text-[12px]" style={{ color: "var(--sol-text-muted)" }}>A standing seat: a scope it reads, a person it answers to, a charter it runs from. It starts reading and reporting the moment it exists.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
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

          <Field label="Scope" hint={scopeHint}>
            <div className="max-h-[132px] overflow-y-auto rounded-lg border p-1" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)" }}>
              {projects.length === 0 && plans.length === 0 && <p className="px-2 py-1.5 text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>No projects or plans in this workspace yet.</p>}
              {projects.map((p) => <ScopeOption key={p._id} checked={projectIds.includes(p._id)} onToggle={() => toggle(projectIds, setProjectIds, p._id)} tone="blue" label={p.title} sub="project" />)}
              {plans.map((p) => <ScopeOption key={p._id} checked={planIds.includes(p._id)} onToggle={() => toggle(planIds, setPlanIds, p._id)} tone="magenta" label={p.title} sub={p.short_id} />)}
            </div>
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
            <button type="submit" disabled={!valid} className="h-8 px-3.5 rounded-lg text-[12.5px] font-semibold disabled:opacity-50" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}>Create and start</button>
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
