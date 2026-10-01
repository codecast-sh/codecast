import { asksProgressLine, asksLoading } from "./staffingAsks";
"use client";
// The staffing pane (docs/architecture/org-staffing.md S5): the "Staffing"
// mode of the org page's right sheet. With a proposal open it is the asks
// column (S19): one line of header, one card per ask with its changes folded
// inside, one line of cost; the conversation with the author is the page's
// own column beside it. With no proposal it is the health summary and the
// composer to the head of people. With no head of people it is two buttons.
// Everything it shows arrives through props from the store (OrgPage owns the
// reads and the actions); it computes nothing beyond what staffingModel.ts
// hands it.
import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, ChevronDown, ChevronRight, CornerDownRight, ExternalLink, MessageSquareText, Pause, Pencil, Play, RefreshCw, Send, Sparkles, Undo2, UserRoundPlus, X } from "lucide-react";
import { agoOf } from "../../lib/threadState";
import { cn } from "../../lib/utils";
import { AnchorConversation } from "../anchor/AnchorConversation";
import { OrgButton } from "./OrgButton";
import { amendedMoves, revisedLine, revisionWord } from "./staffingRevise";
import { isOrgGoalChange, isOrgQuietChange, latestOrgRevisionAt, recordChangeParts, type OrgChange, type OrgGoalChange, type OrgVerdictSeen } from "@codecast/shared/contracts/orgProposal";
import { RoleFace } from "./RoleFace";
import { AssigneeFace } from "../identity/AssigneeFace";
import type { TakeoverPreview } from "../../hooks/useTakeoverPreviews";
import { TakeoverEdit } from "./TakeoverEdit";
import { askNames, askOfChange, asksProgress, proposalAsks, type AskView } from "./staffingAsks";
import { SectionLabel } from "./OrgScopePanel";
import { rolePausedSentence, SEVERITY_META } from "./orgMeta";
import type { QueueItem } from "../../lib/decisionQueue";
import type { AreaCheck } from "@codecast/shared/contracts/orgAreas";
import { QuietLines, StatusPill } from "./ghostChrome";
export { StatusPill };
import type { OrgRole, OrgTree } from "./orgTypes";
import type { OrgChangeStatus, OrgHealth, OrgProposalChange, OrgProposalRow } from "./orgStaffingTypes";
import {
  CHANGE_STATUS_META,
  CHECK_CADENCES,
  areaRows,
  cadenceLabel,
  changeEdits,
  changeFields,
  changeLine,
  changeTenure,
  isDecidable,
  isSyncChange,
  openProposals,
  staffingMode,
  syncEvidence,
  syncGroupSummary,
  tenureLine,
  type AreaRow,
  type ChangeField,
} from "./staffingModel";

export type StaffingPaneProps = {
  tree: OrgTree | null;
  health: OrgHealth | null;
  /** org.health is not deployed on this backend yet. */
  healthMissing?: boolean;
  /** The latest health read failed (a refusal, a read limit): its message. A
   *  failed read must never paint as "no flags". */
  healthError?: string;
  onRetryHealth?: () => void;
  proposals: OrgProposalRow[];
  /** The proposal open in the pane; null = the health summary. */
  proposal: OrgProposalRow | null;
  /** The change the chart is focused on (the `orgFocusChangeId` scalar). */
  selectedChangeId: string | null;
  head: OrgRole | null;
  /** "Propose an org now" is running and no proposal has landed yet. */
  reviewing: boolean;
  /** The review session finished its turn, or was closed, and posted no
   *  proposal: the pane says so, keeps the way in, and gives the buttons back. */
  reviewEnded?: boolean;
  /** The session "Propose an org now" started, while it is reviewing or after it ended. */
  reviewSessionId?: string | null;
  now: number;
  onSelectChange: (changeId: string | null) => void;
  /** A verdict carries what the page showed when it was pressed (`seen`,
   *  S18): the latest revise among the rows it painted and, for an ask, the
   *  seqs the card held. The server reads the verdict against that and
   *  refuses one the author revised under the reader; the page then shows
   *  the revised list, marked, instead of applying anything. */
  onDecide: (changeId: string, verdict: "accept" | "skip", edits: Record<string, unknown> | undefined, seen: OrgVerdictSeen) => void;
  /** Accept or skip one ask whole (S19): every change in it that still waits.
   *  `opts.leave_sessions` is the person's one edit on the accept (R1). */
  onDecideAsk: (proposalId: string, askIndex: number, verdict: "accept" | "skip", seen: OrgVerdictSeen, opts?: { leave_sessions?: boolean }) => void;
  /** What accepting each change would take over, by change id (R1): only the
   *  rows that would move a session have an entry. The page reads them in one
   *  query (useTakeoverPreviews) and the pane says them before the accept. */
  takeovers?: Record<string, TakeoverPreview>;
  /** Edit on a role change opens the hire dialog prefilled (the page owns it). */
  onEditRole: (change: OrgProposalChange) => void;
  onSelectNode: (nodeId: string) => void;
  onOpenSession: (conversationId: string) => void;
  onPickProposal: (shortId: string) => void;
  /** Withdraw an open proposal: the replaced one, from its own line (S4). */
  onWithdraw?: (proposalId: string) => void;
  onHireHeadOfPeople: () => void;
  onProposeNow: () => void;
  /** Resume a paused head of people (its wakes are held while paused). */
  onResumeHeadOfPeople?: (roleId: string) => void;
  /** The page renders the proposal's conversation (ProposalThread, S19) in
   *  its own column. False = the proposal has no thread (a person posted
   *  it): the pane falls back to the head of people's composer. */
  hasThread?: boolean;
  /** Set when the proposal is the page (S19, a desktop): the page's one line
   *  header names the proposal and counts the decisions (OrgPage), so the
   *  column is cards from its first pixel. Three asks with their Accept and
   *  Skip must share the first screen with the letter, and the column's own
   *  header row cost the third ask its buttons at 1440 by 900 (org eval
   *  round 12). Unset, the pane carries its own header: the phone's sheet
   *  and the asks tab beside a selected node. */
  titleInPageHeader?: boolean;
  /** A row's "Ask about this": select the change and bring the composer to it. */
  onAskAbout?: (change: OrgProposalChange) => void;
  /** A card's "Ask about this": the next message is about that ask. */
  onAskAboutAsk?: (ask: AskView) => void;
  /** Changes the author revised since the reader last looked
   *  (staffingRevise.revisedSince): the card that holds them says so, each
   *  row is marked, and `onSeen` clears both. */
  revised?: { rows: OrgProposalChange[]; who: string; onSeen: () => void };
  /** The loop (org-staffing.md S29). The person's open decisions, as the
   *  decision queue holds them; the pane keeps the ones the org routed. */
  queue?: QueueItem[];
  /** Answer a `cast decide` card in place, by option index. */
  onAnswerDecision?: (decisionId: string, index: number) => void;
  /** Pause, resume or run a role's check or the company review, in place. */
  onTrigger?: (taskId: string, verb: "pause" | "resume" | "runNow") => void;
  /** Change a check's cadence in place. */
  onSetTriggerEvery?: (taskId: string, intervalMs: number) => void;
  /** "Ask @role": a line into the role's standing session. */
  onSendToRole?: (conversationId: string, text: string) => void;
  /** A `?proposal=op-N` link that does not resolve in the active workspace
   *  (staffingModel.resolveProposalLink): the pane is that one line, with a
   *  switch when the proposal lives in a workspace the viewer can open. The
   *  active workspace's own body would answer a question nobody asked. */
  link?: ProposalLinkLine;
  /** The health page (HealthBoard), where the sheet sends a person with no proposal open. */
  onOpenHealth?: () => void;
};

export type ProposalLinkLine =
  | { kind: "foreign"; shortId: string; workspaceName: string; onSwitch: () => void }
  | { kind: "unreadable"; shortId: string }
  | { kind: "loading"; shortId: string };

const BORDER = "color-mix(in srgb, var(--sol-border) 30%, transparent)";

export function StaffingPane(props: StaffingPaneProps) {
  const mode = staffingMode(props.tree, props.proposal);
  if (props.link) {
    return (
      <div className="flex flex-col min-h-0" data-staffing-mode="link">
        <LinkLine link={props.link} />
      </div>
    );
  }
  return (
    <div className="flex flex-col min-h-0" data-staffing-mode={mode}>
      {mode === "proposal" && props.proposal && <ProposalBody {...props} proposal={props.proposal} />}
      {mode === "health" && <HealthBody {...props} />}
      {mode === "no_head_of_people" && <NoHeadBody {...props} />}
      {/* S19: a proposal's conversation is the page's own column. The head of
          people's composer stays for the health summary and for a proposal no
          agent wrote. */}
      {mode === "proposal" && !props.hasThread && <Composer head={props.head} onOpenSession={props.onOpenSession} onResume={props.onResumeHeadOfPeople} />}
    </div>
  );
}

// ---------------------------------------------------------------- a link into another workspace

function LinkLine({ link }: { link: ProposalLinkLine }) {
  const tone = link.kind === "unreadable" ? "var(--sol-orange)" : "var(--sol-violet)";
  return (
    <div className="mb-4 rounded-lg border px-3 py-2 flex items-center gap-2 text-[12px]" data-proposal-link={link.kind} style={{ borderColor: `color-mix(in srgb, ${tone} 40%, transparent)`, background: `color-mix(in srgb, ${tone} 7%, transparent)`, color: "var(--sol-text-secondary)" }}>
      <span className="font-medium" style={{ color: tone, fontFamily: "var(--font-mono)" }}>{link.shortId}</span>
      {link.kind === "foreign" && (
        <>
          <span className="min-w-0 flex-1 truncate">belongs to {link.workspaceName}</span>
          <OrgButton primary size="sm" onClick={link.onSwitch}>Switch</OrgButton>
        </>
      )}
      {link.kind === "unreadable" && <span className="min-w-0 flex-1">is not a proposal you can read. It may be withdrawn, or in a workspace you are not a member of.</span>}
      {link.kind === "loading" && <span className="min-w-0 flex-1" style={{ color: "var(--sol-text-dim)" }}>looking it up…</span>}
    </div>
  );
}

function ProposalBody(props: StaffingPaneProps & { proposal: OrgProposalRow }) {
  const { proposal, tree, now, selectedChangeId } = props;
  const asks = useMemo(() => proposalAsks(proposal, askNames(tree)), [proposal.asks, proposal.changes, tree]); // eslint-disable-line react-hooks/exhaustive-deps
  const progress = asksProgress(asks);
  const loading = asksLoading(proposal);
  const others = openProposals(props.proposals).filter((p) => p._id !== proposal._id);
  // One fold open at a time. A change focused from the chart opens the card
  // that holds it; closing that card lets go of the change.
  const focusedAsk = askOfChange(asks, selectedChangeId)?.index ?? null;
  const [opened, setOpened] = useState<{ proposalId: string; index: number } | null>(null);
  const openIndex = focusedAsk ?? (opened?.proposalId === proposal._id ? opened.index : null);
  const toggleFold = (i: number) => {
    if (selectedChangeId) props.onSelectChange(null);
    setOpened(openIndex === i ? null : { proposalId: proposal._id, index: i });
  };
  const revisedIds = useMemo(() => new Set(props.revised?.rows.map((r) => r._id) ?? []), [props.revised?.rows]);
  // What this render read: the verdicts it sends say so (onDecide, onDecideAsk).
  const revisedAt = latestOrgRevisionAt(proposal.changes);
  return (
    <>
      {!props.titleInPageHeader && (
        <div className="flex items-baseline gap-3" data-asks-header>
          <h2 className="min-w-0 flex-1 text-[17px] leading-snug font-semibold tracking-tight" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}>{proposal.title}</h2>
          <span className="shrink-0 text-[12px] tabular-nums" style={{ color: progress.remaining === 0 && !loading ? "var(--sol-green)" : "var(--sol-text-muted)" }} data-progress>
            {asksProgressLine(progress, loading)}
          </span>
        </div>
      )}
      {/* supersession (S4): only when it applies, with Withdraw right there */}
      {proposal.superseded_by && (
        <div className="mt-2 rounded-lg border px-3 py-2 flex items-center gap-2 text-[12px]" data-superseded-by={proposal.superseded_by.short_id} style={{ borderColor: "color-mix(in srgb, var(--sol-orange) 45%, transparent)", background: "color-mix(in srgb, var(--sol-orange) 8%, transparent)", color: "var(--sol-text-secondary)" }}>
          <Undo2 className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--sol-orange)" }} />
          <span className="min-w-0 flex-1">
            A newer proposal replaced this one {agoOf(now - proposal.superseded_by.created_at)}{proposal.superseded_by.status !== "open" ? ` (${proposal.superseded_by.status})` : ""}. <button type="button" onClick={() => props.onPickProposal(proposal.superseded_by!.short_id)} className="font-medium hover:underline" style={{ color: "var(--sol-violet)" }}>Open it</button>
          </span>
          {proposal.status === "open" && props.onWithdraw && (
            <OrgButton size="sm" onClick={() => props.onWithdraw!(proposal._id)} data-withdraw>Withdraw</OrgButton>
          )}
        </div>
      )}
      {proposal.supersedes && (
        <div className="mt-1 flex items-center gap-1 text-[11.5px]" data-supersedes={proposal.supersedes.short_id} style={{ color: "var(--sol-text-muted)" }}>
          <ArrowRight className="w-3 h-3" style={{ color: "var(--sol-text-dim)" }} />
          Replaces <button type="button" onClick={() => props.onPickProposal(proposal.supersedes!.short_id)} className="font-medium hover:underline" style={{ color: "var(--sol-violet)" }}>an earlier proposal</button>{proposal.supersedes.status !== "open" ? <span style={{ color: "var(--sol-text-dim)" }}> · {proposal.supersedes.status}</span> : null}
        </div>
      )}

      <div className={cn("flex flex-col gap-2", !props.titleInPageHeader && "mt-2.5")} data-asks>
        {loading && <p className="text-[12.5px]" style={{ color: "var(--sol-text-dim)" }} data-changes-loading>Loading the proposal…</p>}
        {!loading && asks.length === 0 && <p className="text-[12.5px]" style={{ color: "var(--sol-text-dim)" }}>This proposal changes nothing.</p>}
        {asks.map((ask) => (
          <AskCard
            key={ask.index}
            ask={ask}
            number={ask.index + 1}
            tree={tree}
            open={openIndex === ask.index}
            onToggle={() => toggleFold(ask.index)}
            selectedChangeId={selectedChangeId}
            revisedIds={revisedIds}
            revised={props.revised}
            takeovers={props.takeovers}
            onDecideAsk={(verdict, opts) => props.onDecideAsk(proposal._id, ask.index, verdict, { revised_at: revisedAt, seqs: ask.changes.map((c) => c.seq) }, opts)}
            onAskAboutAsk={props.onAskAboutAsk ? () => props.onAskAboutAsk!(ask) : undefined}
            onAskAboutChange={props.onAskAbout}
            onSelectChange={props.onSelectChange}
            onDecide={(changeId, verdict, edits) => props.onDecide(changeId, verdict, edits, { revised_at: revisedAt })}
            onEditRole={props.onEditRole}
          />
        ))}
      </div>


      {others.length > 0 && (
        <div className="mt-5 pt-3 border-t flex flex-col gap-1" style={{ borderColor: BORDER }} data-other-proposals>
          <span className="text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>{others.length === 1 ? "One more proposal is open" : `${others.length} more proposals are open`}</span>
          {others.map((p) => (
            <button key={p._id} type="button" onClick={() => props.onPickProposal(p.short_id)} className="text-left text-[12.5px] px-1 py-0.5 rounded-md hover:bg-sol-bg-highlight/60 truncate" style={{ color: "var(--sol-violet)" }}>{p.title}</button>
          ))}
        </div>
      )}
    </>
  );
}

/** How many rows a fold shows before "Show all": a records ask runs past a
 *  hundred, and the person who opened it is looking for one row. */
const FOLD_PAGE = 25;

/**
 * One ask (S19): a title a person can read cold, one sentence of why, one
 * line of what accepting changes, and Accept, Skip, Ask about this. The
 * changes are inside, folded, with the count on the fold; open, they are the
 * same rows and per row controls the pane always had, and a single skipped
 * row inside an accepted ask is the exception the fold is for. A decided ask
 * keeps its title and says its verdict; Accept and Skip go, the question stays.
 */
function AskCard({ ask, number, tree, open, onToggle, selectedChangeId, revisedIds, revised, takeovers, onDecideAsk, onAskAboutAsk, onAskAboutChange, onSelectChange, onDecide, onEditRole }: {
  ask: AskView; number: number; tree: OrgTree | null; open: boolean; onToggle: () => void;
  selectedChangeId: string | null;
  revisedIds: Set<string>;
  revised?: StaffingPaneProps["revised"];
  takeovers?: Record<string, TakeoverPreview>;
  onDecideAsk: (verdict: "accept" | "skip", opts?: { leave_sessions?: boolean }) => void;
  onAskAboutAsk?: () => void;
  onAskAboutChange?: (c: OrgProposalChange) => void;
  onSelectChange: (id: string | null) => void;
  onDecide: (changeId: string, verdict: "accept" | "skip", edits?: Record<string, unknown>) => void;
  onEditRole: (c: OrgProposalChange) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  // What accepting this ask whole would take over (R1): the sentence of each
  // change in it that still waits and would move a session, and the one edit.
  const [leave, setLeave] = useState(false);
  const moving = ask.changes.filter((c) => isDecidable(c.status) && takeovers?.[c._id]);
  const decided = ask.state !== "open";
  const tone = ask.state === "accepted" ? "var(--sol-green)" : ask.state === "skipped" ? "var(--sol-text-dim)" : "var(--sol-violet)";
  // A plan change that closes its tasks carries them under its own row (S9).
  const sync = useMemo(() => ask.changes.some((c) => isSyncChange(c.change)) ? syncGroupSummary(ask.changes) : null, [ask.changes]);
  // A quiet kind (a limit, S23.2) is never a row: the ask still carries it,
  // so the ask's verdict decides it with the rest.
  const rows = useMemo(() => {
    const drawn = ask.changes.filter((c) => !isOrgQuietChange(c.change));
    if (!sync) return drawn;
    const nested = new Set(Object.values(sync.nested).flat().map((c) => c._id));
    return drawn.filter((c) => !nested.has(c._id));
  }, [ask.changes, sync]);
  const revisedHere = revised ? revised.rows.filter((r) => ask.changes.some((c) => c._id === r._id)) : [];
  const selectedAt = rows.findIndex((c) => c._id === selectedChangeId);
  const shown = all || selectedAt >= FOLD_PAGE ? rows : rows.slice(0, FOLD_PAGE);
  const edit = (c: OrgProposalChange) => {
    if (c.change.kind === "role") onEditRole(c);
    else { onSelectChange(c._id); setEditing(c._id); }
  };
  return (
    <section className={cn("rounded-xl border transition-colors", decided && "opacity-80")} data-ask={ask.index} data-ask-state={ask.state} style={{ borderColor: decided ? BORDER : "color-mix(in srgb, var(--sol-violet) 32%, transparent)", background: decided ? "transparent" : "var(--sol-card)" }}>
      <div className="flex items-start gap-3 px-3.5 pt-2 pb-2">
        <span className="shrink-0 w-6 h-6 mt-[1px] inline-flex items-center justify-center rounded-full text-[12px] font-semibold tabular-nums" aria-hidden style={{ background: `color-mix(in srgb, ${tone} 16%, transparent)`, color: tone }}>
          {ask.state === "accepted" ? <Check className="w-3.5 h-3.5" /> : ask.state === "skipped" ? <X className="w-3.5 h-3.5" /> : number}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className={cn("text-[14.5px] leading-snug font-semibold", ask.state === "skipped" && "line-through")} style={{ color: "var(--sol-text)" }} data-ask-title>{ask.title}</h3>
          {ask.verdictLine && (
            <p className="mt-0.5 text-[12px] flex items-center gap-2" style={{ color: ask.failed > 0 ? CHANGE_STATUS_META.failed.color : tone }}>
              <span data-ask-verdict>{ask.verdictLine}</span>
              {decided && onAskAboutAsk && <button type="button" onClick={onAskAboutAsk} className="inline-flex items-center gap-1 hover:underline underline-offset-2" style={{ color: "var(--sol-violet)" }} data-ask-about>Ask about this</button>}
            </p>
          )}
          {!decided && (
            <>
              <p className="mt-0.5 text-[12.5px] leading-normal" style={{ color: "var(--sol-text-secondary)" }} data-ask-why>{ask.why}</p>
              <p className="mt-0.5 text-[12.5px] leading-normal" style={{ color: "var(--sol-text)" }} data-ask-effect>
                <span style={{ color: "var(--sol-text-dim)" }}>If you accept: </span>{ask.effect}
              </p>
              {moving.length > 0 && (
                <TakeoverEdit className="mt-2" phrase={moving.map((c) => takeovers![c._id].phrase).join(". ")} leave={leave} onLeave={setLeave} />
              )}
              <div className="mt-1.5 flex items-center gap-1.5 flex-wrap" data-ask-controls>
                <OrgButton primary size="sm" onClick={() => onDecideAsk("accept", leave && moving.length > 0 ? { leave_sessions: true } : undefined)} data-ask-accept>Accept</OrgButton>
                <OrgButton size="sm" onClick={() => onDecideAsk("skip")} data-ask-skip>Skip</OrgButton>
                {onAskAboutAsk && (
                  <button type="button" onClick={onAskAboutAsk} className="ml-auto inline-flex items-center gap-1 h-7 px-1.5 rounded-md text-[12px] font-medium hover:bg-sol-bg-highlight/70" style={{ color: "var(--sol-violet)" }} data-ask-about>
                    <MessageSquareText className="w-3.5 h-3.5" /> Ask about this
                  </button>
                )}
              </div>
            </>
          )}
          {revisedHere.length > 0 && revised && (
            <p className="mt-2 text-[12px] leading-snug org-pop-in" style={{ color: "var(--sol-text-secondary)" }} data-ask-revised={revisedHere.length}>
              <Sparkles className="inline w-3 h-3 mr-1 align-[-1px]" style={{ color: "var(--sol-violet)" }} />
              {revisedLine(revisedHere, revised.who)} <button type="button" onClick={revised.onSeen} className="font-medium hover:underline" style={{ color: "var(--sol-violet)" }} data-revised-seen>Got it</button>
            </p>
          )}
        </div>
      </div>
      <button type="button" onClick={onToggle} aria-expanded={open} className="w-full flex items-center gap-1.5 px-3.5 h-6 border-t text-[12px] rounded-b-xl hover:bg-sol-bg-highlight/50" style={{ borderColor: BORDER, color: "var(--sol-text-muted)" }} data-ask-fold>
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <span className="tabular-nums">{ask.foldLabel}</span>
      </button>
      {open && (
        <div className="px-1.5 pb-2 flex flex-col gap-1" data-ask-rows>
          {rows.length === 0 && <QuietLines tree={tree} changes={ask.changes} className="px-2 py-1" />}
          {shown.map((c) => (
            <ChangeRow
              key={c._id}
              change={c}
              tree={tree}
              nested={sync?.nested[c._id]}
              selected={c._id === selectedChangeId}
              revisedNew={revisedIds.has(c._id)}
              takeover={takeovers?.[c._id]}
              onAsk={onAskAboutChange ? () => onAskAboutChange(c) : undefined}
              editing={editing === c._id}
              onPick={() => onSelectChange(c._id === selectedChangeId ? null : c._id)}
              onAccept={() => onDecide(c._id, "accept")}
              onSkip={() => onDecide(c._id, "skip")}
              onEdit={() => edit(c)}
              onCancelEdit={() => setEditing(null)}
              onAcceptWithEdits={(edits) => { setEditing(null); onDecide(c._id, "accept", edits); }}
            />
          ))}
          {shown.length < rows.length && (
            <button type="button" onClick={() => setAll(true)} className="self-start text-[12px] px-2 h-7 rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-violet)" }} data-ask-show-all>Show all {rows.length}</button>
          )}
        </div>
      )}
    </section>
  );
}


function Fact({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="mt-1.5 text-[12px] leading-snug">
      <span className="uppercase tracking-[0.08em] text-[10px] mr-1.5" style={{ color: tone ?? "var(--sol-text-dim)" }}>{k}</span>
      <span style={{ color: "var(--sol-text-secondary)" }}>{v}</span>
    </div>
  );
}


/**
 * A change's line as the row shows it. A record change that carries its
 * record's title (S9) reads "Mark done: <title>" with the id as a pill, so a
 * person learns what the record is without opening it; every other change,
 * and a record change without a title, is `changeLine` as one string. The
 * words are the contract's (recordChangeParts): the tooltip, the log and the
 * chart's chips say the same line.
 */
export function ChangeLineText({ change }: { change: OrgChange }) {
  const parts = recordChangeParts(change);
  if (!parts?.title) return <>{changeLine(change)}</>;
  const act = parts.act.charAt(0).toUpperCase() + parts.act.slice(1);
  return (
    <span data-record-line={parts.ref}>
      <span style={{ color: "var(--sol-text-muted)" }}>{act}: </span>
      <span className="font-medium" data-record-title>{parts.title}</span>
      <span className="inline-flex items-center h-[16px] px-1 ml-1.5 rounded text-[10px] align-[1px] tabular-nums" style={{ background: "color-mix(in srgb, var(--sol-border) 35%, transparent)", color: "var(--sol-text-dim)", fontFamily: "var(--font-mono)" }} data-record-ref>{parts.ref}</span>
    </span>
  );
}

/**
 * One change. Unselected: status pill, the line on up to two rows (the pane
 * is 380px wide; one truncated row hid the role, the owner or the number the
 * line exists to say), the icon trio when it is still decidable, and on a
 * failed row the reason under the line.
 * Selected: the full line, then the rationale, expected effect, risk, note
 * and evidence inline with worded Accept, Edit and Skip, so one change is
 * decided without leaving its row (the phone sheet shows the list several
 * screens tall).
 */
function ChangeRow({ change, tree, nested, selected, editing, revisedNew, takeover, onAsk, onPick, onAccept: acceptAsProposed, onSkip, onEdit, onCancelEdit, onAcceptWithEdits: acceptWithEdits }: {
  change: OrgProposalChange; tree: OrgTree | null; selected: boolean; editing: boolean;
  /** What accepting this row would take over (R1); absent when nothing moves. */
  takeover?: TakeoverPreview;
  /** Task changes this plan change closes along with the plan (S9): shown
   *  under the row, applied by the plan's own accept. */
  nested?: OrgProposalChange[];
  /** The author revised this row since the reader last looked (S18). */
  revisedNew?: boolean;
  /** "Ask about this": the conversation's next message names this row. */
  onAsk?: () => void;
  onPick: () => void; onAccept: () => void; onSkip: () => void; onEdit: () => void; onCancelEdit: () => void; onAcceptWithEdits: (edits: Record<string, unknown>) => void;
}) {
  const open = isDecidable(change.status);
  const failed = change.status === "failed";
  const removed = change.status === "removed";
  // The person's one edit on this row (R1) rides whichever accept they press.
  const [leave, setLeave] = useState(false);
  const left = leave && !!takeover ? { leave_sessions: true } : null;
  const onAccept = () => (left ? acceptWithEdits(left) : acceptAsProposed());
  const onAcceptWithEdits = (edits: Record<string, unknown>) => acceptWithEdits({ ...edits, ...left });
  // S10: a role change says whether the seat is standing or a program with
  // its end. S9: a record change says what the evidence is, on the row itself.
  const tenure = tenureLine(changeTenure(change), tree);
  const evidence = syncEvidence(change.change);
  return (
    <div className={cn("rounded-lg border transition-colors", selected ? "bg-sol-bg-highlight/70" : "hover:bg-sol-bg-highlight/40", revisedNew && "org-pop-in")} style={{ borderColor: selected ? "color-mix(in srgb, var(--sol-violet) 45%, transparent)" : "transparent", ...(revisedNew ? { boxShadow: "inset 3px 0 0 var(--sol-violet)", background: "color-mix(in srgb, var(--sol-violet) 6%, transparent)" } : {}) }} data-change-row={change._id} data-change-status={change.status} data-revised={change.revision?.kind} data-revised-new={revisedNew || undefined}>
      <div className="flex items-start gap-2 px-2 py-1.5">
        <button type="button" onClick={onPick} className="flex-1 min-w-0 flex items-start gap-2 text-left" aria-pressed={selected} aria-expanded={selected}>
          {/* Inside an open fold every row waits by default; the pill speaks only when a row has moved. */}
          {change.status !== "proposed" && <StatusPill status={change.status} />}
          <span className="min-w-0 flex-1">
            <span className={cn("block text-[12.5px] leading-snug", selected ? "break-words" : "line-clamp-2", (change.status === "skipped" || removed) && "line-through opacity-60")} style={{ color: "var(--sol-text)" }} title={changeLine(change.change)}>
              {change.revision?.kind === "added" && <span className="inline-flex items-center h-[15px] px-1 mr-1.5 rounded text-[9.5px] font-semibold uppercase tracking-[0.06em] align-[1px] no-underline" style={{ background: "color-mix(in srgb, var(--sol-violet) 16%, transparent)", color: "var(--sol-violet)" }} data-revised-tag>new</span>}
              <ChangeLineText change={change.change} />
            </span>
            {change.revision && <RevisionNote change={change} selected={selected} />}
            {change.depends && <span className="block text-[11px] leading-snug" style={{ color: "var(--sol-text-dim)" }} data-change-depends>{change.depends}</span>}
            {tenure && <TenureChip line={tenure} />}
            {isOrgGoalChange(change.change) && <GoalChangeDetails change={change.change} tree={tree} />}
            {evidence && (
              <span className={cn("block text-[11px] leading-snug mt-0.5", selected ? "break-words" : "line-clamp-2")} style={{ color: "var(--sol-text-muted)" }} data-sync-evidence title={evidence}>
                <span className="uppercase tracking-[0.08em] text-[9.5px] mr-1" style={{ color: "var(--sol-green)" }}>evidence</span>{evidence}
              </span>
            )}
            {nested && nested.length > 0 && (
              <span className="block mt-1" data-nested-tasks={nested.length}>
                <span className="block text-[10.5px] uppercase tracking-[0.08em]" style={{ color: "var(--sol-green)" }}>closes {nested.length} {nested.length === 1 ? "task" : "tasks"} with it</span>
                {(selected ? nested : nested.slice(0, 3)).map((t) => (
                  <span key={t._id} className="flex items-start gap-1 text-[11px] leading-snug mt-0.5" style={{ color: "var(--sol-text-muted)" }} data-nested-task={t._id}>
                    <CornerDownRight className="w-3 h-3 shrink-0 mt-[1px]" style={{ color: "var(--sol-text-dim)" }} />
                    <span className={cn("min-w-0 flex-1", selected ? "break-words" : "truncate")} title={changeLine(t.change)}><ChangeLineText change={t.change} /></span>
                  </span>
                ))}
                {!selected && nested.length > 3 && <span className="block text-[10.5px] mt-0.5 pl-4" style={{ color: "var(--sol-text-dim)" }}>and {nested.length - 3} more</span>}
              </span>
            )}
            {failed && !selected && change.applied_note && (
              <span className="block truncate text-[11px] leading-snug mt-0.5" style={{ color: CHANGE_STATUS_META.failed.color }} data-failed-note>{change.applied_note}</span>
            )}
          </span>
        </button>
        {open && !selected && (
          <span className="flex items-center gap-0.5 shrink-0">
            <IconButton label="Accept" tone="var(--sol-cyan)" onClick={onAccept}><Check className="w-3.5 h-3.5" /></IconButton>
            <IconButton label="Edit" onClick={onEdit}><Pencil className="w-3.5 h-3.5" /></IconButton>
            <IconButton label="Skip" onClick={onSkip}><X className="w-3.5 h-3.5" /></IconButton>
          </span>
        )}
      </div>
      {open && takeover && <TakeoverEdit className="mx-2 mb-1.5" phrase={takeover.phrase} leave={leave} onLeave={setLeave} />}
      {selected && (
        <div className="mx-2 mb-2 rounded-lg border p-2.5 org-pop-in" data-rationale style={{ borderColor: BORDER, background: "var(--sol-card)" }}>
          <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--sol-text-secondary)" }}>{change.rationale}</p>
          {change.expected_effect && <Fact k="expected" v={change.expected_effect} />}
          {change.risk && <Fact k="risk" v={change.risk} tone="var(--sol-orange)" />}
          {change.applied_note && <Fact k={failed ? "failed" : "applied"} v={change.applied_note} tone={failed ? CHANGE_STATUS_META.failed.color : "var(--sol-green)"} />}
          {change.evidence.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {change.evidence.map((e, i) => e.href ? (
                <Link key={i} href={e.href} className="inline-flex items-center gap-1 h-[22px] px-2 rounded-md text-[11px] font-medium hover:underline" style={{ background: "color-mix(in srgb, var(--sol-blue) 12%, transparent)", color: "var(--sol-blue)" }}>
                  {e.label} <ExternalLink className="w-3 h-3" />
                </Link>
              ) : (
                <span key={i} className="inline-flex items-center h-[22px] px-2 rounded-md text-[11px]" style={{ background: "color-mix(in srgb, var(--sol-border) 30%, transparent)", color: "var(--sol-text-muted)" }}>{e.label}</span>
              ))}
            </div>
          )}
          {open && !editing && (
            <div className="mt-2.5 flex items-center gap-1.5 flex-wrap" data-verdicts>
              <OrgButton primary size="sm" onClick={onAccept} aria-label="Accept"><Check className="w-3 h-3" /> {failed ? "Retry" : "Accept"}</OrgButton>
              <OrgButton size="sm" onClick={onEdit} aria-label="Edit"><Pencil className="w-3 h-3" /> Edit</OrgButton>
              <OrgButton size="sm" onClick={onSkip} aria-label="Skip"><X className="w-3 h-3" /> Skip</OrgButton>
              {onAsk && <OrgButton size="sm" onClick={onAsk} aria-label="Ask about this" className="ml-auto" data-ask-about><MessageSquareText className="w-3 h-3" /> Ask about this</OrgButton>}
            </div>
          )}
          {!open && onAsk && !removed && (
            <div className="mt-2.5 flex items-center" data-verdicts>
              <OrgButton size="sm" onClick={onAsk} aria-label="Ask about this" data-ask-about><MessageSquareText className="w-3 h-3" /> Ask about this</OrgButton>
            </div>
          )}
        </div>
      )}
      {editing && open && <EditChangeForm change={change} onCancel={onCancelEdit} onAccept={onAcceptWithEdits} />}
    </div>
  );
}

/** What the author's revise did to this row (S18), under its line: the word,
 *  the author's note, and on an amend what moved, field by field. */
function RevisionNote({ change, selected }: { change: OrgProposalChange; selected: boolean }) {
  const r = change.revision!;
  const moves = amendedMoves(change);
  const tone = r.kind === "removed" ? "var(--sol-text-dim)" : "var(--sol-violet)";
  return (
    <span className="block mt-0.5 text-[11px] leading-snug" style={{ color: "var(--sol-text-muted)" }} data-revision={r.kind}>
      <span className="uppercase tracking-[0.08em] text-[9.5px] mr-1 font-semibold" style={{ color: tone }}>{revisionWord(r)}</span>
      <span className={cn(selected ? "break-words" : "line-clamp-2")} title={r.note}>{r.note}</span>
      {moves.length > 0 && (
        <span className="block mt-0.5" data-revision-moves>
          {moves.map((m) => (
            <span key={m.key} className="block">
              <span style={{ color: "var(--sol-text-dim)" }}>{m.label}: </span>
              {m.from !== null && <>was {m.from}, </>}
              now <span className="font-medium" style={{ color: "var(--sol-text)" }}>{m.to ?? "nothing"}</span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * What a goal change carries, under its line (initiatives-projects-role-page.md
 * "I1, revised"): the projects as chips, named from the chart where it knows
 * them, and the owner as a role's face or a person's face, resolved from the
 * chart's roles and people. A ref the chart does not know stands as written,
 * so the row still says what the author meant.
 */
export function GoalChangeDetails({ change, tree }: { change: OrgGoalChange; tree: OrgTree | null }) {
  const projectName = (ref: string) => {
    for (const r of tree?.roles ?? []) for (const p of r.scope_names.projects) if (p.id === ref || p.short_id === ref || p.title === ref) return p.title;
    return ref;
  };
  const owner = change.kind === "initiative_projects" ? undefined : change.owner;
  const role = owner?.startsWith("@") ? tree?.roles.find((r) => r.handle.toLowerCase() === owner.slice(1).toLowerCase()) ?? null : null;
  const person = owner && !role ? tree?.people.find((p) => (owner.toLowerCase() === "me" ? p.is_me : p.name.toLowerCase() === owner.toLowerCase())) ?? null : null;
  const projects = change.kind === "initiative_owner" ? [] : change.projects;
  return (
    <span className="flex flex-wrap items-center gap-1 mt-1" data-goal-details>
      {projects.map((ref) => (
        <span key={ref} className="inline-flex items-center h-[16px] px-1.5 rounded text-[10px] font-medium" style={{ background: "color-mix(in srgb, var(--sol-border) 35%, transparent)", color: "var(--sol-text-muted)" }} data-goal-project={ref}>{projectName(ref)}</span>
      ))}
      {owner && (
        <span className="inline-flex items-center gap-1 h-[16px] text-[10.5px]" style={{ color: "var(--sol-text-secondary)" }} data-goal-owner={role ? `role:${role.handle}` : person ? `person:${person.name}` : `ref:${owner}`}>
          {role ? <RoleFace role={role} size={14} /> : person ? <AssigneeFace info={{ name: person.name, image: person.image }} size={14} hover={false} /> : null}
          <span>{role ? role.name : person ? (person.is_me ? "you" : person.name) : owner}</span>
        </span>
      )}
    </span>
  );
}

/** "standing" or "program · ends with pl-3, then retire" (S10), as a chip on
 *  a role change; the same words the node chip and the hire form use. */
export function TenureChip({ line }: { line: string }) {
  const program = line.startsWith("program");
  const tone = program ? "var(--sol-orange)" : "var(--sol-blue)";
  return (
    <span className="inline-flex items-center gap-1 max-w-full mt-1 h-[16px] px-1.5 rounded text-[10px] font-medium" style={{ background: `color-mix(in srgb, ${tone} 12%, transparent)`, color: tone }} data-tenure={program ? "program" : "standing"} title={line}>
      <span className="truncate">{line}</span>
    </span>
  );
}

function IconButton({ label, tone, onClick, children }: { label: string; tone?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="w-6 h-6 inline-flex items-center justify-center rounded-md hover:bg-sol-bg-highlight" style={{ color: tone ?? "var(--sol-text-dim)" }}>
      {children}
    </button>
  );
}

/** Edit for every kind but a role: one input per field, accept with edits.
 *  The canvas floats the same form next to a ghost's Edit (OrgGraph). */
export function EditChangeForm({ change, onCancel, onAccept }: { change: OrgProposalChange; onCancel: () => void; onAccept: (edits: Record<string, unknown>) => void }) {
  const [fields, setFields] = useState<ChangeField[]>(() => changeFields(change.change));
  const edits = changeEdits(change.change, fields);
  const dirty = Object.keys(edits).length > 0;
  return (
    <form className="px-2 pb-2 flex flex-col gap-1.5" data-edit-form onSubmit={(e) => { e.preventDefault(); onAccept(edits); }}>
      {fields.map((f, i) => (
        <label key={f.key} className="grid grid-cols-[110px_1fr] items-center gap-2 text-[11px]">
          <span className="truncate" style={{ color: "var(--sol-text-dim)" }} title={f.key}>{f.label}</span>
          {f.kind === "select" && f.options ? (
            <select
              value={f.value}
              onChange={(e) => setFields((fs) => fs.map((x, j) => j === i ? { ...x, value: e.target.value } : x))}
              className="h-7 rounded-md px-1.5 border outline-none text-[12px] bg-sol-bg-alt"
              style={{ borderColor: BORDER, color: "var(--sol-text)" }}
              data-edit-select={f.key}
            >
              {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input
              value={f.value}
              type={f.kind === "number" ? "number" : "text"}
              onChange={(e) => setFields((fs) => fs.map((x, j) => j === i ? { ...x, value: e.target.value } : x))}
              className="h-7 rounded-md px-2 border outline-none text-[12px] bg-sol-bg-alt"
              style={{ borderColor: BORDER, color: "var(--sol-text)" }}
            />
          )}
        </label>
      ))}
      <div className="flex items-center justify-end gap-1.5 mt-1">
        <button type="button" onClick={onCancel} className="h-7 px-2.5 rounded-md text-[12px]" style={{ color: "var(--sol-text-muted)" }}>Cancel</button>
        <OrgButton primary size="sm" type="submit">{dirty ? "Accept with edits" : "Accept as proposed"}</OrgButton>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- the loop (S29)

/** What the health read could not do: a server without it, a failed read
 *  with nothing cached, or a stale copy. Never painted as a clean company. */
export function HealthNote({ missing, error, hasHealth, onRetry }: { missing?: boolean; error?: string; hasHealth: boolean; onRetry?: () => void }) {
  const retry = onRetry ? <button type="button" onClick={onRetry} className="ml-1.5 underline underline-offset-2" style={{ color: "var(--sol-blue)" }}>Retry</button> : null;
  if (missing) return <p className="mt-2 text-[12px] px-1" style={{ color: "var(--sol-text-dim)" }}>This server does not read the company's health yet.</p>;
  if (error && !hasHealth) return <p className="mt-2 text-[12px] px-1" style={{ color: "var(--sol-red)" }} data-health-error>Health could not be read: {error}{retry}</p>;
  if (error) return <p className="mt-2 text-[11px] px-1" style={{ color: "var(--sol-yellow)" }} data-health-stale>Showing the last copy; the latest read failed: {error}{retry}</p>;
  return null;
}

const ago = (now: number, at: number | null | undefined): string => (at ? agoOf(now - at) : "");

// ---- areas

function StatusWord({ row }: { row: AreaRow }) {
  return <span className="shrink-0 text-[11px] font-medium" style={{ color: row.color }} data-area-status={row.status}>{row.statusWord}</span>;
}

/** The role's check (or the company review) as a person controls it: when
 *  it last looked, when it looks next, pause and run now, and the cadence. */
export function CheckLine({ check, checkedAt, now, word, onTrigger, onSetEvery }: { check: AreaCheck | null; checkedAt: number | null; now: number; word: "check" | "review"; onTrigger?: (id: string, verb: "pause" | "resume" | "runNow") => void; onSetEvery?: (id: string, ms: number) => void }) {
  const paused = check?.status === "paused";
  const live = !!check && (check.status === "scheduled" || check.status === "running" || paused);
  const last = checkedAt ?? check?.last_run_at ?? null;
  const cadences = check?.interval_ms && !CHECK_CADENCES.some((c) => c.ms === check.interval_ms) ? [{ ms: check.interval_ms, label: cadenceLabel(check.interval_ms) }, ...CHECK_CADENCES] : CHECK_CADENCES;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]" data-area-check={check?.status ?? "none"} style={{ color: "var(--sol-text-muted)" }}>
      <span>{last ? `Last ${word} ${ago(now, last)}` : `No ${word} yet`}</span>
      {live && !paused && check.run_at && <span style={{ color: "var(--sol-text-dim)" }}>· next {check.run_at > now ? `in ${agoOf(check.run_at - now).replace(/ ago$/, "")}` : "any moment"}</span>}
      {paused && <span style={{ color: "var(--sol-yellow)" }}>· paused</span>}
      {!live && check && <span style={{ color: "var(--sol-text-dim)" }}>· {check.status}</span>}
      {live && onSetEvery && (
        <select value={check.interval_ms ?? ""} onChange={(e) => onSetEvery(check.trigger_id, Number(e.target.value))} className="h-5 rounded border bg-transparent px-1 text-[11px] outline-none" style={{ borderColor: BORDER, color: "var(--sol-text-secondary)" }} aria-label={`How often it ${word === "check" ? "checks" : "reviews"}`} data-area-cadence>
          {cadences.map((c) => <option key={c.ms} value={c.ms}>{c.label}</option>)}
        </select>
      )}
      {live && onTrigger && (
        <span className="ml-auto inline-flex items-center gap-0.5">
          <IconButton label={paused ? "Resume" : "Pause"} onClick={() => onTrigger(check.trigger_id, paused ? "resume" : "pause")}>{paused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}</IconButton>
          {!paused && <IconButton label={word === "check" ? "Check now" : "Review now"} tone="var(--sol-violet)" onClick={() => onTrigger(check.trigger_id, "runNow")}><RefreshCw className="w-3 h-3" /></IconButton>}
        </span>
      )}
      {check?.short_id && <Link href={`/triggers/${check.short_id}`} className="text-[10.5px] hover:underline" style={{ color: "var(--sol-text-dim)" }} data-area-check-link>change</Link>}
    </div>
  );
}

/** "Ask @growth": one line into the role's own thread; the answer lands there. */
export function AskRole({ role, conversationId, onSend, onOpenSession }: { role: OrgRole; conversationId: string | null; onSend?: (conversationId: string, text: string) => void; onOpenSession: (id: string) => void }) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  if (!conversationId) return <p className="text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>It has no session yet, so there is nobody to ask.</p>;
  const submit = () => {
    const body = text.trim();
    if (!body || !onSend) return;
    onSend(conversationId, body);
    setText("");
    setSent(true);
  };
  return (
    <form className="flex flex-col gap-1" data-ask-role={role.handle} onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="flex items-center gap-1.5">
        <input value={text} onChange={(e) => { setText(e.target.value); setSent(false); }} placeholder={`Ask @${role.handle}…`} className="min-w-0 flex-1 h-7 rounded-md px-2 border outline-none text-[12px] bg-sol-bg-alt" style={{ borderColor: BORDER, color: "var(--sol-text)" }} aria-label={`Ask @${role.handle}`} />
        <OrgButton size="sm" primary type="submit" disabled={!text.trim() || !onSend} aria-label="Send"><Send className="w-3 h-3" /></OrgButton>
      </div>
      {sent && (
        <span className="text-[11px]" style={{ color: "var(--sol-text-dim)" }} data-ask-role-sent>
          Sent. Its answer lands in <button type="button" onClick={() => onOpenSession(conversationId)} className="hover:underline" style={{ color: "var(--sol-violet)" }}>its thread</button>.
        </span>
      )}
    </form>
  );
}

const DETAIL_LABEL = "text-[10px] font-semibold uppercase tracking-[0.08em]";

/** A row opened: the area's goals and progress, the sessions waiting under
 *  it, at most three signals, its check, and a line to the role. */
export function AreaDetail({ row, now, onOpenSession, onSelectNode, onTrigger, onSetEvery, onSend }: { row: AreaRow; now: number; onOpenSession: (id: string) => void; onSelectNode: (nodeId: string) => void; onTrigger?: (id: string, verb: "pause" | "resume" | "runNow") => void; onSetEvery?: (id: string, ms: number) => void; onSend?: (conversationId: string, text: string) => void }) {
  const a = row.area;
  const conv = a?.standing_conversation_id ?? row.role.standing?.conversation_id ?? null;
  const goals = a?.goals ?? [];
  const scopeProjects = row.role.scope_names.projects;
  return (
    <div className="px-2.5 pb-2.5 pt-1 flex flex-col gap-2.5 org-pop-in" data-area-detail={row.role.handle}>
      {a && row.status !== "on_track" && <p className="text-[12px] leading-snug" style={{ color: row.color }} data-area-status-line>{a.status_line}</p>}

      <div data-area-goals>
        <div className={DETAIL_LABEL} style={{ color: "var(--sol-text-dim)" }}>Goals</div>
        {goals.length === 0 && scopeProjects.length === 0 && <p className="text-[12px] mt-0.5" style={{ color: "var(--sol-text-dim)" }}>{row.role.handle === "head-of-people" ? "Everything no other role looks after." : "No area of its own: it runs its check and answers what it is asked."}</p>}
        {goals.length === 0 && scopeProjects.length > 0 && <p className="text-[12px] mt-0.5" style={{ color: "var(--sol-text-secondary)" }}>{scopeProjects.map((p) => p.title).join(", ")}</p>}
        {goals.map((g) => (
          <div key={g.project.id} className="mt-0.5 text-[12px] leading-snug" data-area-goal={g.project.id}>
            <Link href={`/projects/${g.project.short_id ?? g.project.id}`} className="font-medium no-underline hover:underline" style={{ color: "var(--sol-text)" }}>{g.project.title}</Link>
            {g.goal && <span style={{ color: "var(--sol-text-secondary)" }}>: {g.goal}</span>}
            <span className="block text-[11px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{g.done_7d} done this week · {g.in_progress} in progress · {g.open} open</span>
          </div>
        ))}
      </div>

      {a && a.waiting.length > 0 && (
        <div data-area-waiting={a.waiting.length}>
          <div className={DETAIL_LABEL} style={{ color: "var(--sol-text-dim)" }}>Waiting under it</div>
          {a.waiting.map((w) => (
            <button key={w.id} type="button" onClick={() => onOpenSession(w.id)} className="mt-0.5 w-full text-left rounded-md px-1 -mx-1 py-0.5 hover:bg-sol-bg-highlight/70" data-area-waiting-session={w.short_id}>
              <span className="block text-[12px] leading-snug truncate" style={{ color: "var(--sol-text)" }}>{w.title || w.short_id}</span>
              <span className="block text-[11px] truncate" style={{ color: "var(--sol-text-dim)" }}>{w.why === "blocked" ? "blocked" : "waiting"} for {agoOf(now - w.since).replace(/ ago$/, "")}{w.state ? ` · ${w.state}` : ""}</span>
            </button>
          ))}
        </div>
      )}

      {a && a.signals.length > 0 && (
        <div data-area-signals={a.signals.length}>
          <div className={DETAIL_LABEL} style={{ color: "var(--sol-text-dim)" }}>Signals</div>
          {a.signals.map((sg, i) => {
            const m = SEVERITY_META[sg.severity];
            return (
              <p key={i} className="mt-0.5 flex items-start gap-1.5 text-[12px] leading-snug" style={{ color: "var(--sol-text-secondary)" }} data-area-signal={sg.code}>
                <span className="w-1.5 h-1.5 rounded-full shrink-0 mt-[6px]" aria-hidden style={m.dot === "none" ? { border: `1px solid ${m.color}` } : m.dot === "filled" ? { background: m.color } : { border: `1.5px solid ${m.color}` }} />
                <span>{sg.text}</span>
              </p>
            );
          })}
        </div>
      )}

      <div>
        <div className={DETAIL_LABEL} style={{ color: "var(--sol-text-dim)" }}>Check</div>
        <div className="mt-0.5"><CheckLine check={a?.check ?? null} checkedAt={a?.checked_at ?? null} now={now} word="check" onTrigger={onTrigger} onSetEvery={onSetEvery} /></div>
      </div>

      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1"><AskRole role={row.role} conversationId={conv} onSend={onSend} onOpenSession={onOpenSession} /></div>
        <button type="button" onClick={() => onSelectNode(row.nodeId)} className="shrink-0 text-[11px] h-7 px-1.5 rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-dim)" }} data-area-open-node>On the chart</button>
      </div>
    </div>
  );
}

function Areas({ rows, now, open, onToggle, onOpenSession, onSelectNode, onTrigger, onSetEvery, onSend }: { rows: AreaRow[]; now: number; open: string | null; onToggle: (roleId: string) => void; onOpenSession: (id: string) => void; onSelectNode: (nodeId: string) => void; onTrigger?: (id: string, verb: "pause" | "resume" | "runNow") => void; onSetEvery?: (id: string, ms: number) => void; onSend?: (conversationId: string, text: string) => void }) {
  return (
    <>
      <SectionLabel right={<span className="text-[10.5px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{rows.length}</span>}>Areas</SectionLabel>
      {rows.length === 0 && <p className="text-[12.5px] px-1" style={{ color: "var(--sol-text-dim)" }}>No roles yet.</p>}
      <div className="flex flex-col gap-1" data-areas={rows.length}>
        {rows.map((row) => {
          const isOpen = open === row.role._id;
          const line = row.area?.standing;
          const depth = row.role.reports_to.kind === "role" ? 1 : 0;
          return (
            <div key={row.role._id} className={cn("rounded-lg border transition-colors", isOpen ? "bg-sol-bg-highlight/50" : "hover:bg-sol-bg-highlight/40")} style={{ borderColor: isOpen ? "color-mix(in srgb, var(--sol-violet) 40%, transparent)" : "transparent", marginLeft: depth * 14 }} data-area-row={row.role.handle}>
              <button type="button" onClick={() => onToggle(row.role._id)} aria-expanded={isOpen} className="w-full flex items-start gap-2 px-2.5 py-1.5 text-left">
                <RoleFace role={row.role} size={22} className="shrink-0 mt-[1px]" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium" style={{ color: "var(--sol-text)" }}>{row.role.name}</span>
                    <StatusWord row={row} />
                  </span>
                  {line ? (
                    <span className={cn("block text-[11.5px] leading-snug", isOpen ? "break-words" : "truncate")} style={{ color: "var(--sol-text-muted)" }} title={`${line.project}: ${line.text}`} data-area-standing>
                      {line.text}{line.written_on && <span style={{ color: "var(--sol-text-dim)" }}> · {line.written_on.slice(5)}</span>}
                    </span>
                  ) : (
                    <span className="block text-[11.5px] leading-snug" style={{ color: "var(--sol-text-dim)" }} data-area-standing="none">No word from it yet.</span>
                  )}
                </span>
                {isOpen ? <ChevronDown className="w-3.5 h-3.5 shrink-0 mt-1" style={{ color: "var(--sol-text-dim)" }} /> : <ChevronRight className="w-3.5 h-3.5 shrink-0 mt-1" style={{ color: "var(--sol-text-dim)" }} />}
              </button>
              {isOpen && <AreaDetail row={row} now={now} onOpenSession={onOpenSession} onSelectNode={onSelectNode} onTrigger={onTrigger} onSetEvery={onSetEvery} onSend={onSend} />}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- health: the loop

/** Every proposal is decided: the company's health is its own page
 *  (HealthBoard), so the sheet says so and goes there. */
function HealthBody(props: StaffingPaneProps) {
  return (
    <div data-health-pointer>
      <h2 className="text-[17px] leading-tight font-semibold tracking-tight" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}>No proposal is open</h2>
      <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: "var(--sol-text-muted)" }}>How the company is doing, what is waiting on you and the head of people's conversation are on the health page.</p>
      {props.onOpenHealth && <OrgButton primary size="sm" className="mt-3" onClick={props.onOpenHealth} data-open-health>Open the health page</OrgButton>}
    </div>
  );
}

// ---------------------------------------------------------------- no head of people

function NoHeadBody(props: StaffingPaneProps) {
  return (
    <div data-no-head>
      <h2 className="text-[19px] leading-tight font-semibold tracking-tight" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}>No head of people yet</h2>
      <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: "var(--sol-text-muted)" }}>
        The head of people reads how work flows, proposes the organization as changes on this chart, and reviews it every week. You decide each change; it applies nothing on its own.
      </p>
      {props.reviewing ? (
        <div className="mt-4 rounded-xl border p-3" style={{ borderColor: BORDER, background: "var(--sol-card)" }} data-reviewing>
          <div className="flex items-center gap-2.5">
            <Sparkles className="w-4 h-4 animate-pulse shrink-0" style={{ color: "var(--sol-violet)" }} />
            <div className="text-[12.5px]" style={{ color: "var(--sol-text-secondary)" }}>Reviewing the company. The proposal appears here when it lands.</div>
          </div>
          {props.reviewSessionId && <ReviewSessionLink id={props.reviewSessionId} onOpenSession={props.onOpenSession} />}
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-2">
          {props.reviewEnded && <ReviewEndedLine sessionId={props.reviewSessionId} onOpenSession={props.onOpenSession} />}
          <OrgButton primary onClick={props.onHireHeadOfPeople} className="justify-center h-9">
            <UserRoundPlus className="w-3.5 h-3.5" /> Hire a Head of People
          </OrgButton>
          <OrgButton onClick={props.onProposeNow} className="justify-center h-9">
            <Sparkles className="w-3.5 h-3.5" /> Propose an org now
          </OrgButton>
          <p className="text-[11px] leading-snug px-1" style={{ color: "var(--sol-text-dim)" }}>Hiring gives you a head of people that stays and reviews the company every week. Proposing runs one review and hires nobody.</p>
        </div>
      )}
      <AreasPreview {...props} />
    </div>
  );
}

/** A review that stopped with nothing posted: said plainly, with the way in
 *  to see why, above the buttons that start another. */
export function ReviewEndedLine({ sessionId, onOpenSession }: { sessionId?: string | null; onOpenSession: (id: string) => void }) {
  return (
    <div className="rounded-lg border px-3 py-2 text-[12px] flex items-center gap-2 flex-wrap" data-review-ended style={{ borderColor: "color-mix(in srgb, var(--sol-orange) 45%, transparent)", background: "color-mix(in srgb, var(--sol-orange) 8%, transparent)", color: "var(--sol-text-secondary)" }}>
      <span className="min-w-0 flex-1">The review stopped without making a proposal.</span>
      {sessionId && <button type="button" onClick={() => onOpenSession(sessionId)} className="shrink-0 inline-flex items-center gap-1 hover:underline" style={{ color: "var(--sol-violet)" }}>See why <ExternalLink className="w-3 h-3" /></button>}
    </div>
  );
}

/** The session "Propose an org now" started: a way in while it works, and
 *  the way to see why nothing landed if the review ends without a proposal. */
export function ReviewSessionLink({ id, onOpenSession }: { id: string; onOpenSession: (id: string) => void }) {
  return (
    <button type="button" onClick={() => onOpenSession(id)} className="mt-2 inline-flex items-center gap-1 text-[11.5px] px-1.5 h-6 rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-violet)" }} data-review-session>
      Open the review <ExternalLink className="w-3 h-3" />
    </button>
  );
}

/** With no Head of People and no proposal, the areas the roles look after still read (S29). */
function AreasPreview(props: StaffingPaneProps) {
  const rows = useMemo(() => areaRows(props.tree, props.health), [props.tree, props.health]);
  const [openRole, setOpenRole] = useState<string | null>(null);
  if (rows.length === 0 && !props.healthMissing && !props.healthError) return null;
  return (
    <>
      <HealthNote missing={props.healthMissing} error={props.healthError} hasHealth={!!props.health} onRetry={props.onRetryHealth} />
      <Areas rows={rows} now={props.now} open={openRole} onToggle={(id) => setOpenRole((cur) => (cur === id ? null : id))} onOpenSession={props.onOpenSession} onSelectNode={props.onSelectNode} onTrigger={props.onTrigger} onSetEvery={props.onSetTriggerEvery} onSend={props.onSendToRole} />
    </>
  );
}

// ---------------------------------------------------------------- composer and thread

/** The head of people's standing session, embedded: its composer sends
 *  through the pending message rail and the thread renders below it, the same
 *  component the anchor page uses. The embed carries the rail's own delivery
 *  banners (a line that has not reached the agent, kill and restart), so a
 *  dead session speaks up per message; what the embed cannot know is the
 *  role's own state, so a paused Head of People is said here, with the way out. */
export function Composer({ head, onOpenSession, onResume, fill }: { head: OrgRole | null; onOpenSession: (id: string) => void; onResume?: (roleId: string) => void; /** The health page's own column: the thread takes the full height. */ fill?: boolean }) {
  const conv = head?.standing?.conversation_id ?? null;
  const paused = head?.status === "paused";
  return (
    <div className={fill ? "flex flex-col h-full min-h-0" : "mt-6 pt-4 border-t"} style={fill ? undefined : { borderColor: BORDER }} data-composer>
      <div className={cn("flex items-center justify-between", fill ? "hidden" : "mb-2")}>
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>Head of people</span>
        {conv && (
          <button type="button" onClick={() => onOpenSession(conv)} className="inline-flex items-center gap-1 text-[11px] px-1.5 h-[20px] rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-violet)" }}>
            Open its thread <ExternalLink className="w-3 h-3" />
          </button>
        )}
      </div>
      {paused && head && (
        <div className="mb-2 rounded-lg border px-3 py-2 flex items-center gap-2 text-[12px]" data-head-paused style={{ borderColor: "color-mix(in srgb, var(--sol-yellow) 45%, transparent)", background: "color-mix(in srgb, var(--sol-yellow) 8%, transparent)", color: "var(--sol-text-secondary)" }}>
          <Pause className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--sol-yellow)" }} />
          <span className="min-w-0 flex-1">{rolePausedSentence(head.name)}</span>
          {onResume && <OrgButton size="sm" onClick={() => onResume(head._id)}><Play className="w-3 h-3" /> Resume</OrgButton>}
        </div>
      )}
      {!head ? (
        <p className="text-[12px] px-1" style={{ color: "var(--sol-text-dim)" }}>No head of people hired yet.</p>
      ) : !conv ? (
        <p className="text-[12px] px-1" style={{ color: "var(--sol-text-dim)" }}>The head of people has not started yet. Its conversation appears here when it does.</p>
      ) : (
        <div className={cn("overflow-hidden", fill ? "flex-1 min-h-0" : "rounded-xl border")} style={fill ? undefined : { borderColor: BORDER, height: "min(420px, 45dvh)" }}>
          <AnchorConversation conversationId={conv} hideHeader seedOwnership={false} />
        </div>
      )}
    </div>
  );
}
