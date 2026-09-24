"use client";
// The two chips a charter shows wherever a project row appears: the priority
// pill and the owner role chip. Read only by default; pass an `onChange` and
// the pill opens a menu, pass `onChange` or `onHire` and the chip does too.
// The project list, the org scope panel and the charter block all render
// these, so a row reads the same everywhere.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Briefcase, ChevronDown, UserPlus } from "lucide-react";
import { cn } from "../../lib/utils";
import type { OrgRole } from "../org/orgTypes";
import { watchersLabel, type ProjectLead } from "@codecast/shared/contracts/orgLead";
import { RoleAvatar } from "../org/avatars";
import { RoleHoverCard } from "../identity";
import { CHARTER_PRIORITIES, PRIORITY_META, ownerCandidates, ownerRoleOf, roleHref, type CharterPriority, type OrgRoles } from "./charterMeta";

/** A chip with a menu under it. The trigger is the chip; the list floats
 *  below and a fixed backdrop closes it on a click outside. Keyboard: Escape
 *  closes and hands focus back to the chip, the arrow keys walk the items
 *  (wrapping), Home and End jump, and the first item takes focus on open. */
function ChipMenu({ open, onClose, trigger, children }: { open: boolean; onClose: () => void; trigger: React.ReactNode; children: React.ReactNode }) {
  const wrap = useRef<HTMLSpanElement>(null);
  const items = () => [...(wrap.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
  const focusTrigger = () => wrap.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
  // eslint-disable-next-line no-restricted-syntax -- moves focus into the menu each time it opens
  useEffect(() => { if (open) items()[0]?.focus(); }, [open]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); focusTrigger(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const list = items();
    if (list.length === 0) return;
    e.preventDefault();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : e.key === "ArrowDown" ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
    list[next]?.focus();
  };
  return (
    <span ref={wrap} className="relative inline-flex" onKeyDown={onKeyDown}>
      {trigger}
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={onClose} />
          <div role="menu" className="absolute top-full left-0 mt-1 min-w-[180px] rounded-lg border shadow-xl py-1 z-50" style={{ background: "var(--sol-bg)", borderColor: "color-mix(in srgb, var(--sol-border) 55%, transparent)" }}>
            {children}
          </div>
        </>
      )}
    </span>
  );
}

const MENU_ITEM = "w-full text-left flex items-center gap-2 px-3 py-1.5 text-[12px] transition-colors hover:bg-sol-bg-alt focus-visible:bg-sol-bg-alt outline-none";

function MenuItem({ onClick, active, children }: { onClick: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(MENU_ITEM, active ? "text-sol-text bg-sol-bg-highlight/60" : "text-sol-text-muted")}
    >
      {children}
    </button>
  );
}

export function PriorityDot({ priority, className }: { priority: CharterPriority; className?: string }) {
  return <span className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0", className)} style={{ background: PRIORITY_META[priority].color }} />;
}

export function PriorityPill({ priority, onChange, size = "sm", className }: {
  priority: CharterPriority | undefined;
  /** Editable when set: the pill opens the four levels plus "none". */
  onChange?: (p: CharterPriority | null) => void;
  size?: "xs" | "sm";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const meta = priority ? PRIORITY_META[priority] : null;
  if (!meta && !onChange) return null;
  const color = meta?.color ?? "var(--sol-text-dim)";
  const body = (
    <>
      <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
      <span className="font-mono">{meta?.label ?? "No priority"}</span>
      {onChange && <ChevronDown className="w-3 h-3 opacity-60" />}
    </>
  );
  const cls = cn(
    "inline-flex items-center gap-1.5 rounded-md border font-medium whitespace-nowrap",
    size === "xs" ? "h-[18px] px-1.5 text-[10px]" : "h-[22px] px-2 text-[11px]",
    !meta && "italic",
    className,
  );
  const style = { color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)`, background: `color-mix(in srgb, ${color} ${meta ? 12 : 0}%, transparent)` };
  if (!onChange) return <span className={cls} style={style} title={meta?.hint} data-priority={priority}>{body}</span>;
  return (
    <ChipMenu
      open={open}
      onClose={() => setOpen(false)}
      trigger={
        <button type="button" className={cn(cls, "transition-colors hover:brightness-110")} style={style} title={meta?.hint ?? "Set the priority"} data-priority={priority ?? "none"} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label={`Priority: ${meta?.label ?? "none"}`}>
          {body}
        </button>
      }
    >
        {CHARTER_PRIORITIES.map((p) => (
          <MenuItem key={p} active={p === priority} onClick={() => { setOpen(false); if (p !== priority) onChange(p); }}>
            <PriorityDot priority={p} />
            <span className="font-mono w-6" style={{ color: PRIORITY_META[p].color }}>{PRIORITY_META[p].label}</span>
            <span className="text-[11px] truncate" style={{ color: "var(--sol-text-dim)" }}>{PRIORITY_META[p].hint}</span>
          </MenuItem>
        ))}
        {priority && (
          <MenuItem onClick={() => { setOpen(false); onChange(null); }}>
            <span className="inline-block w-1.5 h-1.5 rounded-full border shrink-0" style={{ borderColor: "var(--sol-text-dim)" }} />
            <span>No priority</span>
          </MenuItem>
        )}
    </ChipMenu>
  );
}

/** A role's face at chip size. */
export function ChipFace({ role, px }: { role: OrgRole; px: number }) {
  return (
    <span className="inline-block rounded-full shrink-0" style={{ width: px, height: px, lineHeight: 0 }}>
      <RoleAvatar avatar={role.avatar ?? role.handle} size={px} title={role.name} />
    </span>
  );
}

/** The words a chip uses. A plan or a charter has an owner; a project has a
 *  lead (org-roles-run-work.md R4). Same chip, same menu, two vocabularies. */
const NOUN = {
  owner: { none: "No owner", holds: "owns this", pick: "No role owns this yet. Click to pick one or hire a lead", label: "Owner" },
  lead: { none: "No lead", holds: "leads this project", pick: "No role leads this project yet. Click to pick one", label: "Lead" },
} as const;

export function OwnerRoleChip({ roles, ownerRoleId, lead, noun = "owner", onChange, onHire, blockedReason, size = "sm", className }: {
  /** The workspace's roles (useOrgRoles): null while they load. */
  roles: OrgRoles;
  ownerRoleId: string | undefined;
  /** The answer of the one rule for who leads a project (projectLeadOf). When
   *  set it replaces the plain owner lookup: the chip can then show a lead the
   *  project does not name (the one role whose scope lists it) and the roles
   *  that watch a project nobody leads. */
  lead?: ProjectLead<OrgRole>;
  noun?: keyof typeof NOUN;
  /** Editable when set: the chip opens the workspace's roles. */
  onChange?: (roleId: string | null) => void;
  /** "Hire a lead" in the menu, and the whole "no owner" chip when set. */
  onHire?: () => void;
  /** Why no owner can be picked here when there is no role to offer and no
   *  hire path (the tree on screen is another workspace's, say). The chip
   *  renders disabled and says so, instead of a button that does nothing. */
  blockedReason?: string;
  size?: "xs" | "sm";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const words = NOUN[noun];
  const role = lead ? (lead.kind === "lead" ? lead.role : null) : ownerRoleOf(roles, ownerRoleId);
  const watchers = lead?.kind === "watchers" ? lead.roles : [];
  const named = !!role || watchers.length > 0;
  const editable = !!onChange || !!onHire;
  if (!named && !editable && noun === "owner") return null;
  const color = role ? "var(--sol-violet)" : watchers.length ? "var(--sol-yellow)" : "var(--sol-text-dim)";
  const px = size === "xs" ? 12 : 14;
  const cls = cn(
    "inline-flex items-center gap-1.5 rounded-md border font-medium whitespace-nowrap max-w-[220px]",
    size === "xs" ? "h-[18px] px-1.5 text-[10px]" : "h-[22px] px-2 text-[11px]",
    !named && "italic",
    className,
  );
  const style = { color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)`, background: `color-mix(in srgb, ${color} ${named ? 12 : 0}%, transparent)` };
  // The face and the name open the role's card (session-characters.md S4);
  // closed while the menu is open so the two never stack.
  const inner = role ? (
    <RoleHoverCard role={role} side="top" disabled={open} triggerClassName="inline-flex min-w-0 items-center gap-1.5">
      <ChipFace role={role} px={px} /><span className="truncate">{role.name}</span>
    </RoleHoverCard>
  ) : watchers.length ? (
    <>
      <span className="inline-flex items-center shrink-0">
        {watchers.map((w, i) => (
          <RoleHoverCard key={w._id} role={w} side="top" disabled={open} triggerClassName={cn("inline-flex", i > 0 && "-ml-1")}>
            <ChipFace role={w} px={px} />
          </RoleHoverCard>
        ))}
      </span>
      <span className="truncate">{watchersLabel(watchers.length)}</span>
    </>
  ) : (
    <><UserPlus className="w-3 h-3 shrink-0" /><span>{words.none}</span></>
  );
  const watchersTitle = `${watchers.map((w) => w.name).join(" and ")} both look after this project and it names neither as its lead`;
  const candidates = ownerCandidates(roles);

  // Read only: the chip IS the link to the role. Roles that only watch have
  // no one page to open, so the chip is plain and each face carries its card.
  if (!editable) {
    if (role) return <Link href={roleHref(role)} className={cn(cls, "hover:underline")} style={style} title={`${role.name}: ${words.holds}`} data-owner={role.short_id}>{inner}</Link>;
    return <span className={cls} style={style} title={watchers.length ? watchersTitle : undefined} data-owner={watchers.length ? "watchers" : "none"}>{inner}</span>;
  }
  // Editable with no menu to show (no roles and no way to hire): the chip is
  // the hire button, which the spec asks for on a project with no owner.
  const openMenu = candidates.length > 0 || (!!onHire && !!role);
  // Nothing to open and no hire path: a click would do nothing, so the chip
  // says why instead of looking editable.
  const blocked = !openMenu && !onHire;
  const reason = blockedReason ?? (roles ? "No roles in this workspace yet: hire one on the org page" : "Roles are still loading");
  const onClick = () => {
    if (openMenu) setOpen((o) => !o);
    else onHire?.();
  };
  // The roles that already watch the project come first: one of them is the
  // likely answer to "who leads this".
  const watching = new Set(watchers.map((w) => w._id));
  const ordered = [...candidates.filter((r) => watching.has(r._id)), ...candidates.filter((r) => !watching.has(r._id))];
  return (
    <ChipMenu
      open={open}
      onClose={() => setOpen(false)}
      trigger={
        <button
          type="button"
          className={cn(cls, blocked ? "cursor-default opacity-70" : "transition-colors hover:brightness-110")}
          style={style}
          title={role ? `${role.name}: ${words.holds}. Click to change` : watchers.length ? `${watchersTitle}. Click to name one` : blocked ? reason : words.pick}
          data-owner={role?.short_id ?? (watchers.length ? "watchers" : "none")}
          data-owner-blocked={blocked ? "" : undefined}
          disabled={blocked}
          onClick={onClick}
          aria-haspopup={openMenu ? "menu" : undefined}
          aria-expanded={openMenu ? open : undefined}
          aria-label={role ? `${words.label}: ${role.name}, @${role.handle}` : watchers.length ? watchersTitle : blocked ? `${words.none}. ${reason}` : words.none}
        >
          {inner}{openMenu && <ChevronDown className="w-3 h-3 opacity-60" />}
        </button>
      }
    >
        {role && (
          <Link href={roleHref(role)} role="menuitem" className={cn(MENU_ITEM, "text-sol-text")} onClick={() => setOpen(false)}>
            <Briefcase className="w-3 h-3" style={{ color: "var(--sol-violet)" }} />
            <span className="truncate">Open @{role.handle}</span>
          </Link>
        )}
        {onChange && ordered.map((r: OrgRole) => (
          <MenuItem key={r._id} active={r._id === role?._id} onClick={() => { setOpen(false); if (r._id !== role?._id || (lead?.kind === "lead" && lead.by === "scope")) onChange(r._id); }}>
            <ChipFace role={r} px={14} />
            <span className="truncate">{r.name}</span>
            <span className="font-mono text-[11px] truncate" style={{ color: "var(--sol-text-dim)" }}>@{r.handle}{watching.has(r._id) ? " · watches it" : ""}</span>
          </MenuItem>
        ))}
        {onHire && (
          <MenuItem onClick={() => { setOpen(false); onHire(); }}>
            <UserPlus className="w-3 h-3" />
            <span>Hire a lead</span>
          </MenuItem>
        )}
        {onChange && role && (!lead || (lead.kind === "lead" && lead.by === "owner")) && (
          <MenuItem onClick={() => { setOpen(false); onChange(null); }}>
            <span className="w-3" />
            <span>{words.none}</span>
          </MenuItem>
        )}
    </ChipMenu>
  );
}
