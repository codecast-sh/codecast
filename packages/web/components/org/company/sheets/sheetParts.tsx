"use client";
// What the four sheets share beyond the frame: the crumb that says where an
// object sits, the names a Serves line links, the compact lines a Carried by
// lists, what a role is doing in a Now, and the one line an object not in the
// store says instead.
import type { ReactNode } from "react";
import { cn } from "../../../../lib/utils";
import { EntityIdPill } from "../../../EntityIdPill";
import { LINE_COMPACT, LINE_SCOPE } from "../../lines/lineData";
import { RoleFace } from "../../RoleFace";
import type { OrgRole } from "../../orgTypes";
import { NowBar, NowLine } from "../NowBlock";
import { roleNow } from "./sheetModel";

/** A sheet's Carried by: compact lines (title, owner, state). */
export function CarriedLines({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(LINE_SCOPE, LINE_COMPACT, className)} data-sheet-carried>{children}</div>;
}

/** What a sheet says when the store holds no such object for this workspace. */
export function NotHere({ what }: { what: string }) {
  return <p className="mt-6 text-[12.5px] leading-relaxed" style={{ color: "var(--sol-text-muted)" }} data-sheet-missing title={`This ${what} may belong to another team, or it was removed`}>Not in this workspace.</p>;
}

/** A role's line in a Now. `onOpen` names the role (its face and name open
 *  its sheet), for a sheet that is not the role's own. Nothing when the role
 *  has nothing live. */
export function RoleNowLine({ role, onOpen }: { role: OrgRole; onOpen?: () => void }) {
  const now = roleNow(role);
  if (!now) return null;
  return (
    <NowLine data={{ "data-role-now": role.short_id }}>
      <NowBar sessions={role.sessions} />
      {onOpen && (
        <button type="button" onClick={onOpen} className="inline-flex shrink-0 items-center gap-2 hover:underline underline-offset-2" style={{ color: "var(--sol-text)" }} data-role-now-open>
          <RoleFace role={role} size={16} className="shrink-0" />
          {role.name}
        </button>
      )}
      {onOpen && <span aria-hidden className="-mx-1" style={{ color: "var(--sol-text-dim)" }}>·</span>}
      <span className="min-w-0 truncate" data-role-now-words>{now.words}</span>
      {now.current && (
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 pl-1">
          <span style={{ color: "var(--sol-text-dim)" }}>{now.current.state === "working" ? "on" : "waiting in"}</span>
          <EntityIdPill id={now.current._id} shortId={now.current.short_id} type="session" compact />
        </span>
      )}
    </NowLine>
  );
}
