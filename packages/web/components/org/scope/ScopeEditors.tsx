"use client";
// The small scope editors every scope surface shares: the section label, a
// doc row, the gated area editor (project and plan chips behind the takeover
// gate), and the inline text field. Settings, the charter block, the scope
// tabs and the project page all mount from here.

import { useMemo, useState } from "react";
import Link from "next/link";
import { OrgObjectLink } from "../company/OrgObjectLink";
import { X, FileText, Pencil, Check } from "lucide-react";
import { useWorkspaceCollection } from "../../../hooks/useWorkspaceCollection";
import type { DocItem, PlanItem, ProjectItem } from "../../../store/inboxStore";
import { compactAge } from "../../../lib/threadState";
import { SelectBox } from "../../ui/select-box";
import { cn } from "../../../lib/utils";
import { GhostChips } from "../OrgNodeCards";
import type { OrgGhostChip } from "../orgLayout";
import { ghostChipOf, refMatches } from "../orgLayout";
import type { OrgRole, OrgScope, OrgTree } from "../orgTypes";
import { TakeoverGate } from "../TakeoverEdit";
import { isHeadOfPeopleRole, type OrgProposalChange } from "../orgStaffingTypes";
import { PriorityPill } from "../../charter/CharterChips";
import { ProjectLeadChip } from "../../charter/ProjectLeadChip";
import { KeyCap } from "../../KeyboardShortcutsHelp";
import { isMac } from "../../../shortcuts";

export function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mt-5 mb-2">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>{children}</span>
      {right}
    </div>
  );
}

export function DocRow({ d, now }: { d: DocItem; now: number }) {
  const title = (d as any).display_title || d.title || "Untitled";
  return (
    <Link href={`/docs/${d._id}`} className="group flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors hover:bg-sol-bg-highlight/70">
      <span className="w-[3px] self-stretch rounded-full shrink-0" style={{ background: "color-mix(in srgb, var(--sol-border) 60%, transparent)" }} />
      <FileText className="w-4 h-4 shrink-0" style={{ color: "var(--sol-text-dim)" }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium" style={{ color: "var(--sol-text)" }}>{title}</span>
        <span className="block truncate text-[10.5px] mt-[1px]" style={{ color: "var(--sol-text-dim)" }}>page · {d.doc_type.replace(/_/g, " ")}</span>
      </span>
      <span className="text-[10.5px] tabular-nums shrink-0" style={{ color: "var(--sol-text-dim)" }}>{compactAge(now - d.updated_at)}</span>
    </Link>
  );
}

export function GatedScopeEditor({ workspace, role, onChange, ...editor }: Omit<React.ComponentProps<typeof ScopeEditor>, "onChange"> & {
  workspace: OrgTree["workspace"];
  onChange: (scope: OrgScope, opts?: { leave_sessions?: boolean }) => void;
}) {
  const [pending, setPending] = useState<OrgScope | null>(null);
  const gained = pending
    ? [...pending.project_ids.filter((id) => !role.scope.project_ids.includes(id)).map((id) => `project:${id}`), ...pending.plan_ids.filter((id) => !role.scope.plan_ids.includes(id)).map((id) => `plan:${id}`)]
    : [];
  const change = (scope: OrgScope) => {
    const adds = scope.project_ids.some((id) => !role.scope.project_ids.includes(id)) || scope.plan_ids.some((id) => !role.scope.plan_ids.includes(id));
    if (adds) setPending(scope); else { setPending(null); onChange(scope); }
  };
  return (
    <>
      <ScopeEditor {...editor} role={pending ? { ...role, scope: pending } : role} onChange={change} />
      {pending && gained.length > 0 && (
        <TakeoverGate
          // A different gain is a different question: the gate starts over.
          key={gained.join(",")}
          className="mt-2"
          workspace={workspace}
          ask={{ handle: role.handle, add: gained }}
          what={`@${role.handle} gains ${gained.length === 1 ? "this" : "these"}, and with ${gained.length === 1 ? "it" : "them"} the sessions inside that report to the person who runs it and to no role.`}
          confirmLabel="Change its area"
          onConfirm={(opts) => { onChange(pending, opts.leave_sessions ? opts : undefined); setPending(null); }}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  );
}

export function ScopeEditor({ role, canEdit, onChange, changes, focusChangeId, onSelectChange }: {
  role: OrgRole; canEdit: boolean; onChange: (scope: OrgScope) => void;
  changes?: OrgProposalChange[]; focusChangeId?: string | null; onSelectChange?: (changeId: string) => void;
}) {
  const projects = useWorkspaceCollection<ProjectItem>("projects");
  const plans = useWorkspaceCollection<PlanItem>("plans");
  const projectById = useMemo(() => new Map(projects.map((p) => [p._id, p])), [projects]);
  const planById = useMemo(() => new Map(plans.map((p) => [p._id, p])), [plans]);
  // A proposal's chips on the rows they name (S5): a project charter on its
  // project's row; a filing on its plan's row when the scope has the plan,
  // else on its project's row. Decided ones are gone from here.
  const open = useMemo(() => (changes ?? []).filter((c) => c.status !== "skipped" && c.status !== "applied" && c.status !== "removed"), [changes]);
  const chipsOnProject = (id: string): OrgGhostChip[] => {
    const row = { id, title: nameOfProject(id), short_id: (projectById.get(id) as { short_id?: string } | undefined)?.short_id };
    return open
      .filter((c) => (c.change.kind === "project_meta" && refMatches(c.change.project, row)) || (c.change.kind === "file" && refMatches(c.change.project, row) && !role.scope.plan_ids.some((pid) => c.change.kind === "file" && refMatches(c.change.plan, { id: pid, title: nameOfPlan(pid), short_id: shortOfPlan(pid) }))))
      .map((c) => ghostChipOf(c));
  };
  const chipsOnPlan = (id: string): OrgGhostChip[] =>
    open.filter((c) => c.change.kind === "file" && refMatches(c.change.plan, { id, title: nameOfPlan(id), short_id: shortOfPlan(id) })).map((c) => ghostChipOf(c));
  const nameOfProject = (id: string) => projectById.get(id)?.title ?? role.scope_names.projects.find((p) => p.id === id)?.title ?? "project";
  const nameOfPlan = (id: string) => planById.get(id)?.title ?? role.scope_names.plans.find((p) => p.id === id)?.title ?? "plan";
  const shortOfPlan = (id: string) => planById.get(id)?.short_id ?? role.scope_names.plans.find((p) => p.id === id)?.short_id;
  const empty = role.scope.project_ids.length === 0 && role.scope.plan_ids.length === 0;
  const remove = (kind: "project" | "plan", id: string) =>
    onChange(kind === "project"
      ? { ...role.scope, project_ids: role.scope.project_ids.filter((x) => x !== id) }
      : { ...role.scope, plan_ids: role.scope.plan_ids.filter((x) => x !== id) });
  const add = (value: string) => {
    if (!value) return;
    const [kind, id] = value.split(":", 2);
    if (kind === "project" && !role.scope.project_ids.includes(id)) onChange({ ...role.scope, project_ids: [...role.scope.project_ids, id] });
    if (kind === "plan" && !role.scope.plan_ids.includes(id)) onChange({ ...role.scope, plan_ids: [...role.scope.plan_ids, id] });
  };
  const openProjects = projects.filter((p) => !role.scope.project_ids.includes(p._id) && p.status !== "archived");
  const openPlans = plans.filter((p) => !role.scope.plan_ids.includes(p._id) && p.status !== "done" && p.status !== "dropped");
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {empty && (
          <span className="inline-flex items-center h-[22px] px-2 rounded-md border text-[11px]" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)", color: "var(--sol-text-muted)" }}>
            {isHeadOfPeopleRole(role) ? "whole workspace" : "no area of its own"}
          </span>
        )}
        {role.scope.project_ids.map((id) => (
          <span key={`p:${id}`} className="inline-flex items-center gap-1" data-scope-project={id}>
            <Chip tone="blue" href={`/projects/${id}`} object={{ kind: "project", ref: (projectById.get(id) as { short_id?: string } | undefined)?.short_id || id }} onRemove={canEdit ? () => remove("project", id) : undefined}>{nameOfProject(id)}</Chip>
            {/* The project's charter at a glance (org-staffing.md S7): its priority and who leads it (org-roles-run-work.md R4). */}
            <PriorityPill priority={projectById.get(id)?.priority} size="xs" />
            <ProjectLeadChip projectId={id} size="xs" />
            <GhostChips chips={chipsOnProject(id)} focusChangeId={focusChangeId} onFocusChange={onSelectChange} />
          </span>
        ))}
        {role.scope.plan_ids.map((id) => (
          <span key={`l:${id}`} className="inline-flex items-center gap-1" data-scope-plan={id}>
            <Chip tone="magenta" href={`/plans/${id}`} onRemove={canEdit ? () => remove("plan", id) : undefined}>{nameOfPlan(id)}</Chip>
            <GhostChips chips={chipsOnPlan(id)} focusChangeId={focusChangeId} onFocusChange={onSelectChange} />
          </span>
        ))}
      </div>
      {canEdit && (openProjects.length > 0 || openPlans.length > 0) && (
        <div className="mt-2">
          <SelectBox value="" onChange={(e) => add(e.target.value)} className="text-[12px]" aria-label="Add to its area">
            <option value="">Add a project or plan…</option>
            {openProjects.length > 0 && (
              <optgroup label="Projects">
                {openProjects.map((p) => <option key={p._id} value={`project:${p._id}`}>{p.title}</option>)}
              </optgroup>
            )}
            {openPlans.length > 0 && (
              <optgroup label="Plans">
                {openPlans.map((p) => <option key={p._id} value={`plan:${p._id}`}>{p.title}{p.short_id ? ` (${p.short_id})` : ""}</option>)}
              </optgroup>
            )}
          </SelectBox>
        </div>
      )}
    </div>
  );
}

export function Chip({ children, tone, mono, href, object, onRemove }: { children: React.ReactNode; tone: "blue" | "magenta"; mono?: boolean; href: string; /** An Org object: inside the screen the chip opens its sheet (D10). */ object?: { kind: "project"; ref: string }; onRemove?: () => void }) {
  const color = tone === "blue" ? "var(--sol-blue)" : "var(--sol-magenta)";
  return (
    <span className="inline-flex items-center h-[22px] rounded-md overflow-hidden text-[11px] font-medium" style={{ background: `color-mix(in srgb, ${color} 12%, transparent)`, color, fontFamily: mono ? "var(--font-mono)" : undefined }}>
      {object
        ? <OrgObjectLink kind={object.kind} objRef={object.ref} className="px-2 hover:underline truncate max-w-[160px]">{children}</OrgObjectLink>
        : <Link href={href} className="px-2 hover:underline truncate max-w-[160px]">{children}</Link>}
      {onRemove && (
        <button type="button" onClick={onRemove} className="h-full px-1.5 hover:bg-black/10 dark:hover:bg-white/10" aria-label="Remove from scope">
          <X className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- inline text edit

/** One inline field: a button showing the value until clicked, then the
 *  input. `ariaLabel` names the field for a screen reader (the placeholder
 *  is not a name); it labels both the button and the input. Enter commits a
 *  single line; a multiline field commits on the modifier plus Enter and
 *  shows that as keycaps beside the save button. */
export function InlineEdit({ value, onSave, className, style, placeholder, multiline, canEdit, ariaLabel }: { value: string; onSave: (v: string) => void; className?: string; style?: React.CSSProperties; placeholder?: string; multiline?: boolean; canEdit: boolean; ariaLabel?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editing) {
    return (
      <button
        type="button"
        disabled={!canEdit}
        onClick={() => { setDraft(value); setEditing(true); }}
        className={cn("group text-left w-full rounded-md -mx-1 px-1 disabled:cursor-default", canEdit && "hover:bg-sol-bg-highlight/60", className)}
        style={style}
        title={canEdit ? "Click to edit" : undefined}
        aria-label={ariaLabel ? (canEdit ? `Edit ${ariaLabel}` : ariaLabel) : undefined}
      >
        <span className={cn(!value && "italic opacity-60")}>{value || placeholder}</span>
        {canEdit && <Pencil className="inline-block w-3 h-3 ml-1.5 align-[-1px] opacity-0 group-hover:opacity-60 transition-opacity" />}
      </button>
    );
  }
  const commit = () => { setEditing(false); if (draft.trim() !== value) onSave(draft.trim()); };
  const Tag: any = multiline ? "textarea" : "input";
  return (
    <div className="flex items-start gap-1.5 w-full">
      <Tag
        autoFocus
        value={draft}
        rows={multiline ? 3 : undefined}
        onChange={(e: any) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e: any) => {
          if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
          if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
        }}
        className={cn("flex-1 min-w-0 rounded-md px-2 py-1 border outline-none text-[13px] bg-sol-bg-alt", className)}
        style={{ borderColor: "var(--sol-cyan)", color: "var(--sol-text)", ...style }}
        aria-label={ariaLabel}
        placeholder={placeholder}
      />
      {multiline && (
        <span className="flex items-center gap-0.5 mt-1.5 shrink-0" aria-hidden title={`${isMac ? "Command" : "Control"} Enter saves`}>
          <KeyCap size="xs">{isMac ? "⌘" : "Ctrl"}</KeyCap><KeyCap size="xs">↵</KeyCap>
        </span>
      )}
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={commit} className="h-7 w-7 inline-flex items-center justify-center rounded-md" style={{ color: "var(--sol-cyan)" }} aria-label={ariaLabel ? `Save ${ariaLabel}` : "Save"}><Check className="w-3.5 h-3.5" /></button>
    </div>
  );
}
