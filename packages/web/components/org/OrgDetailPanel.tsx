"use client";
// What the Org screen's one panel holds (essence spec §5): a goal, project
// or person sheet; a role, which is its head above its conversation; a
// conversation (`?session=`); or a proposal, which opens in the thread it was
// posted in, scrolled to its card (§3.2). Never two panels. Sheets draw their
// own bar (SheetFrame); a conversation and a proposal get the same bar here:
// the crumb, and the close with its Esc.
import { useMemo, type ReactNode } from "react";
import { X } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { CenteredNote } from "../anchor/AnchorConversation";
import { EntityObjectCard } from "../EntityObjectCard";
import { ReviewComposerContext, type ReviewComposer } from "../reviewContext";
import { OrgConversation, OrgPreviewProposal } from "./OrgConversation";
import { RolePausedNote } from "./RolePausedNote";
import { ORG_BAND, ORG_RULE } from "./orgFrame";
import { proposalPanelOf } from "./orgScreenModel";
import { roleWords, type OrgProposalRow } from "./orgStaffingTypes";
import type { OrgRole, OrgTree } from "./orgTypes";
import { findRole } from "./company/objects";
import { SHEETS } from "./company/sheetRegistry";
import { sheetId } from "./company/sheetStack";
import { panelKey, type PanelRef } from "./panelTarget";

/** A `?proposal=` the screen does not hold: where it is, or that it cannot be read. */
export type LinkLineState =
  | { kind: "foreign"; shortId: string; workspaceName: string; teamId: string | null }
  | { kind: "unreadable" | "loading"; shortId: string };

export type OrgDetailPanelProps = {
  panel: PanelRef;
  tree: OrgTree | null;
  /** Every proposal the screen holds, this workspace's and the linked one. */
  proposals: readonly OrgProposalRow[];
  /** The `?proposal=` this workspace does not hold, said in the bar. */
  linkLine: LinkLineState | null;
  onSwitchWorkspace: (teamId: string | null) => void;
  /** The panel fills a narrow screen: the bar leads with "← Org". */
  fills: boolean;
  onClose: () => void;
  onResumeRole: (roleId: string) => void;
  /** The Head of People's conversation: a proposal with no thread of its own answers into its batch. */
  headConversationId: string | null;
  /** The dev preview: fixture proposals, answered into a batch nothing sends. */
  preview: null | { onSend: (proposalId: string) => void };
};

export function OrgDetailPanel(props: OrgDetailPanelProps) {
  const { panel } = props;
  const key = panel.kind === "session" || panel.kind === "proposal" ? panelKey(panel)! : sheetId(panel);
  return (
    // Switching objects crossfades; the width moves only on open and close (company.css).
    <div key={key} className="org-panel-swap flex h-full min-h-0 flex-col" style={{ background: "var(--sol-bg)" }} role="complementary" data-org-panel={panelKey(panel) ?? ""}>
      {panel.kind === "session" ? <SessionPanel {...props} panel={panel} />
        : panel.kind === "proposal" ? <ProposalPanel {...props} panel={panel} />
        : panel.kind === "role" ? <RolePanel {...props} sheet={panel} />
        : <ObjectSheet sheet={panel} />}
    </div>
  );
}

function ObjectSheet({ sheet }: { sheet: Extract<PanelRef, { ref: string }> }) {
  const Sheet = SHEETS[sheet.kind];
  return <Sheet sheet={sheet} />;
}

/** A role: its head above its conversation (§7), one panel. */
function RolePanel({ sheet, tree, onResumeRole }: OrgDetailPanelProps & { sheet: Extract<PanelRef, { ref: string }> }) {
  const role = findRole(tree, sheet.ref) ?? null;
  const conv = role?.standing?.conversation_id ? String(role.standing.conversation_id) : null;
  const Head = SHEETS.role;
  return (
    <>
      <div className="max-h-[55%] shrink-0 overflow-y-auto border-b" style={{ borderColor: ORG_RULE }} data-org-role-head>
        <Head sheet={sheet} />
      </div>
      {role?.status === "paused" && <RolePausedNote name={role.name} onResume={() => onResumeRole(role._id)} className="mx-4 mt-2" />}
      <div className="min-h-0 flex-1" data-org-role-conversation={conv ?? ""}>
        {conv ? <OrgConversation conversationId={conv} name={roleWords(role!).title} />
          : role ? <CenteredNote>{roleWords(role).title} has not started yet. Its conversation appears here when it does.</CenteredNote>
          : <CenteredNote>Loading…</CenteredNote>}
      </div>
    </>
  );
}

/** The role whose standing conversation this is, for its name. */
const roleOfConversation = (tree: OrgTree | null, id: string): OrgRole | null => tree?.roles.find((r) => String(r.standing?.conversation_id ?? "") === id) ?? null;

/** A conversation opened from the screen: named by its role, else by its title. */
function SessionPanel({ panel, tree, fills, onClose }: OrgDetailPanelProps & { panel: Extract<PanelRef, { kind: "session" }> }) {
  const role = roleOfConversation(tree, panel.id);
  const title = useInboxStore((s) => {
    const row = (s.sessions[panel.id] ?? s.conversations[panel.id]) as { title?: string } | undefined;
    return row?.title?.trim() || null;
  });
  const name = role ? roleWords(role).title : title;
  return (
    <>
      <PanelBar title={name ?? "Conversation"} fills={fills} onClose={onClose} />
      <div className="min-h-0 flex-1"><OrgConversation conversationId={panel.id} name={role ? name : null} decision={panel.decision ?? null} /></div>
    </>
  );
}

/** A proposal: its thread, scrolled to its card; the card alone when a person posted it. */
function ProposalPanel({ panel, tree, proposals, linkLine, onSwitchWorkspace, fills, onClose, headConversationId, preview }: OrgDetailPanelProps & { panel: Extract<PanelRef, { kind: "proposal" }> }) {
  const row = proposals.find((p) => p.short_id.toLowerCase() === panel.id.toLowerCase()) ?? null;
  const where = row ? proposalPanelOf(row, tree) : null;
  const author = row?.author.kind === "role" ? findRole(tree, row.author.short_id ?? row.author.handle ?? row.author.id) ?? null : null;
  const name = where?.kind === "thread" ? (roleOfConversation(tree, where.conversationId) ?? author) : null;
  const composer = useMemo<ReviewComposer | null>(() => (headConversationId ? { quote() {}, submit() {}, conversationId: headConversationId, canSend: true } : null), [headConversationId]);
  const line = linkLine ?? (row ? null : { kind: "loading" as const, shortId: panel.id });
  let body: ReactNode;
  if (line) body = null;
  else if (preview && row) body = <OrgPreviewProposal proposal={row} author={author?.name ?? row.author.name ?? "Head of People"} onSend={preview.onSend} />;
  else if (where?.kind === "thread") body = <OrgConversation conversationId={where.conversationId} name={name ? roleWords(name).title : row!.author.name ?? null} proposal={{ shortId: row!.short_id, createdAt: row!.created_at, seq: panel.seq }} />;
  else {
    const card = <EntityObjectCard refId={row!.short_id} count={1} />;
    body = <div className="h-full overflow-y-auto px-[22px] py-4" data-org-proposal-card={row!.short_id}>{composer ? <ReviewComposerContext.Provider value={composer}>{card}</ReviewComposerContext.Provider> : card}</div>;
  }
  return (
    <>
      <PanelBar title={row?.title ?? "Proposal"} fills={fills} onClose={onClose}>
        {line && <LinkLine line={line} onSwitchWorkspace={onSwitchWorkspace} />}
      </PanelBar>
      <div className="min-h-0 flex-1" data-org-proposal-panel={row?.short_id ?? panel.id}>{body}</div>
    </>
  );
}

/** The bar a conversation and a proposal share with every sheet: the crumb
 *  ("Org › …", "← Org" when the panel fills a narrow screen), anything the
 *  panel needs to say, and the close. */
export function PanelBar({ title, fills, onClose, children }: { title: string; fills: boolean; onClose: () => void; children?: ReactNode }) {
  return (
    <div className={`flex shrink-0 items-center gap-2 border-b px-[22px] text-[12px] ${ORG_BAND}`} style={{ borderColor: ORG_RULE, color: "var(--sol-text-muted)" }} data-org-panel-bar>
      <nav className="flex min-w-0 shrink items-center gap-[5px] overflow-hidden whitespace-nowrap" aria-label="Where it sits" data-org-panel-crumb>
        <button type="button" onClick={onClose} className="shrink-0 hover:text-[var(--sol-text)]" data-org-panel-crumb-org>{fills ? "← Org" : "Org"}</button>
        <span aria-hidden style={{ color: "var(--sol-text-dim)" }}>›</span>
        <span className="min-w-0 truncate" style={{ color: "var(--sol-text)" }} data-org-panel-title>{title}</span>
      </nav>
      {children}
      <span className="ml-auto inline-flex shrink-0 items-center" style={{ color: "var(--sol-text-dim)" }}>
        <TooltipProvider delayDuration={400}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={onClose} className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-sol-bg-highlight/70" aria-label="Close" data-org-panel-close>
                <X className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="flex items-center gap-1.5">Close <KeyCap size="xs">Esc</KeyCap></TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </span>
    </div>
  );
}

/** A proposal the screen does not hold: in another workspace (with the way
 *  there), not one this person can read, or still being looked for. */
export function LinkLine({ line, onSwitchWorkspace }: { line: LinkLineState; onSwitchWorkspace: (teamId: string | null) => void }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-[12px]" style={{ color: "var(--sol-text-secondary)" }} data-org-link-line={line.kind}>
      {line.kind === "foreign" && (
        <>
          <span className="min-w-0 truncate">This proposal is in {line.workspaceName}.</span>
          <button type="button" onClick={() => onSwitchWorkspace(line.teamId)} className="shrink-0 font-medium hover:underline underline-offset-2" style={{ color: "var(--sol-violet)" }} data-org-link-switch>Switch</button>
        </>
      )}
      {line.kind === "unreadable" && <span className="min-w-0 truncate">This is not a proposal you can read.</span>}
      {line.kind === "loading" && <span className="min-w-0 truncate" style={{ color: "var(--sol-text-dim)" }}>Looking for it…</span>}
    </span>
  );
}
