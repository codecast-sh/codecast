"use client";
// The two chips a charter shows wherever a project row appears: the priority
// pill and the owner role chip. Read only by default; pass an `onChange` and
// the pill opens a menu, pass `onChange` or `onHire` and the chip does too.
// The project list, the org scope panel and the charter block all render
// these, so a row reads the same everywhere.
import { useState } from "react";
import Link from "next/link";
import { Briefcase, ChevronDown, UserPlus } from "lucide-react";
import { cn } from "../../lib/utils";
import type { OrgRole, OrgTree } from "../org/orgTypes";
import { CHARTER_PRIORITIES, PRIORITY_META, ownerCandidates, ownerRoleOf, roleHref, type CharterPriority } from "./charterMeta";

/** The chip menu: a fixed backdrop closes it, the list floats under the chip. */
function ChipMenu({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div role="menu" className="absolute top-full left-0 mt-1 min-w-[180px] rounded-lg border shadow-xl py-1 z-50" style={{ background: "var(--sol-bg)", borderColor: "color-mix(in srgb, var(--sol-border) 55%, transparent)" }}>
        {children}
      </div>
    </>
  );
}

function MenuItem({ onClick, active, children }: { onClick: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn("w-full text-left flex items-center gap-2 px-3 py-1.5 text-[12px] transition-colors hover:bg-sol-bg-alt", active ? "text-sol-text bg-sol-bg-highlight/60" : "text-sol-text-muted")}
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
    <span className="relative inline-flex">
      <button type="button" className={cn(cls, "transition-colors hover:brightness-110")} style={style} title={meta?.hint ?? "Set the priority"} data-priority={priority} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        {body}
      </button>
      <ChipMenu open={open} onClose={() => setOpen(false)}>
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
    </span>
  );
}

export function OwnerRoleChip({ tree, ownerRoleId, onChange, onHire, size = "sm", className }: {
  tree: OrgTree | null | undefined;
  ownerRoleId: string | undefined;
  /** Editable when set: the chip opens the workspace's roles. */
  onChange?: (roleId: string | null) => void;
  /** "Hire a lead" in the menu, and the whole "no owner" chip when set. */
  onHire?: () => void;
  size?: "xs" | "sm";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const role = ownerRoleOf(tree, ownerRoleId);
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
  const candidates = ownerCandidates(tree);

  // Read only: the chip IS the link to the role.
  if (!editable) {
    return <Link href={roleHref(role!)} className={cn(cls, "hover:underline")} style={style} title={`${role!.name}: owns this`} data-owner={role!.short_id}>{icon}{label}</Link>;
  }
  // Editable with no menu to show (no roles and no way to hire): the chip is
  // the hire button, which the spec asks for on a project with no owner.
  const openMenu = candidates.length > 0 || (!!onHire && !!role);
  const onClick = () => {
    if (openMenu) setOpen((o) => !o);
    else onHire?.();
  };
  return (
    <span className="relative inline-flex">
      <button type="button" className={cn(cls, "transition-colors hover:brightness-110")} style={style} title={role ? `${role.name}: owns this. Click to change` : "No role owns this yet. Click to pick one or hire a lead"} data-owner={role?.short_id ?? "none"} onClick={onClick} aria-haspopup={openMenu ? "menu" : undefined} aria-expanded={openMenu ? open : undefined}>
        {icon}{label}{openMenu && <ChevronDown className="w-3 h-3 opacity-60" />}
      </button>
      <ChipMenu open={open} onClose={() => setOpen(false)}>
        {role && (
          <Link href={roleHref(role)} role="menuitem" className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-sol-text hover:bg-sol-bg-alt" onClick={() => setOpen(false)}>
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
    </span>
  );
}
