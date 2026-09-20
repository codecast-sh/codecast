"use client";
// Who leads a project, wherever a project is named (org-roles-run-work.md
// R4): the project page header, the project list, a role's scope view, the
// chart node's scope chips and the task board's project group header. The
// face and the name with the role's hover card; "two roles watch this" with
// both faces when nobody is named; "No lead" with the one gesture Add a lead,
// which opens the hire form with this project filled in.
//
// The chip takes a project id and reads the store itself, so a row or a group
// header needs nothing else. It mounts no feeder: the page that shows it
// mounts `useSyncOrgTreeFeeder()` once. Who leads is `projectLeadOf`, the one
// rule the server and the analyzer also read.
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { UserPlus } from "lucide-react";
import { projectLeadOf, watchersLabel, type ProjectLead } from "@codecast/shared/contracts/orgLead";
import { useInboxStore, type ProjectItem } from "../../store/inboxStore";
import { projectLeadScopeOutcome } from "../../store/orgSlice";
import { useOrgRoles } from "../../hooks/useOrgRoles";
import { cn } from "../../lib/utils";
import { HireRoleDialog } from "../org/HireRoleDialog";
import { TakeoverGate } from "../org/TakeoverEdit";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import type { OrgRole } from "../org/orgTypes";
import { RoleHoverCard } from "../identity";
import { ChipFace, OwnerRoleChip } from "./CharterChips";

/** The hire form reads the whole org tree (reports-to choices, caps), so it
 *  subscribes to it only while open: the surface around it reads the roles. */
export function HireLeadDialog(props: Omit<React.ComponentProps<typeof HireRoleDialog>, "tree">) {
  const tree = useInboxStore((s) => s.orgTree);
  if (!tree) return null;
  return <HireRoleDialog tree={tree} {...props} />;
}

/** What the chip branches on, as one string: a heartbeat on any other project
 *  field, or on any other project, re-renders nothing. */
function projectLeadSig(p: ProjectItem | undefined): string {
  return p ? `${p._id}|${p.owner_role_id ?? ""}|${p.team_id ?? ""}|${p.title}|${p.project_path ?? ""}` : "";
}

/** The project's lead, from the store. `roles` is null until the org tree on
 *  screen is the project's own workspace: a role lives in one workspace, so
 *  another workspace's roles can neither lead this project nor be offered. */
export function useProjectLead(projectId: string): { project: ProjectItem | undefined; roles: OrgRole[] | null; lead: ProjectLead<OrgRole>; otherWorkspace: boolean } {
  const sig = useInboxStore((s) => projectLeadSig(s.projects[projectId]));
  const { roles, workspace } = useOrgRoles();
  return useMemo(() => {
    const project = useInboxStore.getState().projects[projectId];
    const mine = !!workspace && !!project && (workspace.kind === "team" ? project.team_id === workspace.id : !project.team_id);
    const scoped = mine ? roles : null;
    return { project, roles: scoped, lead: projectLeadOf(project, scoped), otherWorkspace: !!workspace && !!project && !mine };
  }, [sig, roles, workspace, projectId]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** One sentence that says both things the gesture did. */
function leadToast(role: OrgRole, title: string, outcome: ReturnType<typeof projectLeadScopeOutcome>): string {
  const led = `${role.name} now leads ${title}`;
  switch (outcome.kind) {
    case "add": return `${led}, and ${title} was added to what it looks after. The role was told.`;
    case "outside_parent": return `${led}. ${title} stays outside its scope, because @${outcome.parent.handle}, which it reports to, does not look after it.`;
    case "not_admin": return `${led}. Adding ${title} to its scope needs an admin.`;
    default: return `${led}. The role was told.`;
  }
}

export function ProjectLeadChip({ projectId, size = "sm", editable = false, className }: {
  projectId: string;
  size?: "xs" | "sm";
  /** The project page: the chip opens the workspace's roles to name a lead. */
  editable?: boolean;
  className?: string;
}) {
  const { project, roles, lead, otherWorkspace } = useProjectLead(projectId);
  const meId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const setProjectLead = useInboxStore((s) => s.setProjectLead);
  const createOrgRole = useInboxStore((s) => s.createOrgRole);
  const [hireOpen, setHireOpen] = useState(false);
  // A lead whose scope gains this project takes over the sessions in it (R1):
  // that gesture waits at the gate for the count and the person's one edit.
  const [pending, setPending] = useState<{ role: OrgRole; text: string } | null>(null);
  // Nothing honest to say before the project and its workspace's roles are
  // here: "No lead" on a project whose lead has not loaded would be a lie.
  if (!project || (!roles && !otherWorkspace)) return null;
  const canHire = !!roles && !!meId;

  const onChange = (roleId: string | null) => {
    const tree = useInboxStore.getState().orgTree;
    const role = roleId ? tree?.roles.find((r) => r._id === roleId) : undefined;
    // Read the outcome BEFORE the write: after it the scope already lists the
    // project and the sentence would lose its second half.
    const outcome = role && tree ? projectLeadScopeOutcome(tree, projectId, role) : null;
    const text = role && outcome ? leadToast(role, project.title, outcome) : `${project.title} has no named lead now`;
    // Only a lead whose scope GAINS the project can take sessions over; every
    // other outcome writes at once, as it always did.
    if (role && outcome?.kind === "add") { setPending({ role, text }); return; }
    name(roleId, text);
  };
  // Painted by the store action; the promise carries only what the server
  // alone knows: the sessions in the project that now report to the role (R1).
  const name = (roleId: string | null, text: string, opts?: { leave_sessions?: boolean }) => {
    void setProjectLead(projectId, roleId, opts).then((r) => { if (r?.took_over) toast.message(r.took_over); }).catch(() => {});
    toast.success(text);
  };

  return (
    // A chip inside a clickable row or group header keeps its clicks to itself.
    <span className={cn("inline-flex items-center gap-1.5 min-w-0", className)} onClick={(e) => e.stopPropagation()} data-project-lead={lead.kind}>
      {pending && (
        <Popover open onOpenChange={(open) => { if (!open) setPending(null); }}>
          <PopoverAnchor className="self-stretch" />
          <PopoverContent align="start" sideOffset={6} className="w-[300px] p-0 border-0 bg-transparent shadow-none" data-lead-gate>
            <TakeoverGate
              key={pending.role._id}
              workspace={useInboxStore.getState().orgTree?.workspace}
              ask={{ handle: pending.role.handle, add: [`project:${projectId}`] }}
              what={`${pending.role.name} will lead ${project.title}, and ${project.title} joins what it looks after.`}
              confirmLabel="Name the lead"
              onConfirm={(opts) => { name(pending.role._id, pending.text, opts.leave_sessions ? opts : undefined); setPending(null); }}
              onCancel={() => setPending(null)}
            />
          </PopoverContent>
        </Popover>
      )}
      <OwnerRoleChip
        roles={roles}
        ownerRoleId={project.owner_role_id}
        lead={lead}
        noun="lead"
        size={size}
        onChange={editable ? onChange : undefined}
        // Editable with no role to offer: the chip is disabled and says why,
        // instead of a "No lead" that looks like nothing can be done.
        blockedReason={otherWorkspace ? "Switch to the project's workspace to name its lead" : undefined}
      />
      {lead.kind === "none" && canHire && (
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); setHireOpen(true); }}
          title="A standing role that leads this project: it reads the project's plans, tasks and sessions and reports to you"
          className={cn("inline-flex items-center gap-1 rounded-md border font-medium whitespace-nowrap transition-colors hover:bg-sol-bg-highlight/60", size === "xs" ? "h-[18px] px-1.5 text-[10px]" : "h-[22px] px-2 text-[11px]")}
          style={{ color: "var(--sol-violet)", borderColor: "color-mix(in srgb, var(--sol-violet) 45%, transparent)" }}
          data-add-lead
        >
          <UserPlus className="w-3 h-3 shrink-0" /> Add a lead
        </button>
      )}
      {canHire && hireOpen && (
        <HireLeadDialog
          open={hireOpen}
          onClose={() => setHireOpen(false)}
          meId={meId}
          title={`Add a lead for ${project.title}`}
          initialProjects={[project]}
          projectPath={project.project_path ?? undefined}
          onCreate={(input) => { createOrgRole(input); setHireOpen(false); toast.success(`@${input.handle} is being created and started`); }}
        />
      )}
    </span>
  );
}

/** The lead of a project, said inside a chip too tight for the whole
 *  ProjectLeadChip: a project chip on a role's chart node, where `roleId` is
 *  the role the node draws. "lead" when that role leads it; the face of the
 *  role that does when it is another (a role under this one, usually); "no
 *  lead" when several roles watch it and the project names none. */
export function ProjectLeadMark({ projectId, roleId }: { projectId: string; roleId: string }) {
  const { lead } = useProjectLead(projectId);
  if (lead.kind === "none") return null;
  if (lead.kind === "watchers") {
    return (
      <span className="shrink-0 italic" style={{ color: "var(--sol-yellow)" }} title={`${watchersLabel(lead.roles.length)}: ${lead.roles.map((r) => r.name).join(", ")}. The project names none of them as its lead.`} data-project-lead="watchers">
        · no lead
      </span>
    );
  }
  if (lead.role._id === roleId) {
    return <span className="shrink-0 font-semibold" style={{ color: "var(--sol-violet)" }} title={lead.by === "owner" ? "The project names this role as its lead" : "The only role whose scope lists this project, so it leads it"} data-project-lead="self">· lead</span>;
  }
  return (
    <RoleHoverCard role={lead.role} side="top" triggerClassName="inline-flex shrink-0">
      <span className="inline-flex" title={`${lead.role.name} leads this project`} data-project-lead={lead.role.short_id}><ChipFace role={lead.role} px={12} /></span>
    </RoleHoverCard>
  );
}
