"use client";
// The org screen's one header row (docs/architecture/org-staffing.md S41):
// the name, the mission, and three controls: Health, Add a role, and a menu
// with History, Words and the gallery. The screen and the health page both
// mount it, so the hire dialog and the glossary it opens live here; History
// is the screen's own (it is also opened by `?panel=history`).
import { useState } from "react";
import Link from "next/link";
import { Ellipsis, Network, Plus } from "lucide-react";
import { cn } from "../../lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { HireRoleDialog } from "./HireRoleDialog";
import { OrgGlossary, type GlossaryPage } from "./OrgGlossary";
import type { OrgHealth, OrgProposalRow } from "./orgStaffingTypes";
import type { OrgTree } from "./orgTypes";

export const ORG_HEADER_BORDER = "color-mix(in srgb, var(--sol-border) 22%, transparent)";

export type OrgHeaderProps = {
  tree: OrgTree | null;
  /** The top goal, when the goals form one tree (orgScreenModel.missionOf). */
  mission: { title: string; shortId: string } | null;
  isAdmin: boolean;
  healthOn: boolean;
  phone: boolean;
  /** The viewer, for the hire dialog's reports-to default. */
  meId: string;
  onCreateRole: React.ComponentProps<typeof HireRoleDialog>["onCreate"];
  onHistory: () => void;
  /** For the glossary's live examples; the screen has no health read of its own. */
  health?: OrgHealth | null;
  proposal?: Pick<OrgProposalRow, "short_id" | "changes" | "counts"> | null;
};

const CONTROL = "h-[30px] inline-flex items-center gap-1.5 px-2.5 rounded-lg border text-[12.5px] font-medium transition-colors no-underline";

export function OrgHeader({ tree, mission, isAdmin, healthOn, phone, meId, onCreateRole, onHistory, health = null, proposal = null }: OrgHeaderProps) {
  // "Add a role" writes one; the gallery's item opens on the templates (org-hire.md H3).
  const [addRoleOpen, setAddRoleOpen] = useState<false | "manual" | "template">(false);
  const [glossary, setGlossary] = useState<GlossaryPage | null>(null);
  const workspace = tree ? tree.workspace.name || (tree.workspace.kind === "user" ? "personal" : "team") : null;
  const addRole = isAdmin && tree ? (
    <button type="button" onClick={() => setAddRoleOpen("manual")} title="A role that sessions and other roles report to, with an area of projects and plans to look after" className={cn(CONTROL, "border-transparent font-semibold hover:brightness-110")} style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }} data-org-add-role>
      <Plus className="w-3.5 h-3.5" /> Add a role
    </button>
  ) : null;
  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 pt-3 pb-2.5 border-b flex items-center justify-between gap-3" style={{ borderColor: ORG_HEADER_BORDER }} data-org-header>
        <div className="min-w-0">
          <h1 className="text-[22px] leading-none font-semibold tracking-tight flex items-center gap-2" style={{ fontFamily: "var(--font-serif)" }}>
            <Network className="w-5 h-5" style={{ color: "var(--sol-violet)" }} strokeWidth={1.75} />
            Org
            {workspace && <span className="text-[12.5px] font-normal mt-1 truncate" style={{ color: "var(--sol-text-dim)", fontFamily: "var(--font-mono)" }}>/ {workspace}</span>}
          </h1>
          {mission && (
            <p className="mt-1.5 text-[12.5px] truncate flex items-center gap-2">
              <Link href={`/goals/${mission.shortId}`} className="min-w-0 truncate no-underline hover:underline underline-offset-2" style={{ color: "var(--sol-text-secondary)" }} data-org-mission>
                <span style={{ color: "var(--sol-text-dim)" }}>the mission </span>{mission.title}
              </Link>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href="/org?view=health"
            aria-pressed={healthOn}
            title="How work flows through the company, and what is waiting on you"
            className={cn(CONTROL, healthOn ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-highlight/60")}
            style={{ borderColor: healthOn ? "color-mix(in srgb, var(--sol-violet) 45%, transparent)" : "color-mix(in srgb, var(--sol-border) 30%, transparent)", color: healthOn ? "var(--sol-text)" : "var(--sol-text-muted)" }}
            data-org-health-link
          >
            Health
          </Link>
          {!phone && addRole}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="More" title="History, the words this page uses, and the gallery" className={cn(CONTROL, "w-[30px] px-0 justify-center hover:bg-sol-bg-highlight/60")} style={{ borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)", color: "var(--sol-text-muted)" }} data-org-more>
                <Ellipsis className="w-4 h-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[200px]">
              <DropdownMenuItem onSelect={onHistory} data-org-history-open>History</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setGlossary("words")} data-org-glossary-open>Words</DropdownMenuItem>
              {isAdmin && tree && <DropdownMenuItem onSelect={() => setAddRoleOpen("template")} data-org-hire-gallery>Hire from the gallery</DropdownMenuItem>}
              {isAdmin && tree && phone && <DropdownMenuItem onSelect={() => setAddRoleOpen("manual")} data-org-add-role>Add a role</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {tree && addRoleOpen && (
        <HireRoleDialog
          key={`${meId}:${addRoleOpen}`}
          open
          initialMode={addRoleOpen}
          title={addRoleOpen === "template" ? "Hire a role" : "Add a role"}
          onClose={() => setAddRoleOpen(false)}
          tree={tree}
          meId={meId}
          onCreate={(input) => { onCreateRole(input); setAddRoleOpen(false); }}
        />
      )}
      <OrgGlossary open={glossary} onClose={() => setGlossary(null)} tree={tree} health={health} proposal={proposal} />
    </>
  );
}
