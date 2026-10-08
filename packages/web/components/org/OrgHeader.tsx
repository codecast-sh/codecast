"use client";
// The org screen's one header row (docs/architecture/org-staffing.md S41,
// cohesive build spec §4.1, D1, D9): the workspace's name and the mission it
// exists for, which opens the mission goal's sheet; New, the one place to
// create a goal, a project or a role; and a menu with History, Words, This
// week and the gallery. A stacked screen draws its Conversation | Company
// switch in this row too, so it adds no bar of its own. The hire dialog and
// the glossary it opens live here;
// History is the screen's own (it is also opened by `?panel=history`).
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Ellipsis } from "lucide-react";
import { objectHref, type OrgObjectKind } from "@codecast/shared/entities";
import { cn } from "../../lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { HireRoleDialog } from "./HireRoleDialog";
import { OrgGlossary, type GlossaryPage } from "./OrgGlossary";
import { isPlainClick } from "./company/orgOpenContext";
import { NewMenu } from "./company/NewMenu";
import { ORG_GUTTER, ORG_RULE } from "./orgFrame";
import { orgScreenPath } from "./orgScreenModel";
import type { OrgHealth, OrgProposalRow } from "./orgStaffingTypes";
import type { OrgTree } from "./orgTypes";

/** This week (D12): the People map with each role's week on it. */
const THIS_WEEK_HREF = orgScreenPath({ lens: "people", week: true });

export type OrgHeaderProps = {
  tree: OrgTree | null;
  /** The workspace's name when the tree has not named it yet. */
  workspaceName?: string | null;
  /** The top goal, when the goals form one tree (orgScreenModel.missionOf). */
  mission: { title: string; shortId: string } | null;
  /** With no mission among the goals: the one an open proposal would set (orgScreenModel.proposedMissionOf). */
  proposedMission?: { title: string; proposal: string; seq: number } | null;
  /** Scroll the conversation to a proposal's card (D8). */
  onProposal?: (shortId: string, seq?: number) => void;
  isAdmin: boolean;
  /** Hiring is the agents half (D11): off where the org feature is off. */
  canHire?: boolean;
  phone: boolean;
  /** The viewer, for the hire dialog's reports-to default. */
  meId: string;
  onCreateRole: React.ComponentProps<typeof HireRoleDialog>["onCreate"];
  onHistory: () => void;
  /** Open an object's sheet in the screen; `focus` opens a new one's name for typing. Absent, links navigate. */
  onOpen?: (kind: OrgObjectKind, ref: string, focus?: boolean) => void;
  /** For the glossary's live examples; the screen has no health read of its own. */
  health?: OrgHealth | null;
  proposal?: Pick<OrgProposalRow, "short_id" | "changes" | "counts"> | null;
  /** The stacked screen's Conversation | Company switch, drawn in this row before New. */
  switcher?: ReactNode;
};

const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

const CONTROL = "h-[28px] inline-flex items-center gap-1.5 px-2 rounded-md text-[12px] transition-colors no-underline";

export function OrgHeader({ tree, workspaceName, mission, proposedMission = null, onProposal, isAdmin, canHire = true, meId, onCreateRole, onHistory, onOpen, health = null, proposal = null, switcher = null }: OrgHeaderProps) {
  // New ▸ Role writes one; the gallery's item opens on the templates (org-hire.md H3).
  const [addRoleOpen, setAddRoleOpen] = useState<false | "manual" | "template">(false);
  const [glossary, setGlossary] = useState<GlossaryPage | null>(null);
  const workspace = tree?.workspace.name || workspaceName || (tree ? (tree.workspace.kind === "user" ? "Personal" : "Team") : null);
  const hire = isAdmin && canHire && !!tree;
  return (
    <>
      <div className={cn("shrink-0 h-[46px] border-b flex items-center gap-3 min-w-0", ORG_GUTTER)} style={{ borderColor: ORG_RULE }} data-org-header>
        <h1 className="shrink-0 text-[13.5px] font-semibold truncate max-w-[40%]" style={{ color: "var(--sol-text)" }} data-org-workspace>{workspace ?? "Org"}</h1>
        {mission && (
          <p className="min-w-0 flex-1 truncate text-[13px]" style={{ color: "var(--sol-text-muted)" }}>
            <span className="hidden sm:inline">exists to </span>
            <Link
              href={objectHref("initiative", mission.shortId)}
              onClick={(e) => { if (!onOpen || !isPlainClick(e)) return; e.preventDefault(); onOpen("initiative", mission.shortId); }}
              className="no-underline hover:text-[var(--sol-text)]"
              style={{ color: "var(--sol-text-secondary)", borderBottom: "1px dotted var(--sol-text-dim)" }}
              title="The mission: the goal every other goal serves"
              data-org-mission
            >{lowerFirst(mission.title)}</Link>
          </p>
        )}
        {!mission && proposedMission && (
          <p className="min-w-0 flex-1 truncate text-[13px]" style={{ color: "var(--sol-text-muted)" }}>
            <span aria-hidden className="pr-1.5" style={{ color: "var(--sol-text-dim)" }}>·</span>proposed mission:{" "}
            <Link
              href={`/org?proposal=${encodeURIComponent(proposedMission.proposal)}&focus=${proposedMission.seq}`}
              onClick={(e) => { if (!onProposal || !isPlainClick(e)) return; e.preventDefault(); onProposal(proposedMission.proposal, proposedMission.seq); }}
              className="no-underline hover:underline underline-offset-[3px]"
              style={{ color: "var(--sol-violet)" }}
              title={`${proposedMission.proposal}: answer it in the conversation`}
              data-org-mission-proposed={proposedMission.proposal}
            >{proposedMission.title}</Link>
          </p>
        )}
        <span className="flex-1" />
        <div className="flex items-center gap-1.5 shrink-0">
          {switcher}
          {onOpen && <NewMenu onCreated={(kind, ref, focus) => onOpen(kind, ref, focus)} onRole={() => setAddRoleOpen("manual")} canRole={hire} />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="More" title="More" className={cn(CONTROL, "w-[28px] px-0 justify-center hover:bg-sol-bg-highlight/60")} style={{ color: "var(--sol-text-muted)" }} data-org-more>
                <Ellipsis className="w-4 h-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[200px]">
              <DropdownMenuItem onSelect={onHistory} data-org-history-open>History</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setGlossary("words")} data-org-glossary-open>Words</DropdownMenuItem>
              <DropdownMenuItem asChild data-org-this-week><Link href={THIS_WEEK_HREF} className="no-underline">This week</Link></DropdownMenuItem>
              {hire && <DropdownMenuItem onSelect={() => setAddRoleOpen("template")} data-org-hire-gallery>Hire from the gallery</DropdownMenuItem>}
              {hire && !onOpen && <DropdownMenuItem onSelect={() => setAddRoleOpen("manual")} data-org-add-role>Add a role</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {hire && addRoleOpen && (
        <HireRoleDialog
          key={`${meId}:${addRoleOpen}`}
          open
          initialMode={addRoleOpen}
          title={addRoleOpen === "template" ? "Hire a role" : "New role"}
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
