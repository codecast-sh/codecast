// A person's profile and reporting lines on their page (docs/architecture/
// org-people.md P3, P4): what they do (title, focus, labels, about), everyone
// they report to, people and roles, and who reports to them. Edited in place
// by the person or an admin; a manager is added or removed here beside the
// chart's drag. Reads the store only: the short fields and the lines from the
// org tree's person row, `about` from their detail row (useSyncOrgPerson).
import { roleManagers } from "@codecast/shared/contracts/orgLead";
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { Plus, X } from "lucide-react";
import { PROFILE_ABOUT_MAX, PROFILE_FOCUS_MAX, PROFILE_TITLE_MAX, normalizeLabels } from "@codecast/shared/contracts/personProfile";
import { useInboxStore } from "../../store/inboxStore";
import { orgPersonReparentMakesCycle, windowOrgTree } from "../../store/orgSlice";
import { useOrgPersonDetail, useSyncOrgPerson } from "../../hooks/useSyncOrgPerson";
import { teamMembersOf } from "../../lib/activeTeam";
import { cn } from "../../lib/utils";
import { sameParent, type OrgParentRef, type OrgPerson, type OrgRole, type OrgTree } from "./orgTypes";
import { InlineEdit } from "./scope/ScopeEditors";
import { managerEditRule, mayEditProfile } from "../../store/orgProfile";
import { RoleFace } from "./RoleFace";
import { roleWords } from "./orgStaffingTypes";
import { objectHref } from "@codecast/shared/entities";
import { Avatar } from "../tasks/TaskCommentStream";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

const MAX_MANAGERS = 6;

/** A person's page link by their GitHub handle, else their id. */
export function usePersonHref(): (userId: string) => string {
  const members = useInboxStore(teamMembersOf) as Array<{ _id: string; github_username?: string }> | undefined;
  return useCallback((id: string) => `/team/${encodeURIComponent(members?.find((m) => String(m._id) === id)?.github_username || id)}`, [members]);
}

export function PersonProfile({ userId }: { userId: string }) {
  const tree = useInboxStore(windowOrgTree);
  const teamId = tree?.workspace?.kind === "team" ? tree.workspace.id : undefined;
  useSyncOrgPerson(teamId, userId);
  const detail = useOrgPersonDetail(teamId, userId);
  const hrefOf = usePersonHref();
  const setProfile = useInboxStore((s) => s.setOrgPersonProfile);
  const person = tree?.people.find((p) => p.user_id === userId);
  if (!tree || !teamId || !person) return null;
  const canEdit = mayEditProfile(tree, userId);
  const save = (patch: Parameters<typeof setProfile>[2]) => setProfile(teamId, userId, patch);
  const reports = tree.people.filter((p) => p.managers?.some((m) => m.kind === "user" && m.user_id === userId));
  const roles = tree.roles.filter((r) => r.status !== "retired" && roleManagers(r).some((m) => m.kind === "user" && m.user_id === userId));

  return (
    <section className="mb-3 rounded-lg border px-3 py-2.5" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)" }} data-person-profile>
      <InlineEdit
        value={person.title ?? ""}
        canEdit={canEdit}
        maxLength={PROFILE_TITLE_MAX}
        onSave={(v) => save({ title: v })}
        placeholder={canEdit ? "Add a title" : "No title"}
        ariaLabel="title"
        className="text-[14px] font-semibold"
        style={{ color: "var(--sol-text)" }}
      />
      <InlineEdit
        value={person.focus ?? ""}
        canEdit={canEdit}
        maxLength={PROFILE_FOCUS_MAX}
        onSave={(v) => save({ focus: v })}
        placeholder={canEdit ? (person.is_me ? "What you look after, in one line" : "What they look after, in one line") : "No focus"}
        ariaLabel="focus"
        className="mt-0.5 text-[13px]"
        style={{ color: "var(--sol-text-muted)" }}
      />
      <Labels labels={person.labels ?? []} canEdit={canEdit} onSave={(labels) => save({ labels })} />

      <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12px] items-center">
        <dt style={{ color: "var(--sol-text-dim)" }}>Reports to</dt>
        <dd><Managers tree={tree} person={person} teamId={teamId} hrefOf={hrefOf} /></dd>
        {(reports.length > 0 || roles.length > 0) && (
          <>
            <dt style={{ color: "var(--sol-text-dim)" }}>Reporting to them</dt>
            <dd className="flex flex-wrap gap-1">
              {reports.map((p) => <PersonChip key={p.user_id} person={p} href={hrefOf(p.user_id)} />)}
              {roles.map((r) => <RoleChip key={r._id} role={r} />)}
            </dd>
          </>
        )}
        {!!detail?.areas.length && (
          <>
            <dt style={{ color: "var(--sol-text-dim)" }}>Decides for</dt>
            <dd style={{ color: "var(--sol-text-muted)" }}>{detail.areas.join(", ")}</dd>
          </>
        )}
      </dl>

      <div className="mt-2.5 text-[13px] whitespace-pre-wrap" style={{ color: "var(--sol-text)" }}>
        <InlineEdit
          value={detail?.about ?? ""}
          canEdit={canEdit}
          multiline
          maxLength={PROFILE_ABOUT_MAX}
          onSave={(v) => save({ about: v })}
          placeholder={canEdit ? (person.is_me ? "What you own, what to bring you, how to reach you" : "What they own, what to bring them, how to reach them") : "No longer description yet"}
          ariaLabel="about"
        />
      </div>
    </section>
  );
}

function Labels({ labels, canEdit, onSave }: { labels: string[]; canEdit: boolean; onSave: (labels: string[]) => void }) {
  if (!labels.length && !canEdit) return null;
  return (
    <div className="mt-1.5">
      <InlineEdit
        value={labels.join(", ")}
        canEdit={canEdit}
        onSave={(v) => onSave(normalizeLabels([v]))}
        placeholder="Add labels"
        ariaLabel="labels"
        className="text-[12px]"
        style={{ color: "var(--sol-text-dim)" }}
        display={
          <span className="inline-flex flex-wrap gap-1">
            {labels.map((l) => (
              <span key={l} className="rounded px-1.5 text-meta" style={{ background: "color-mix(in srgb, var(--sol-cyan) 12%, transparent)", color: "var(--sol-cyan)" }}>{l}</span>
            ))}
          </span>
        }
      />
    </div>
  );
}

const chipClass = "inline-flex items-center gap-1 rounded-full border pl-0.5 pr-2 h-6 text-[12px] max-w-[220px]";
const chipStyle = { borderColor: "color-mix(in srgb, var(--sol-border) 35%, transparent)", color: "var(--sol-text)" };

function PersonChip({ person, href, onRemove }: { person: Pick<OrgPerson, "name" | "image" | "title">; href: string; onRemove?: () => void }) {
  return (
    <span className={chipClass} style={chipStyle} data-manager-chip>
      <Link href={href} className="inline-flex items-center gap-1 min-w-0 hover:underline" title={person.title ? `${person.name} · ${person.title}` : person.name}>
        <Avatar name={person.name} image={person.image} size="sm" />
        <span className="truncate">{person.name}</span>
      </Link>
      {onRemove && <RemoveButton label={person.name} onClick={onRemove} />}
    </span>
  );
}

/** A role by the name headers give it, opening its page (the org scope
 *  page), the way a person chip opens a person's. */
function RoleChip({ role, onRemove }: { role: OrgRole; onRemove?: () => void }) {
  const name = roleWords(role).subtitle;
  return (
    <span className={chipClass} style={chipStyle} data-manager-chip>
      <Link href={objectHref("role", role.short_id)} className="inline-flex items-center gap-1 min-w-0 hover:underline" title={`@${role.handle}`}>
        <RoleFace role={role} size={18} />
        <span className="truncate">{name}</span>
      </Link>
      {onRemove && <RemoveButton label={name} onClick={onRemove} />}
    </span>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="-mr-1 ml-0.5 rounded-full p-0.5 opacity-50 hover:opacity-100 hover:bg-sol-bg-highlight" aria-label={`Remove ${label}`}>
      <X className="w-3 h-3" />
    </button>
  );
}

/** Every manager as a link, each removable by whoever may, and an Add that
 *  offers only the managers this viewer may add (`may`) that the subject can
 *  take (`allowed`: not itself, no loop). `min` keeps the last ones fixed. */
export function ManagerChips({ tree, managers, onChange, may, allowed, exclude, min = 0, hrefOf }: {
  tree: OrgTree;
  managers: OrgParentRef[];
  onChange: (next: OrgParentRef[]) => void;
  may: (m: OrgParentRef) => boolean;
  allowed: (m: OrgParentRef) => boolean;
  /** The subject itself, never offered. */
  exclude: OrgParentRef;
  min?: number;
  hrefOf: (userId: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const candidates = useMemo(() => {
    if (managers.length >= MAX_MANAGERS) return [];
    const free = (m: OrgParentRef) => !sameParent(m, exclude) && may(m) && !managers.some((x) => sameParent(x, m)) && allowed(m);
    // A seat's agent account sits on the roster; a role is offered as itself.
    const bots = new Set(tree.anchors.map((a) => a.bot_user_id));
    const people = tree.people.filter((p) => !bots.has(p.user_id)).map((p) => ({ ref: { kind: "user", user_id: p.user_id } as OrgParentRef, person: p })).filter((c) => free(c.ref));
    const roles = tree.roles.filter((r) => r.status !== "retired").map((r) => ({ ref: { kind: "role", role_id: r._id } as OrgParentRef, role: r })).filter((c) => free(c.ref));
    return [...people, ...roles];
  }, [tree, managers, may, allowed, exclude]);
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? candidates.filter((c) => ("person" in c ? [c.person.name, c.person.title] : [c.role.handle, roleWords(c.role).subtitle, c.role.name]).some((w) => w?.toLowerCase().includes(needle)))
    : candidates;
  const removable = managers.length > min;

  return (
    <div className="flex flex-wrap items-center gap-1" data-managers>
      {managers.map((m) => {
        const remove = removable && may(m) ? () => onChange(managers.filter((x) => !sameParent(x, m))) : undefined;
        if (m.kind === "user") {
          const p = tree.people.find((x) => x.user_id === m.user_id);
          return p ? <PersonChip key={m.user_id} person={p} href={hrefOf(p.user_id)} onRemove={remove} /> : null;
        }
        const r = tree.roles.find((x) => x._id === m.role_id);
        return r ? <RoleChip key={m.role_id} role={r} onRemove={remove} /> : null;
      })}
      {managers.length === 0 && <span style={{ color: "var(--sol-text-dim)" }}>Nobody</span>}
      {candidates.length > 0 && (
        <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ(""); }}>
          <PopoverTrigger asChild>
            <button type="button" className="inline-flex items-center gap-0.5 rounded-full h-6 px-2 text-[12px] hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-muted)" }} aria-label="Add a manager" data-add-manager>
              <Plus className="w-3 h-3" />Add
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-1">
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && shown[0]) { e.preventDefault(); onChange([...managers, shown[0].ref]); setOpen(false); setQ(""); } }}
              placeholder="Find a person or role"
              aria-label="Find a manager"
              className="mb-1 w-full rounded-md border bg-transparent px-2 py-1 text-[12px] outline-none focus:border-sol-cyan"
              style={{ borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)", color: "var(--sol-text)" }}
              data-manager-filter
            />
            <div className="max-h-64 overflow-y-auto">
            {shown.length === 0 && <div className="px-2 py-1.5 text-[12px]" style={{ color: "var(--sol-text-dim)" }}>No match</div>}
            {shown.map((c) => (
              <button
                key={"person" in c ? c.person.user_id : c.role._id}
                type="button"
                onClick={() => { onChange([...managers, c.ref]); setOpen(false); setQ(""); }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-sol-bg-highlight"
                style={{ color: "var(--sol-text)" }}
              >
                {"person" in c
                  ? <><Avatar name={c.person.name} image={c.person.image} size="sm" /><span className="truncate flex-1">{c.person.name}</span>{c.person.title && <span className="truncate text-meta max-w-[100px]" style={{ color: "var(--sol-text-dim)" }} title={c.person.title}>{c.person.title}</span>}</>
                  : <><RoleFace role={c.role} size={18} /><span className="truncate flex-1">{roleWords(c.role).subtitle}</span><span className="truncate text-meta max-w-[100px]" style={{ color: "var(--sol-text-dim)", fontFamily: "var(--font-mono)" }}>@{c.role.handle}</span></>}
              </button>
            ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

/** A person's managers: the rule of orgPeople.performSetManagers, written
 *  through reparentOrgPerson. */
function Managers({ tree, person, teamId, hrefOf }: { tree: OrgTree; person: OrgPerson; teamId: string; hrefOf: (id: string) => string }) {
  const reparent = useInboxStore((s) => s.reparentOrgPerson);
  const may = useMemo(() => managerEditRule(tree, person.user_id), [tree, person.user_id]);
  const allowed = useCallback((m: OrgParentRef) => !orgPersonReparentMakesCycle(tree, person.user_id, m), [tree, person.user_id]);
  const exclude = useMemo<OrgParentRef>(() => ({ kind: "user", user_id: person.user_id }), [person.user_id]);
  return <ManagerChips tree={tree} managers={person.managers ?? []} onChange={(next) => reparent(teamId, person.user_id, next)} may={may} allowed={allowed} exclude={exclude} hrefOf={hrefOf} />;
}
