"use client";
// The staffing pane (docs/architecture/org-staffing.md S5): the "Staffing"
// mode of the org page's right sheet. With a proposal open it is the review
// surface: header, the change list with accept, edit and skip, the rationale
// and evidence of the selected change inline under its row, accept all, the
// flags the proposal addresses, and a composer to the chief of staff's
// standing session with its thread below. With no proposal it is the health
// summary and the composer. With no chief of staff it is two buttons.
// Everything it shows arrives through props from the store (OrgPage owns the
// reads and the actions); it computes nothing beyond what staffingModel.ts
// hands it.
import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, BookOpen, Check, ChevronDown, ChevronRight, ClipboardCheck, CornerDownRight, ExternalLink, Flag as FlagGlyph, ListChecks, MessageSquareText, Pause, Pencil, Play, Sparkles, Undo2, UserRoundPlus, X } from "lucide-react";
import { ORG_SYNC_KINDS } from "@codecast/shared/contracts/orgProposal";
import { compactAge } from "../../lib/threadState";
import { cn } from "../../lib/utils";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { AnchorConversation } from "../anchor/AnchorConversation";
import { OrgButton } from "./OrgButton";
import { ProposalAuthorPill } from "./ProposalAuthorPill";
import { amendedMoves, revisedLine, revisionWord } from "./staffingRevise";
import { SectionLabel } from "./OrgScopePanel";
import { SEVERITY_META } from "./orgMeta";
import type { OrgRole, OrgTree } from "./orgTypes";
import type { HealthFlag, OrgChangeStatus, OrgHealth, OrgProposalChange, OrgProposalRow } from "./orgStaffingTypes";
import {
  CHANGE_STATUS_META,
  FLAG_LABEL,
  bottleneckRoles,
  changeEdits,
  changeFields,
  changeLine,
  changeTenure,
  collectHealthFlags,
  groupChanges,
  isDecidable,
  openProposals,
  proposalProgress,
  recordsInLine,
  relatedFlags,
  spanOfControl,
  staffingMode,
  syncEvidence,
  syncGroupSummary,
  tenureLine,
  SYNC_CARD_THRESHOLD,
  budgetArithmetic,
  capsLine,
  hasAcceptedBefore,
  kindDescription,
  splitAsk,
  type BudgetArithmetic,
  type ChangeField,
  type HealthFlagRow,
  type SyncGroupSummary,
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
  chief: OrgRole | null;
  /** "Propose an org now" is running and no proposal has landed yet. */
  reviewing: boolean;
  /** The review session finished its turn, or was closed, and posted no
   *  proposal: the pane says so, keeps the way in, and gives the buttons back. */
  reviewEnded?: boolean;
  /** The session "Propose an org now" started, while it is reviewing or after it ended. */
  reviewSessionId?: string | null;
  now: number;
  onSelectChange: (changeId: string | null) => void;
  onDecide: (changeId: string, verdict: "accept" | "skip", edits?: Record<string, unknown>) => void;
  /** Accept every remaining change, or with `kinds` only those kinds
   *  ("Accept group" on the records card, S9). */
  onAcceptAll: (proposalId: string, opts?: { kinds?: string[] }) => void;
  /** Edit on a role change opens the hire dialog prefilled (the page owns it). */
  onEditRole: (change: OrgProposalChange) => void;
  onSelectNode: (nodeId: string) => void;
  onOpenSession: (conversationId: string) => void;
  onPickProposal: (shortId: string) => void;
  /** Withdraw an open proposal: the replaced one, from its own line (S4). */
  onWithdraw?: (proposalId: string) => void;
  onHireChief: () => void;
  onProposeNow: () => void;
  /** Resume a paused chief of staff (its wakes are held while paused). */
  onResumeChief?: (roleId: string) => void;
  /** The proposal's conversation (org-staffing.md S18), built by the page
   *  (ProposalThread). `undefined` = the proposal has no thread (a person
   *  posted it): the pane falls back to the chief of staff's composer. `null`
   *  = the page renders the thread itself (its own column, or the phone
   *  sheet's second view). A node = place it under the list. */
  threadNode?: React.ReactNode;
  /** Phone: the list leads, and this bar at its foot opens the conversation. */
  discuss?: { name: string; named: boolean; updated: number; onOpen: () => void } | null;
  /** A row's "Ask about this": select the change and bring the composer to it. */
  onAskAbout?: (change: OrgProposalChange) => void;
  /** Changes the author revised since the reader last looked
   *  (staffingRevise.revisedSince): the strip above the list says so, each
   *  row is marked, and `onSeen` clears both. */
  revised?: { rows: OrgProposalChange[]; who: string; onSeen: () => void };
  /** A `?proposal=op-N` link that does not resolve in the active workspace
   *  (staffingModel.resolveProposalLink): the pane is that one line, with a
   *  switch when the proposal lives in a workspace the viewer can open. The
   *  active workspace's own body would answer a question nobody asked. */
  link?: ProposalLinkLine;
  /** The viewer's user id: whether they have accepted a change before
   *  (staffingModel.hasAcceptedBefore) decides whether the cold read intro
   *  shows (S17). */
  meId?: string | null;
  /** The intro was dismissed or the person accepted a change once: never again. */
  introSeen?: boolean;
  onIntroSeen?: () => void;
  /** Open the glossary dialog (OrgGlossary) on a page: the pane's "how this
   *  works" link and its "Words" control. */
  onOpenGlossary?: (page: "how" | "words") => void;
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
      {mode === "no_chief" && <NoChiefBody {...props} />}
      {/* S18: with a proposal open the conversation is the author's thread, placed
          here only when the page has no column for it; the chief of staff's
          composer stays for the health summary and a proposal nobody agent wrote. */}
      {mode === "proposal" ? (props.threadNode === undefined && !props.discuss ? <Composer chief={props.chief} onOpenSession={props.onOpenSession} onResume={props.onResumeChief} /> : props.threadNode) : null}
      {mode === "proposal" && props.discuss && <DiscussBar {...props.discuss} />}
      {mode === "health" && <Composer chief={props.chief} onOpenSession={props.onOpenSession} onResume={props.onResumeChief} />}
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

// ---------------------------------------------------------------- proposal

const MODE_WORD: Record<OrgProposalRow["mode"], string> = { init: "first org", review: "review", request: "request" };

function ProposalBody(props: StaffingPaneProps & { proposal: OrgProposalRow }) {
  const { proposal, tree, health, now, selectedChangeId } = props;
  const progress = proposalProgress(proposal);
  const groups = useMemo(() => groupChanges(proposal.changes), [proposal.changes]);
  const flags = useMemo(() => collectHealthFlags(health, tree), [health, tree]);
  const related = useMemo(() => relatedFlags(flags, proposal.changes), [flags, proposal.changes]);
  const others = openProposals(props.proposals).filter((p) => p._id !== proposal._id);
  const [confirmAll, setConfirmAll] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [allFlags, setAllFlags] = useState(false);
  // A records group past the threshold is one card until "Review each".
  const [reviewSync, setReviewSync] = useState(false);
  const syncSummary = useMemo(() => { const g = groups.find((x) => x.sync); return g ? syncGroupSummary(g.changes) : null; }, [groups]);
  const edit = (c: OrgProposalChange) => {
    if (c.change.kind === "role") props.onEditRole(c);
    else { props.onSelectChange(c._id); setEditing(c._id); }
  };
  const flagRows = allFlags ? flags : related;
  // S17: the two sentences over the ask, for a person who has never accepted
  // a change. Dismissed once or stamped by a first accept, gone for good.
  const showIntro = !props.introSeen && !hasAcceptedBefore(props.proposals, props.meId);
  return (
    <>
      {showIntro && <ProposalIntro onDismiss={() => props.onIntroSeen?.()} onHow={() => props.onOpenGlossary?.("how")} />}
      {/* header */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center h-[20px] px-1.5 rounded-md text-[10.5px] font-medium" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)", fontFamily: "var(--font-mono)" }}>{proposal.short_id}</span>
        {others.length > 0 && (
          <select aria-label="Open proposal" value={proposal.short_id} onChange={(e) => props.onPickProposal(e.target.value)} className="ml-auto h-[20px] rounded-md border bg-transparent text-[10.5px] px-1" style={{ borderColor: BORDER, color: "var(--sol-text-muted)", fontFamily: "var(--font-mono)" }}>
            <option value={proposal.short_id}>{proposal.short_id}</option>
            {others.map((p) => <option key={p._id} value={p.short_id}>{p.short_id} · {p.title}</option>)}
          </select>
        )}
      </div>
      {/* supersession (S4): the replaced proposal says so first, with Withdraw right there */}
      {proposal.superseded_by && (
        <div className="mt-2 rounded-lg border px-3 py-2 flex items-center gap-2 text-[12px]" data-superseded-by={proposal.superseded_by.short_id} style={{ borderColor: "color-mix(in srgb, var(--sol-orange) 45%, transparent)", background: "color-mix(in srgb, var(--sol-orange) 8%, transparent)", color: "var(--sol-text-secondary)" }}>
          <Undo2 className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--sol-orange)" }} />
          <span className="min-w-0 flex-1">
            Replaced by <button type="button" onClick={() => props.onPickProposal(proposal.superseded_by!.short_id)} className="font-medium hover:underline" style={{ color: "var(--sol-violet)", fontFamily: "var(--font-mono)" }}>{proposal.superseded_by.short_id}</button>, posted {compactAge(now - proposal.superseded_by.created_at)} ago{proposal.superseded_by.status !== "open" ? ` (${proposal.superseded_by.status})` : ""}.
          </span>
          {proposal.status === "open" && props.onWithdraw && (
            <OrgButton size="sm" onClick={() => props.onWithdraw!(proposal._id)} data-withdraw>Withdraw</OrgButton>
          )}
        </div>
      )}
      <h2 className="mt-2 text-[19px] leading-tight font-semibold tracking-tight" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}>{proposal.title}</h2>
      {proposal.supersedes && (
        <div className="mt-1 flex items-center gap-1 text-[11.5px]" data-supersedes={proposal.supersedes.short_id} style={{ color: "var(--sol-text-muted)" }}>
          <ArrowRight className="w-3 h-3" style={{ color: "var(--sol-text-dim)" }} />
          Replaces <button type="button" onClick={() => props.onPickProposal(proposal.supersedes!.short_id)} className="font-medium hover:underline" style={{ color: "var(--sol-violet)", fontFamily: "var(--font-mono)" }}>{proposal.supersedes.short_id}</button>{proposal.supersedes.status !== "open" ? <span style={{ color: "var(--sol-text-dim)" }}> · {proposal.supersedes.status}</span> : null}
        </div>
      )}
      {/* provenance (S15): who wrote it, one click from here */}
      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap text-[11.5px]" style={{ color: "var(--sol-text-muted)" }}>
        <ProposalAuthorPill author={proposal.author} onOpenSession={props.onOpenSession} />
        <Dot />
        <span>{MODE_WORD[proposal.mode] ?? proposal.mode}</span>
        <Dot />
        <span className="tabular-nums" title={new Date(proposal.created_at).toLocaleString()}>{compactAge(now - proposal.created_at)} ago</span>
        <Dot />
        <span className="tabular-nums font-medium" style={{ color: "var(--sol-text)" }} data-progress>{progress.decided} of {progress.total} decided</span>
        {progress.fromCounts && <span style={{ color: "var(--sol-text-dim)" }} data-progress-loading>· loading changes</span>}
      </div>
      <ProgressStrip changes={proposal.changes} selectedId={selectedChangeId} onPick={props.onSelectChange} />
      {/* S17: the plain ask, then the detail behind one control each; the
          groups with counts are the list headers below. */}
      <ProposalSummary
        proposal={proposal}
        tree={tree}
        onOpenGlossary={props.onOpenGlossary}
        findings={
          props.healthMissing ? (
            <FlagList rows={[]} missing onSelectNode={props.onSelectNode} />
          ) : props.healthError && !props.health ? (
            <FlagList rows={[]} error={props.healthError} hasHealth={false} onRetry={props.onRetryHealth} onSelectNode={props.onSelectNode} />
          ) : (
            <>
              {flagRows.length === 0 ? (
                <p className="text-[12px] px-1" style={{ color: "var(--sol-text-dim)" }}>{flags.length === 0 ? "Nothing is flagged. The company is inside its limits." : "No finding names a role this proposal touches."}</p>
              ) : (
                <FlagList rows={flagRows} onSelectNode={props.onSelectNode} limit={allFlags ? 5 : 3} />
              )}
              {flags.length > related.length && (
                <button type="button" onClick={() => setAllFlags((v) => !v)} className="mt-1 self-start inline-flex items-center gap-1 text-[11px] px-1.5 h-6 rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-violet)" }} data-all-flags={allFlags}>
                  {allFlags ? "Only this proposal's findings" : `See all ${flags.length} findings in the company`}
                </button>
              )}
            </>
          )
        }
        findingsCount={flagRows.length}
      />

      {/* changes: the pane's job in this mode, so they come first */}
      <SectionLabel right={progress.remaining > 0 ? <span className="text-[10.5px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{progress.remaining} to decide</span> : undefined}>Changes</SectionLabel>
      {props.revised && props.revised.rows.length > 0 && <RevisedStrip rows={props.revised.rows} who={props.revised.who} onSeen={props.revised.onSeen} onPick={props.onSelectChange} />}
      {proposal.changes.length === 0 && (
        <p className="text-[12px] px-1" style={{ color: "var(--sol-text-dim)" }} data-changes-loading>{progress.fromCounts ? `Loading the ${progress.total} changes…` : "This proposal has no changes."}</p>
      )}
      <div className="flex flex-col gap-3">
        {groups.map((g) => (
          <div key={g.kind} data-change-group={g.kind}>
            {g.sync ? (
              // S9: the records the evidence says are already finished come
              // first, as their own group; the header counts them.
              <div className="sticky top-0 z-[1] flex items-center gap-1.5 py-1 px-1" style={{ background: "var(--sol-bg)" }} data-sync-header>
                <ClipboardCheck className="w-3 h-3 shrink-0" style={{ color: "var(--sol-green)" }} />
                <span className="text-[10px] font-medium uppercase tracking-[0.08em]" style={{ color: "var(--sol-green)" }}>{g.label}</span>
                <span className="ml-auto text-[10.5px] tabular-nums" style={{ color: "var(--sol-text-dim)" }} data-sync-count>{recordsInLine(g.changes)} {recordsInLine(g.changes) === 1 ? "record" : "records"}</span>
              </div>
            ) : (
              <div className="sticky top-0 z-[1] flex items-center gap-1.5 py-1 px-1" style={{ background: "var(--sol-bg)" }} title={kindDescription(g.kind)} data-group-header={g.kind}>
                <span className="text-[10px] font-medium uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>{g.label}</span>
                <span className="ml-auto text-[10.5px] tabular-nums" style={{ color: "var(--sol-text-dim)" }} data-group-count>{g.changes.length}</span>
              </div>
            )}
            {g.sync && syncSummary && g.changes.length > SYNC_CARD_THRESHOLD && !reviewSync ? (
              <SyncGroupCard
                summary={syncSummary}
                onAcceptGroup={() => props.onAcceptAll(proposal._id, { kinds: [...ORG_SYNC_KINDS] })}
                onReview={() => setReviewSync(true)}
                onPick={(id) => props.onSelectChange(id)}
              />
            ) : (
            <div className="flex flex-col gap-1">
              {g.sync && reviewSync && (
                <button type="button" onClick={() => setReviewSync(false)} className="self-start inline-flex items-center gap-1 text-[11px] px-1.5 h-6 rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-dim)" }} data-sync-collapse>
                  <ChevronDown className="w-3 h-3" /> Back to the summary
                </button>
              )}
              {(g.sync && syncSummary ? syncSummary.rows : g.changes).map((c) => (
                <ChangeRow
                  key={c._id}
                  change={c}
                  tree={tree}
                  nested={g.sync && syncSummary ? syncSummary.nested[c._id] : undefined}
                  selected={c._id === selectedChangeId}
                  revisedNew={!!props.revised?.rows.some((r) => r._id === c._id)}
                  onAsk={props.onAskAbout ? () => props.onAskAbout!(c) : undefined}
                  editing={editing === c._id}
                  onPick={() => props.onSelectChange(c._id === selectedChangeId ? null : c._id)}
                  onAccept={() => props.onDecide(c._id, "accept")}
                  onSkip={() => props.onDecide(c._id, "skip")}
                  onEdit={() => edit(c)}
                  onCancelEdit={() => setEditing(null)}
                  onAcceptWithEdits={(edits) => { setEditing(null); props.onDecide(c._id, "accept", edits); }}
                />
              ))}
            </div>
            )}
          </div>
        ))}
      </div>
      {progress.remaining > 1 && (
        <div className="mt-3">
          {!confirmAll ? (
            <OrgButton onClick={() => setConfirmAll(true)} className="w-full justify-center">
              <Check className="w-3.5 h-3.5" /> Accept all remaining ({progress.remaining})
            </OrgButton>
          ) : (
            <div className="rounded-lg p-3 border" style={{ borderColor: "color-mix(in srgb, var(--sol-cyan) 40%, transparent)", background: "color-mix(in srgb, var(--sol-cyan) 6%, transparent)" }}>
              <p className="text-[12px]" style={{ color: "var(--sol-text-secondary)" }}>
                Apply the {progress.remaining} remaining changes now: records first, then projects and plans, then the agents, their areas and their limits. Each applies as proposed{progress.failed > 0 ? `; the ${progress.failed} failed ${progress.failed === 1 ? "one is" : "ones are"} retried` : ""}.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button type="button" onClick={() => { setConfirmAll(false); props.onAcceptAll(proposal._id); }} className="h-7 px-3 rounded-md text-[12px] font-semibold" style={{ background: "var(--sol-cyan)", color: "var(--sol-bg)" }}>Accept {progress.remaining}</button>
                <button type="button" onClick={() => setConfirmAll(false)} className="h-7 px-3 rounded-md text-[12px]" style={{ color: "var(--sol-text-muted)" }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

    </>
  );
}

// ---------------------------------------------------------------- the cold read (S17)

/**
 * Two sentences a person who has never seen a proposal can read cold: what
 * codecast is proposing and what accepting costs. One "how this works" link
 * to the short page, one dismiss that never returns.
 */
function ProposalIntro({ onDismiss, onHow }: { onDismiss: () => void; onHow: () => void }) {
  return (
    <div className="mb-3 rounded-xl border px-3 py-2.5 flex items-start gap-2" data-proposal-intro style={{ borderColor: "color-mix(in srgb, var(--sol-violet) 40%, transparent)", background: "color-mix(in srgb, var(--sol-violet) 7%, transparent)" }}>
      <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed" style={{ color: "var(--sol-text-secondary)" }}>
        Codecast is proposing a set of people and standing agents, each with a named area of work, so an agent knows what to look after and what to leave alone. Nothing moves until you accept a change, and each one can be undone unless its own line says otherwise.
        <button type="button" onClick={onHow} className="ml-1.5 font-medium underline-offset-2 hover:underline" style={{ color: "var(--sol-violet)" }} data-intro-how>How this works</button>
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss, and do not show this again" title="Do not show this again" className="w-6 h-6 -mr-1 -mt-0.5 shrink-0 inline-flex items-center justify-center rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-dim)" }} data-intro-dismiss>
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

type SummaryControl = "evidence" | "budget" | "findings" | "tail";

/**
 * The summary a person reads before the change list (S17): the ask, whole
 * on a desktop pane and clamped on a phone with the rest one tap away, then
 * one quiet row of text links that hold the detail: the evidence page, the
 * budget arithmetic, the findings, the rest of the letter, the glossary.
 * The groups with their counts are the list's own headers, right below, so
 * the first screen reaches a change instead of a table about the changes.
 */
function ProposalSummary({ proposal, tree, findings, findingsCount, onOpenGlossary }: {
  proposal: OrgProposalRow; tree: OrgTree | null;
  findings: React.ReactNode; findingsCount: number;
  onOpenGlossary?: (page: "how" | "words") => void;
}) {
  const [askOpen, setAskOpen] = useState(false);
  const [control, setControl] = useState<SummaryControl | null>(null);
  const { ask, tail, evidenceHref } = useMemo(() => splitAsk(proposal.summary_md), [proposal.summary_md]);
  const budget = useMemo(() => budgetArithmetic(tree, proposal.changes), [tree, proposal.changes]);
  const toggle = (c: SummaryControl) => setControl((cur) => cur === c ? null : c);
  // The ask is the first paragraph of the agent's letter, about two hundred
  // words: whole on a desktop pane, clamped to five lines on a phone with
  // the rest one tap away, so the first screen holds the ask and the counts.
  const longAsk = ask.length > 220;
  return (
    <div className="mt-3" data-proposal-summary>
      {ask && (
        <div data-ask={askOpen || !longAsk ? "open" : "folded"}>
          <div className={cn("text-[12.5px] leading-relaxed", !askOpen && longAsk && "line-clamp-5 sm:line-clamp-none")} style={{ color: "var(--sol-text-secondary)" }}>
            <MarkdownRenderer content={ask} />
          </div>
          {longAsk && (
            <button type="button" onClick={() => setAskOpen((v) => !v)} className="sm:hidden mt-0.5 inline-flex items-center gap-1 text-[11.5px] px-1 -ml-1 h-6 rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-violet)" }} data-ask-toggle>
              {askOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              {askOpen ? "Fold the ask" : "Read the whole ask"}
            </button>
          )}
        </div>
      )}

      {/* three controls that keep the detail behind the summary */}
      <div className="mt-2 flex items-center gap-x-3 gap-y-1 flex-wrap" data-summary-controls>
        {evidenceHref ? (
          <Link href={evidenceHref} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 h-6 text-[11.5px] hover:underline underline-offset-2" style={{ color: "var(--sol-violet)" }} data-summary-control="evidence">
            Evidence <ExternalLink className="w-3 h-3" style={{ color: "var(--sol-text-dim)" }} />
          </Link>
        ) : (
          <SummaryToggle active={control === "evidence"} onClick={() => toggle("evidence")} name="evidence">Evidence</SummaryToggle>
        )}
        <SummaryToggle active={control === "budget"} onClick={() => toggle("budget")} name="budget">Budget</SummaryToggle>
        <SummaryToggle active={control === "findings"} onClick={() => toggle("findings")} name="findings" count={findingsCount}>Findings</SummaryToggle>
        {tail && <SummaryToggle active={control === "tail"} onClick={() => toggle("tail")} name="tail">The rest of the letter</SummaryToggle>}
        {onOpenGlossary && (
          <button type="button" onClick={() => onOpenGlossary("words")} className="ml-auto inline-flex items-center gap-1 h-6 text-[11.5px] hover:underline underline-offset-2" style={{ color: "var(--sol-violet)" }} title="The eight words this page uses, each in one sentence" data-summary-words>
            <BookOpen className="w-3 h-3" /> Words
          </button>
        )}
      </div>
      {control === "evidence" && (
        <p className="mt-2 text-[12px] px-1" style={{ color: "var(--sol-text-muted)" }} data-summary-detail="evidence">This proposal has no evidence page. Each change carries its own evidence under its line: select one to read it.</p>
      )}
      {control === "budget" && <BudgetSheet budget={budget} />}
      {control === "tail" && (
        <div className="mt-2 rounded-lg border p-2.5 text-[12.5px] leading-relaxed" style={{ borderColor: BORDER, background: "var(--sol-card)", color: "var(--sol-text-secondary)" }} data-summary-detail="tail">
          <MarkdownRenderer content={tail} />
        </div>
      )}
      {control === "findings" && (
        <div className="mt-2 flex flex-col" data-summary-detail="findings">
          <p className="text-[11px] leading-snug px-1 mb-1.5" style={{ color: "var(--sol-text-dim)" }}>What the review found about the roles this proposal touches. A finding points at a role or a person; click one to see it on the chart.</p>
          {findings}
        </div>
      )}
    </div>
  );
}

function SummaryToggle({ active, onClick, name, count, children }: { active: boolean; onClick: () => void; name: SummaryControl; count?: number; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-expanded={active} className="inline-flex items-center gap-1 h-6 text-[11.5px] hover:underline underline-offset-2" style={{ color: active ? "var(--sol-text)" : "var(--sol-violet)" }} data-summary-control={name}>
      {children}
      {count !== undefined && count > 0 && <span className="tabular-nums text-[10.5px]" style={{ color: "var(--sol-text-dim)" }}>{count}</span>}
      {active ? <ChevronDown className="w-3 h-3" style={{ color: "var(--sol-text-dim)" }} /> : <ChevronRight className="w-3 h-3" style={{ color: "var(--sol-text-dim)" }} />}
    </button>
  );
}

/**
 * The budget arithmetic (S17), computed from the tree and the open changes
 * rather than quoted: what the standing agents may do in a day now, what
 * they may do if every remaining change lands, and the lines that move it.
 */
function BudgetSheet({ budget }: { budget: BudgetArithmetic }) {
  const moved = budget.lines.length > 0;
  return (
    <div className="mt-2 rounded-lg border p-2.5" style={{ borderColor: BORDER, background: "var(--sol-card)" }} data-summary-detail="budget">
      <p className="text-[11px] leading-snug" style={{ color: "var(--sol-text-dim)" }}>What the standing agents may do in one day, added up across the {budget.seats} {budget.seats === 1 ? "agent" : "agents"} with a limit{budget.paused > 0 ? `; ${budget.paused} paused ${budget.paused === 1 ? "agent stays" : "agents stay"} outside the total` : ""}.</p>
      <div className="mt-2 grid grid-cols-[64px_1fr] gap-x-2 gap-y-1 text-[12px]">
        <span className="uppercase tracking-[0.08em] text-[10px] mt-[2px]" style={{ color: "var(--sol-text-dim)" }}>today</span>
        <span className="tabular-nums" style={{ color: "var(--sol-text)" }} data-budget-today>{capsLine(budget.today)}</span>
        <span className="uppercase tracking-[0.08em] text-[10px] mt-[2px]" style={{ color: moved ? "var(--sol-violet)" : "var(--sol-text-dim)" }}>after</span>
        <span className="tabular-nums" style={{ color: "var(--sol-text)" }} data-budget-after>{moved ? capsLine(budget.after) : "the same: no open change moves a limit"}</span>
      </div>
      {moved && (
        <div className="mt-2 flex flex-col gap-1" data-budget-lines>
          {budget.lines.map((l, i) => (
            <div key={i} className="text-[11.5px] leading-snug" style={{ color: "var(--sol-text-muted)" }}>
              <span className="font-medium" style={{ color: "var(--sol-text)", fontFamily: "var(--font-mono)" }}>@{l.handle.replace(/^@/, "")}</span>
              {l.name && <span> {l.name}</span>}
              <span style={{ color: "var(--sol-text-dim)" }}> · {l.note}</span>
              <span className="block tabular-nums">{l.before && l.after ? `from ${capsLine(l.before)} to ${capsLine(l.after)}` : l.after ? `adds ${capsLine(l.after)}` : `frees ${capsLine(l.before)}`}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Dot() {
  return <span style={{ color: "var(--sol-text-dim)" }}>·</span>;
}

/** One block per change, coloured by status, in list order: the "N of M" as
 *  a strip. A real control: each block is a button named by its change, so
 *  the strip is reachable by keyboard and read by a screen reader. */
function ProgressStrip({ changes: all, selectedId, onPick }: { changes: OrgProposalChange[]; selectedId: string | null; onPick: (id: string) => void }) {
  // A change the author removed (S18) left the ask, so it leaves the strip.
  const changes = all.filter((c) => c.status !== "removed");
  if (changes.length === 0) return null;
  return (
    <div className="mt-2 flex gap-[3px]" role="group" aria-label="Changes, one block each">
      {changes.map((c) => (
        <button
          key={c._id}
          type="button"
          onClick={() => onPick(c._id)}
          aria-label={`${CHANGE_STATUS_META[c.status].label} · ${changeLine(c.change)}`}
          aria-pressed={c._id === selectedId}
          title={`${CHANGE_STATUS_META[c.status].label} · ${changeLine(c.change)}`}
          className={cn("h-[6px] flex-1 rounded-sm transition-transform focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2", c._id === selectedId && "scale-y-[1.8]")}
          style={{ background: c.status === "proposed" ? "color-mix(in srgb, var(--sol-violet) 35%, transparent)" : CHANGE_STATUS_META[c.status].color, outlineColor: "var(--sol-violet)" }}
        />
      ))}
    </div>
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

export function StatusPill({ status }: { status: OrgChangeStatus }) {
  const m = CHANGE_STATUS_META[status];
  return (
    <span className="inline-flex items-center gap-1 h-[18px] px-1.5 rounded-md text-[10px] font-medium shrink-0" style={{ background: `color-mix(in srgb, ${m.color} 14%, transparent)`, color: m.color }} data-status={status}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: m.color }} />
      {m.label}
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
function ChangeRow({ change, tree, nested, selected, editing, revisedNew, onAsk, onPick, onAccept, onSkip, onEdit, onCancelEdit, onAcceptWithEdits }: {
  change: OrgProposalChange; tree: OrgTree | null; selected: boolean; editing: boolean;
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
  // S10: a role change says whether the seat is standing or a program with
  // its end. S9: a record change says what the evidence is, on the row itself.
  const tenure = tenureLine(changeTenure(change), tree);
  const evidence = syncEvidence(change.change);
  return (
    <div className={cn("rounded-lg border transition-colors", selected ? "bg-sol-bg-highlight/70" : "hover:bg-sol-bg-highlight/40", revisedNew && "org-pop-in")} style={{ borderColor: selected ? "color-mix(in srgb, var(--sol-violet) 45%, transparent)" : "transparent", ...(revisedNew ? { boxShadow: "inset 3px 0 0 var(--sol-violet)", background: "color-mix(in srgb, var(--sol-violet) 6%, transparent)" } : {}) }} data-change-row={change._id} data-change-status={change.status} data-revised={change.revision?.kind} data-revised-new={revisedNew || undefined}>
      <div className="flex items-start gap-2 px-2 py-1.5">
        <button type="button" onClick={onPick} className="flex-1 min-w-0 flex items-start gap-2 text-left" aria-pressed={selected} aria-expanded={selected}>
          <StatusPill status={change.status} />
          <span className="min-w-0 flex-1">
            <span className={cn("block text-[12.5px] leading-snug", selected ? "break-words" : "line-clamp-2", (change.status === "skipped" || removed) && "line-through opacity-60")} style={{ color: "var(--sol-text)" }} title={changeLine(change.change)}>
              {change.revision?.kind === "added" && <span className="inline-flex items-center h-[15px] px-1 mr-1.5 rounded text-[9.5px] font-semibold uppercase tracking-[0.06em] align-[1px] no-underline" style={{ background: "color-mix(in srgb, var(--sol-violet) 16%, transparent)", color: "var(--sol-violet)" }} data-revised-tag>new</span>}
              {changeLine(change.change)}
            </span>
            {change.revision && <RevisionNote change={change} selected={selected} />}
            {change.depends && <span className="block text-[11px] leading-snug" style={{ color: "var(--sol-text-dim)" }} data-change-depends>{change.depends}</span>}
            {tenure && <TenureChip line={tenure} />}
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
                    <span className={cn("min-w-0 flex-1", selected ? "break-words" : "truncate")} title={changeLine(t.change)}>{changeLine(t.change)}</span>
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

/** The author revised the list since the reader last looked (S18): said
 *  once above the changes, in the author's name; the marked rows clear
 *  together. Clicking a count focuses the first such row. */
function RevisedStrip({ rows, who, onSeen, onPick }: { rows: OrgProposalChange[]; who: string; onSeen: () => void; onPick: (id: string | null) => void }) {
  return (
    <div className="mb-2 rounded-lg border px-3 py-2 flex items-center gap-2 text-[12px] org-pop-in" data-revised-strip={rows.length} style={{ borderColor: "color-mix(in srgb, var(--sol-violet) 45%, transparent)", background: "color-mix(in srgb, var(--sol-violet) 8%, transparent)", color: "var(--sol-text-secondary)" }}>
      <Sparkles className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--sol-violet)" }} />
      <button type="button" onClick={() => onPick(rows[0]._id)} className="min-w-0 flex-1 text-left hover:underline">{revisedLine(rows, who)}</button>
      <button type="button" onClick={onSeen} className="shrink-0 text-[11px] font-medium px-1.5 h-6 rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-violet)" }} data-revised-seen>Got it</button>
    </div>
  );
}

/** Phone (S18): the list leads; this bar at its foot opens the conversation
 *  as the sheet's view, and says when the author changed rows meanwhile. */
function DiscussBar({ name, named, updated, onOpen }: { name: string; named: boolean; updated: number; onOpen: () => void }) {
  return (
    <div className="sticky bottom-0 -mx-4 px-4 pt-2 pb-3 mt-4" style={{ background: "linear-gradient(to bottom, transparent, var(--sol-bg) 30%)" }} data-discuss-bar>
      <button type="button" onClick={onOpen} className="w-full h-10 rounded-xl border flex items-center gap-2.5 px-3 text-left shadow-[0_8px_24px_-12px_rgba(0,0,0,0.5)]" style={{ borderColor: "color-mix(in srgb, var(--sol-violet) 45%, transparent)", background: "var(--sol-card)", color: "var(--sol-text)" }}>
        <MessageSquareText className="w-4 h-4 shrink-0" style={{ color: "var(--sol-violet)" }} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{named ? `Talk to ${name} about this` : "Talk to the agent that wrote this"}</span>
        {updated > 0 && <span className="shrink-0 inline-flex items-center h-5 px-1.5 rounded-full text-[10.5px] font-semibold tabular-nums" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}>{updated} revised</span>}
        <ChevronRight className="w-4 h-4 shrink-0" style={{ color: "var(--sol-text-dim)" }} />
      </button>
    </div>
  );
}

/**
 * A records group past the threshold (S9): one card instead of a hundred
 * rows. The count by kind, the three most consequential lines (a click
 * focuses that change), the evidence the reasons rest on as counts, then
 * Accept group (a confirm first: it applies every remaining record) and
 * Review each, which expands to the rows.
 */
function SyncGroupCard({ summary, onAcceptGroup, onReview, onPick }: { summary: SyncGroupSummary; onAcceptGroup: () => void; onReview: () => void; onPick: (changeId: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  const decided = summary.total - summary.remaining;
  return (
    <div className="rounded-xl border p-3" style={{ borderColor: "color-mix(in srgb, var(--sol-green) 35%, transparent)", background: "color-mix(in srgb, var(--sol-green) 5%, transparent)" }} data-sync-card>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-[15px] font-semibold tracking-tight" style={{ color: "var(--sol-text)", fontFamily: "var(--font-serif)" }} data-sync-count-line>{summary.countLine}</span>
        <span className="text-[11px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{decided > 0 ? `${decided} decided · ` : ""}{summary.remaining} to decide</span>
      </div>
      <p className="mt-1 text-[11.5px] leading-snug" style={{ color: "var(--sol-text-muted)" }}>Plans, tasks and projects whose record is behind what already happened. Accepting updates each record the way you would by hand; nothing else changes.</p>
      <div className="mt-2.5 flex flex-col gap-1" data-sync-top>
        {summary.top.map((c) => {
          const ev = syncEvidence(c.change);
          const nested = summary.nested[c._id]?.length ?? 0;
          return (
            <button key={c._id} type="button" onClick={() => onPick(c._id)} className="text-left rounded-lg px-2 py-1.5 hover:bg-sol-bg-highlight/70 transition-colors" data-sync-top-row={c._id}>
              <span className="block text-[12.5px] leading-snug" style={{ color: "var(--sol-text)" }}>{changeLine(c.change)}{nested > 0 ? <span style={{ color: "var(--sol-green)" }}> · closes {nested} {nested === 1 ? "task" : "tasks"}</span> : null}</span>
              {ev && <span className="block text-[11px] leading-snug line-clamp-2 mt-0.5" style={{ color: "var(--sol-text-muted)" }} title={ev}>{ev}</span>}
            </button>
          );
        })}
      </div>
      {summary.evidence.length > 0 && (
        <div className="mt-2.5 flex items-center gap-1.5 flex-wrap text-[11px]" data-sync-evidence-summary>
          <span className="uppercase tracking-[0.08em] text-[9.5px]" style={{ color: "var(--sol-green)" }}>evidence</span>
          {summary.evidence.slice(0, 4).map((e, i) => (
            <span key={e.label} style={{ color: "var(--sol-text-muted)" }}>{i > 0 && <span style={{ color: "var(--sol-text-dim)" }}>· </span>}<span className="tabular-nums font-medium" style={{ color: "var(--sol-text)" }}>{e.count}</span> {e.label}</span>
          ))}
        </div>
      )}
      {!confirm ? (
        <div className="mt-3 flex items-center gap-1.5">
          <OrgButton primary size="sm" onClick={() => setConfirm(true)} disabled={summary.remaining === 0} data-sync-accept-group><Check className="w-3 h-3" /> Accept group ({summary.remaining})</OrgButton>
          <OrgButton size="sm" onClick={onReview} data-sync-review-each><ListChecks className="w-3 h-3" /> Review each</OrgButton>
        </div>
      ) : (
        <div className="mt-3 rounded-lg p-2.5 border" style={{ borderColor: "color-mix(in srgb, var(--sol-cyan) 40%, transparent)", background: "color-mix(in srgb, var(--sol-cyan) 6%, transparent)" }} data-sync-confirm>
          <p className="text-[12px]" style={{ color: "var(--sol-text-secondary)" }}>Bring the {summary.remaining} remaining records up to date now: {summary.countLine}. Each applies as proposed; the rest of the proposal waits for you.</p>
          <div className="mt-2 flex items-center gap-2">
            <button type="button" onClick={() => { setConfirm(false); onAcceptGroup(); }} className="h-7 px-3 rounded-md text-[12px] font-semibold" style={{ background: "var(--sol-cyan)", color: "var(--sol-bg)" }}>Accept {summary.remaining}</button>
            <button type="button" onClick={() => setConfirm(false)} className="h-7 px-3 rounded-md text-[12px]" style={{ color: "var(--sol-text-muted)" }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
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

// ---------------------------------------------------------------- flags

/** A severity in shape and word (orgMeta.SEVERITY_META): a filled dot for a
 *  blocker, a hollow ring for a warning, nothing for information. */
function SeverityDot({ severity }: { severity: HealthFlag["severity"] }) {
  const m = SEVERITY_META[severity];
  if (m.dot === "none") return <span className="w-1.5 h-1.5 shrink-0 mt-[6px]" aria-hidden />;
  return <span className="w-1.5 h-1.5 rounded-full shrink-0 mt-[6px]" aria-hidden style={m.dot === "filled" ? { background: m.color } : { border: `1.5px solid ${m.color}` }} />;
}

function FlagList({ rows, missing, error, hasHealth, onRetry, onSelectNode, limit = 5 }: { rows: HealthFlagRow[]; missing?: boolean; error?: string; hasHealth?: boolean; onRetry?: () => void; onSelectNode: (nodeId: string) => void; limit?: number }) {
  const [all, setAll] = useState(false);
  if (missing) return <p className="text-[12px] px-1" style={{ color: "var(--sol-text-dim)" }}>Health is not deployed on this backend yet.</p>;
  const retry = onRetry ? <button type="button" onClick={onRetry} className="ml-1.5 underline underline-offset-2" style={{ color: "var(--sol-blue)" }}>Retry</button> : null;
  // A read that failed with nothing cached says so; it never reads as a clean company.
  if (error && !hasHealth) return <p className="text-[12px] px-1" style={{ color: "var(--sol-red)" }} data-health-error>Health could not be read: {error}{retry}</p>;
  const stale = error ? <p className="text-[11px] px-1" style={{ color: "var(--sol-yellow)" }} data-health-stale>Showing the last copy; the latest read failed: {error}{retry}</p> : null;
  if (rows.length === 0) return <>{stale}<p className="text-[12px] px-1" style={{ color: "var(--sol-text-dim)" }}>Nothing is flagged. Every role is inside its limits.</p></>;
  const shown = all ? rows : rows.slice(0, limit);
  return (
    <div className="flex flex-col gap-1" data-flags>
      {stale}
      {shown.map((r) => {
        const subject = r.subject.kind === "role" ? `@${r.subject.handle}` : r.subject.kind === "person" ? r.subject.name : "company";
        const m = SEVERITY_META[r.flag.severity];
        const body = (
          <>
            <SeverityDot severity={r.flag.severity} />
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] leading-snug" style={{ color: "var(--sol-text)" }}>
                <span className="font-medium" style={{ color: m.color }}>{FLAG_LABEL[r.flag.code]}</span>
                {m.tag && <span className="ml-1.5 inline-flex items-center h-[15px] px-1 rounded text-[9.5px] font-semibold uppercase tracking-[0.06em] align-[1px]" style={{ background: `color-mix(in srgb, ${m.color} 16%, transparent)`, color: m.color }} data-severity-tag>{m.word}</span>}
                <span style={{ color: "var(--sol-text-dim)" }}> · {subject}</span>
              </span>
              <span className="block text-[11px] leading-snug" style={{ color: "var(--sol-text-muted)" }}>{r.flag.detail}</span>
            </span>
          </>
        );
        return r.subject.kind === "company" ? (
          <div key={r.id} className="flex items-start gap-2 px-1.5 py-1 rounded-md" data-flag={r.flag.code}>{body}</div>
        ) : (
          <button key={r.id} type="button" onClick={() => onSelectNode((r.subject as { nodeId: string }).nodeId)} className="flex items-start gap-2 px-1.5 py-1 rounded-md text-left w-full hover:bg-sol-bg-highlight/70 transition-colors" data-flag={r.flag.code}>{body}</button>
        );
      })}
      {rows.length > limit && (
        <button type="button" onClick={() => setAll((v) => !v)} className="self-start inline-flex items-center gap-1 text-[11px] px-1.5 h-6 rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-dim)" }}>
          {all ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          {all ? "fewer" : `${rows.length - limit} more`}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- health summary

function HealthBody(props: StaffingPaneProps) {
  const { tree, health } = props;
  const flags = useMemo(() => collectHealthFlags(health, tree), [health, tree]);
  const span = useMemo(() => spanOfControl(health, tree), [health, tree]);
  const bottlenecks = useMemo(() => bottleneckRoles(health), [health]);
  const roleById = (id: string) => tree?.roles.find((r) => r._id === id);
  return (
    <>
      <h2 className="text-[19px] leading-tight font-semibold tracking-tight" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}>Company health</h2>
      <p className="mt-1 text-[12px]" style={{ color: "var(--sol-text-muted)" }}>
        {props.reviewing ? "A review of the company is running; a proposal appears here when it lands." : "No open proposal. What the last review sees right now."}
      </p>
      {props.reviewing && props.reviewSessionId && <ReviewSessionLink id={props.reviewSessionId} onOpenSession={props.onOpenSession} />}
      {props.reviewEnded && <ReviewEndedLine sessionId={props.reviewSessionId} onOpenSession={props.onOpenSession} />}
      <SectionLabel right={flags.length > 0 ? <span className="text-[10.5px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{flags.length}</span> : undefined}>Findings</SectionLabel>
      <FlagList rows={flags} missing={props.healthMissing} error={props.healthError} hasHealth={!!props.health} onRetry={props.onRetryHealth} onSelectNode={props.onSelectNode} />

      <SectionLabel>Roles per person</SectionLabel>
      {span.length === 0 ? <p className="text-[12px] px-1" style={{ color: "var(--sol-text-dim)" }}>Nobody here yet.</p> : (
        <div className="flex flex-col gap-1" data-span>
          {span.map((s) => (
            <button key={s.user_id} type="button" onClick={() => props.onSelectNode(s.nodeId)} className="flex items-center gap-2.5 px-1.5 py-1 rounded-md text-left hover:bg-sol-bg-highlight/70 transition-colors">
              <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: "var(--sol-text)" }}>{s.name}</span>
              <span className="w-24 h-[5px] rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--sol-border) 35%, transparent)" }}>
                <span className="block h-full rounded-full" style={{ width: `${Math.min(100, (s.direct_roles / s.limit) * 100)}%`, background: s.wide ? "var(--sol-red)" : "var(--sol-violet)" }} />
              </span>
              <span className="text-[11px] tabular-nums shrink-0" style={{ color: s.wide ? "var(--sol-red)" : "var(--sol-text-dim)" }}>{s.direct_roles} / {s.limit}</span>
            </button>
          ))}
        </div>
      )}

      <SectionLabel>Roles under strain</SectionLabel>
      {bottlenecks.length === 0 ? <p className="text-[12px] px-1" style={{ color: "var(--sol-text-dim)" }}>None. Every role is inside its limits.</p> : (
        <div className="flex flex-col gap-1" data-bottlenecks>
          {bottlenecks.map((b) => (
            <button key={b.role_id} type="button" onClick={() => props.onSelectNode(b.nodeId)} className="flex items-center gap-2 px-1.5 py-1.5 rounded-md text-left hover:bg-sol-bg-highlight/70 transition-colors">
              <span className="inline-flex items-center h-[20px] px-1.5 rounded-md text-[10.5px] font-medium shrink-0" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)", fontFamily: "var(--font-mono)" }}>@{b.handle}</span>
              <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: "var(--sol-text-muted)" }}>{roleById(b.role_id)?.name ?? ""}</span>
              <span className="flex items-center gap-1 shrink-0">
                {b.flags.map((f, i) => {
                  const m = SEVERITY_META[f.severity];
                  return (
                    <span key={i} className="inline-flex items-center gap-1 h-[18px] px-1.5 rounded-md text-[10px]" style={{ background: `color-mix(in srgb, ${m.color} 14%, transparent)`, color: m.color }} title={`${m.word}: ${f.detail}`}>
                      <FlagGlyph className="w-2.5 h-2.5" fill={m.dot === "filled" ? "currentColor" : "none"} />{FLAG_LABEL[f.code]}
                    </span>
                  );
                })}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- no chief of staff

function NoChiefBody(props: StaffingPaneProps) {
  return (
    <div data-no-chief>
      <h2 className="text-[19px] leading-tight font-semibold tracking-tight" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}>No chief of staff yet</h2>
      <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: "var(--sol-text-muted)" }}>
        The chief of staff reads how work flows, proposes the organization as changes on this chart, and reviews it every week. You decide each change; it applies nothing on its own.
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
          <OrgButton primary onClick={props.onHireChief} className="justify-center h-9">
            <UserRoundPlus className="w-3.5 h-3.5" /> Hire a Chief of Staff
          </OrgButton>
          <OrgButton onClick={props.onProposeNow} className="justify-center h-9">
            <Sparkles className="w-3.5 h-3.5" /> Propose an org now
          </OrgButton>
          <p className="text-[11px] leading-snug px-1" style={{ color: "var(--sol-text-dim)" }}>Hiring provisions a standing session and a weekly review. Proposing runs one review from a fresh session without a hire.</p>
        </div>
      )}
      <FlagsPreview {...props} />
    </div>
  );
}

/** A review that stopped with nothing posted: said plainly, with the way in
 *  to see why, above the buttons that start another. */
function ReviewEndedLine({ sessionId, onOpenSession }: { sessionId?: string | null; onOpenSession: (id: string) => void }) {
  return (
    <div className="rounded-lg border px-3 py-2 text-[12px] flex items-center gap-2 flex-wrap" data-review-ended style={{ borderColor: "color-mix(in srgb, var(--sol-orange) 45%, transparent)", background: "color-mix(in srgb, var(--sol-orange) 8%, transparent)", color: "var(--sol-text-secondary)" }}>
      <span className="min-w-0 flex-1">The review session stopped without posting a proposal.</span>
      {sessionId && <button type="button" onClick={() => onOpenSession(sessionId)} className="shrink-0 inline-flex items-center gap-1 hover:underline" style={{ color: "var(--sol-violet)" }}>See why <ExternalLink className="w-3 h-3" /></button>}
    </div>
  );
}

/** The session "Propose an org now" started: a way in while it works, and
 *  the way to see why nothing landed if the review ends without a proposal. */
function ReviewSessionLink({ id, onOpenSession }: { id: string; onOpenSession: (id: string) => void }) {
  return (
    <button type="button" onClick={() => onOpenSession(id)} className="mt-2 inline-flex items-center gap-1 text-[11.5px] px-1.5 h-6 rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-violet)" }} data-review-session>
      Open the review session <ExternalLink className="w-3 h-3" />
    </button>
  );
}

/** With no chief and no proposal, the flags still tell the person something. */
function FlagsPreview(props: StaffingPaneProps) {
  const flags = useMemo(() => collectHealthFlags(props.health, props.tree), [props.health, props.tree]);
  if (flags.length === 0 && !props.healthMissing && !props.healthError) return null;
  return (
    <>
      <SectionLabel>Findings</SectionLabel>
      <FlagList rows={flags} missing={props.healthMissing} error={props.healthError} hasHealth={!!props.health} onRetry={props.onRetryHealth} onSelectNode={props.onSelectNode} limit={3} />
    </>
  );
}

// ---------------------------------------------------------------- composer and thread

/** The chief of staff's standing session, embedded: its composer sends
 *  through the pending message rail and the thread renders below it, the same
 *  component the anchor page uses. The embed carries the rail's own delivery
 *  banners (a line that has not reached the agent, kill and restart), so a
 *  dead session speaks up per message; what the embed cannot know is the
 *  role's own state, so a paused chief is said here, with the way out. */
function Composer({ chief, onOpenSession, onResume }: { chief: OrgRole | null; onOpenSession: (id: string) => void; onResume?: (roleId: string) => void }) {
  const conv = chief?.standing?.conversation_id ?? null;
  const paused = chief?.status === "paused";
  return (
    <div className="mt-6 pt-4 border-t" style={{ borderColor: BORDER }} data-composer>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>Talk to the chief of staff</span>
        {conv && (
          <button type="button" onClick={() => onOpenSession(conv)} className="inline-flex items-center gap-1 text-[11px] px-1.5 h-[20px] rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-violet)" }}>
            Open session <ExternalLink className="w-3 h-3" />
          </button>
        )}
      </div>
      {paused && chief && (
        <div className="mb-2 rounded-lg border px-3 py-2 flex items-center gap-2 text-[12px]" data-chief-paused style={{ borderColor: "color-mix(in srgb, var(--sol-yellow) 45%, transparent)", background: "color-mix(in srgb, var(--sol-yellow) 8%, transparent)", color: "var(--sol-text-secondary)" }}>
          <Pause className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--sol-yellow)" }} />
          <span className="min-w-0 flex-1">Paused: what you send waits until you resume.</span>
          {onResume && <OrgButton size="sm" onClick={() => onResume(chief._id)}><Play className="w-3 h-3" /> Resume</OrgButton>}
        </div>
      )}
      {!chief ? (
        <p className="text-[12px] px-1" style={{ color: "var(--sol-text-dim)" }}>No chief of staff hired yet.</p>
      ) : !conv ? (
        <p className="text-[12px] px-1" style={{ color: "var(--sol-text-dim)" }}>The chief of staff has no standing session yet. It appears here once provisioned.</p>
      ) : (
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: BORDER, height: "min(420px, 45dvh)" }}>
          <AnchorConversation conversationId={conv} hideHeader seedOwnership={false} />
        </div>
      )}
    </div>
  );
}
