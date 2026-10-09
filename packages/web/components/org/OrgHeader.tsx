"use client";
// The Org screen's one header row (essence spec §4.1, §4.3): "Org", New (the
// one place to create a goal, a project or a role) and a menu with History,
// Review the org now and Reset org. History is the screen's own dialog (it is
// also opened by `?panel=history`), and the reset lives at its foot.
import { useState } from "react";
import { Ellipsis } from "lucide-react";
import type { OrgObjectKind } from "@codecast/shared/entities";
import { cn } from "../../lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { HireRoleDialog } from "./HireRoleDialog";
import { NewMenu } from "./company/NewMenu";
import { ORG_RULE } from "./orgFrame";
import type { OrgHealth } from "./orgStaffingTypes";
import type { OrgTree } from "./orgTypes";

export type OrgHeaderProps = {
  tree: OrgTree | null;
  isAdmin: boolean;
  /** Hiring is the agents half (D11): off where the org feature is off. */
  canHire?: boolean;
  /** The viewer, for the hire dialog's reports-to default. */
  meId: string;
  onCreateRole: React.ComponentProps<typeof HireRoleDialog>["onCreate"];
  onHistory: () => void;
  /** A fresh session reviews the org once and posts a proposal. Absent: no item. */
  onReview?: () => void;
  /** Start over (admins). Opens History, where the reset asks what it would change. */
  onReset?: () => void;
  /** Open an object in the panel; `focus` opens a new one's name for typing. */
  onOpen?: (kind: OrgObjectKind, ref: string, focus?: boolean) => void;
  /** Left in place, unread (essence spec §2). */
  health?: OrgHealth | null;
};

const CONTROL = "h-[30px] inline-flex items-center gap-1.5 px-2 rounded-lg text-[12px] transition-colors";

export function OrgHeader({ tree, isAdmin, canHire = true, meId, onCreateRole, onHistory, onReview, onReset, onOpen }: OrgHeaderProps) {
  const [addRole, setAddRole] = useState(false);
  const hire = isAdmin && canHire && !!tree;
  return (
    <>
      <div className={"shrink-0 h-[46px] border-b flex items-center gap-2 min-w-0 px-[22px]"} style={{ borderColor: ORG_RULE, background: "var(--sol-bg)" }} data-org-header>
        <h1 className="shrink-0 font-mono text-[13px] font-semibold" style={{ color: "var(--sol-text)" }} data-org-title>Org</h1>
        <span className="flex-1" />
        <div className="flex items-center gap-1.5 shrink-0">
          {onOpen && <NewMenu onCreated={(kind, ref, focus) => onOpen(kind, ref, focus)} onRole={() => setAddRole(true)} canRole={hire} />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="More" title="More" className={cn(CONTROL, "w-[30px] px-0 justify-center hover:bg-sol-bg-highlight/60")} style={{ color: "var(--sol-text-muted)" }} data-org-more>
                <Ellipsis className="w-4 h-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[200px]">
              <DropdownMenuItem onSelect={onHistory} data-org-history-open>History</DropdownMenuItem>
              {onReview && <DropdownMenuItem onSelect={onReview} data-org-review-now>Review the org now</DropdownMenuItem>}
              {onReset && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={onReset} className="text-[var(--sol-red)] focus:text-[var(--sol-red)]" data-org-reset-open>Reset org…</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {hire && addRole && (
        <HireRoleDialog
          key={meId}
          open
          initialMode="manual"
          title="New role"
          onClose={() => setAddRole(false)}
          tree={tree}
          meId={meId}
          onCreate={(input) => { onCreateRole(input); setAddRole(false); }}
        />
      )}
    </>
  );
}
