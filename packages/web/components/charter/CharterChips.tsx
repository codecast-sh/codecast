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
import { CHARTER_PRIORITIES, PRIORITY_META, ownerCandidates, ownerRoleOf, roleHref, type CharterPriority, type OrgRoles } from "./charterMeta";

/** A chip with a menu under it. The trigger is the chip; the list floats
 *  below and a fixed backdrop closes it on a click outside. Keyboard: Escape
 *  closes and hands focus back to the chip, the arrow keys walk the items
 *  (wrapping), Home and End jump, and the first item takes focus on open. */
function ChipMenu({ open, onClose, trigger, children }: { open: boolean; onClose: () => void; trigger: React.ReactNode; children: React.ReactNode }) {
  const wrap = useRef<HTMLSpanElement>(null);
  const items = () => [...(wrap.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
  const focusTrigger = () => wrap.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
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

export function OwnerRoleChip({ roles, ownerRoleId, onChange, onHire, blockedReason, size = "sm", className }: {
  /** The workspace's roles (useOrgRoles): null while they load. */
  roles: OrgRoles;
  ownerRoleId: string | undefined;
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
  const role = ownerRoleOf(roles, ownerRoleId);
  const editable = !!onChange || !!onHire;
  if (!role && !editable) return null;
  const color = role ? "var(--sol-violet)" : "var(--sol-text-dim)";
  const cls = cn(
    "inline-flex items-center gap-1.5 rounded-md border font-medium whitespace-nowrap max-w-[200px]",
    size === "xs" ? "h-[18px] px-1.5 text-[10px]" : "h-[22px] px-2 text-[11px]",
    !role && "italic",
    className,
  );
  const style = { color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)`, background: `color-mix(in srgb, ${color} ${role ? 12 : 0}%, transparent)` };
  const label = role ? <span className="truncate">@{role.handle}</span> : <span>No owner</span>;
  const icon = role ? <Briefcase className="w-3 h-3 shrink-0" /> : <UserPlus className="w-3 h-3 shrink-0" />;
  const candidates = ownerCandidates(roles);

  // Read only: the chip IS the link to the role.
  if (!editable) {
    return <Link href={roleHref(role!)} className={cn(cls, "hover:underline")} style={style} title={`${role!.name}: owns this`} data-owner={role!.short_id}>{icon}{label}</Link>;
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
  return (
    <ChipMenu
      open={open}
      onClose={() => setOpen(false)}
      trigger={
        <button
          type="button"
          className={cn(cls, blocked ? "cursor-default opacity-70" : "transition-colors hover:brightness-110")}
          style={style}
          title={role ? `${role.name}: owns this. Click to change` : blocked ? reason : "No role owns this yet. Click to pick one or hire a lead"}
          data-owner={role?.short_id ?? "none"}
          data-owner-blocked={blocked ? "" : undefined}
          disabled={blocked}
          onClick={onClick}
          aria-haspopup={openMenu ? "menu" : undefined}
          aria-expanded={openMenu ? open : undefined}
          aria-label={role ? `Owner: @${role.handle}` : blocked ? `No owner. ${reason}` : "No owner"}
        >
          {icon}{label}{openMenu && <ChevronDown className="w-3 h-3 opacity-60" />}
        </button>
      }
    >
        {role && (
          <Link href={roleHref(role)} role="menuitem" className={cn(MENU_ITEM, "text-sol-text")} onClick={() => setOpen(false)}>
            <Briefcase className="w-3 h-3" style={{ color: "var(--sol-violet)" }} />
            <span className="truncate">Open @{role.handle}</span>
          </Link>
        )}
        {onChange && candidates.map((r: OrgRole) => (
          <MenuItem key={r._id} active={r._id === role?._id} onClick={() => { setOpen(false); if (r._id !== role?._id) onChange(r._id); }}>
            <span className="font-mono truncate">@{r.handle}</span>
            <span className="text-[11px] truncate" style={{ color: "var(--sol-text-dim)" }}>{r.name}</span>
          </MenuItem>
        ))}
        {onHire && (
          <MenuItem onClick={() => { setOpen(false); onHire(); }}>
            <UserPlus className="w-3 h-3" />
            <span>Hire a lead…</span>
          </MenuItem>
        )}
        {onChange && role && (
          <MenuItem onClick={() => { setOpen(false); onChange(null); }}>
            <span className="w-3" />
            <span>No owner</span>
          </MenuItem>
        )}
    </ChipMenu>
  );
}
