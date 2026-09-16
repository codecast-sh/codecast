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
import { ArrowRight, Check, ChevronDown, ChevronRight, ClipboardCheck, CornerDownRight, ExternalLink, Flag as FlagGlyph, ListChecks, Pause, Pencil, Play, Sparkles, Undo2, UserRoundPlus, X } from "lucide-react";
import { ORG_SYNC_KINDS } from "@codecast/shared/contracts/orgProposal";
import { compactAge } from "../../lib/threadState";
import { cn } from "../../lib/utils";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { AnchorConversation } from "../anchor/AnchorConversation";
import { OrgButton } from "./OrgButton";
import { ProposalAuthorPill } from "./ProposalAuthorPill";
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
  type ChangeField,
  type HealthFlagRow,
  type SyncGroupSummary,
} from "./staffingModel";

export type StaffingPaneProps = {
  tree: OrgTree | null;
  health: OrgHealth | null;
  /** org.health is not deployed on this backend yet. */
  healthMissing?: boolean;
  proposals: OrgProposalRow[];
  /** The proposal open in the pane; null = the health summary. */
  proposal: OrgProposalRow | null;
  /** The change the chart is focused on (the `orgFocusChangeId` scalar). */
  selectedChangeId: string | null;
  chief: OrgRole | null;
  /** "Propose an org now" is running and no proposal has landed yet. */
  reviewing: boolean;
  /** The session "Propose an org now" started, while it is reviewing. */
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
  /** A `?proposal=op-N` link that does not resolve in the active workspace
   *  (staffingModel.resolveProposalLink): the pane is that one line, with a
   *  switch when the proposal lives in a workspace the viewer can open. The
   *  active workspace's own body would answer a question nobody asked. */
  link?: ProposalLinkLine;
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
      {mode !== "no_chief" && <Composer chief={props.chief} onOpenSession={props.onOpenSession} onResume={props.onResumeChief} />}
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
  return (
    <>
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
      {proposal.summary_md && (
        <div className="mt-3 text-[12.5px] leading-relaxed" style={{ color: "var(--sol-text-secondary)" }}>
          <MarkdownRenderer content={proposal.summary_md} />
        </div>
      )}

      {/* changes: the pane's job in this mode, so they come first */}
      <SectionLabel right={progress.remaining > 0 ? <span className="text-[10.5px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{progress.remaining} to decide</span> : undefined}>Changes</SectionLabel>
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
              <div className="sticky top-0 z-[1] text-[10px] font-medium uppercase tracking-[0.08em] py-1 px-1" style={{ color: "var(--sol-text-dim)", background: "var(--sol-bg)" }}>{g.label}</div>
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
                Apply the {progress.remaining} remaining changes now, in the apply order: the records first, then projects, filings, roles, charters, then moves, scope, budget, trust, routines, adopt and retire. Each applies as proposed{progress.failed > 0 ? `; the ${progress.failed} failed ${progress.failed === 1 ? "one is" : "ones are"} retried` : ""}.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button type="button" onClick={() => { setConfirmAll(false); props.onAcceptAll(proposal._id); }} className="h-7 px-3 rounded-md text-[12px] font-semibold" style={{ background: "var(--sol-cyan)", color: "var(--sol-bg)" }}>Accept {progress.remaining}</button>
                <button type="button" onClick={() => setConfirmAll(false)} className="h-7 px-3 rounded-md text-[12px]" style={{ color: "var(--sol-text-muted)" }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* flags: the ones this proposal addresses; the company's full list one click away */}
      <SectionLabel right={flagRows.length > 0 ? <span className="text-[10.5px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{flagRows.length}</span> : undefined}>{allFlags ? "All flags" : "Flags this proposal addresses"}</SectionLabel>
      {props.healthMissing ? (
        <FlagList rows={[]} missing onSelectNode={props.onSelectNode} />
      ) : (
        <>
          {flagRows.length === 0 ? (
            <p className="text-[12px] px-1" style={{ color: "var(--sol-text-dim)" }}>{flags.length === 0 ? "No flags. The company is inside the capacity model." : "No flag names a role this proposal touches."}</p>
          ) : (
            <FlagList rows={flagRows} onSelectNode={props.onSelectNode} limit={allFlags ? 5 : 3} />
          )}
          {flags.length > related.length && (
            <button type="button" onClick={() => setAllFlags((v) => !v)} className="mt-1 self-start inline-flex items-center gap-1 text-[11px] px-1.5 h-6 rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-violet)" }} data-all-flags={allFlags}>
              {allFlags ? "Only this proposal's flags" : `See all ${flags.length} flags in the company`}
            </button>
          )}
        </>
      )}
    </>
  );
}

function Dot() {
  return <span style={{ color: "var(--sol-text-dim)" }}>·</span>;
}

/** One block per change, coloured by status, in list order: the "N of M" as
 *  a strip. A real control: each block is a button named by its change, so
 *  the strip is reachable by keyboard and read by a screen reader. */
function ProgressStrip({ changes, selectedId, onPick }: { changes: OrgProposalChange[]; selectedId: string | null; onPick: (id: string) => void }) {
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
function ChangeRow({ change, tree, nested, selected, editing, onPick, onAccept, onSkip, onEdit, onCancelEdit, onAcceptWithEdits }: {
  change: OrgProposalChange; tree: OrgTree | null; selected: boolean; editing: boolean;
  /** Task changes this plan change closes along with the plan (S9): shown
   *  under the row, applied by the plan's own accept. */
  nested?: OrgProposalChange[];
  onPick: () => void; onAccept: () => void; onSkip: () => void; onEdit: () => void; onCancelEdit: () => void; onAcceptWithEdits: (edits: Record<string, unknown>) => void;
}) {
  const open = isDecidable(change.status);
  const failed = change.status === "failed";
  // S10: a role change says whether the seat is standing or a program with
  // its end. S9: a record change says what the evidence is, on the row itself.
  const tenure = tenureLine(changeTenure(change), tree);
  const evidence = syncEvidence(change.change);
  return (
    <div className={cn("rounded-lg border transition-colors", selected ? "bg-sol-bg-highlight/70" : "hover:bg-sol-bg-highlight/40")} style={{ borderColor: selected ? "color-mix(in srgb, var(--sol-violet) 45%, transparent)" : "transparent" }} data-change-row={change._id} data-change-status={change.status}>
      <div className="flex items-start gap-2 px-2 py-1.5">
        <button type="button" onClick={onPick} className="flex-1 min-w-0 flex items-start gap-2 text-left" aria-pressed={selected} aria-expanded={selected}>
          <StatusPill status={change.status} />
          <span className="min-w-0 flex-1">
            <span className={cn("block text-[12.5px] leading-snug", selected ? "break-words" : "line-clamp-2", change.status === "skipped" && "line-through opacity-60")} style={{ color: "var(--sol-text)" }} title={changeLine(change.change)}>{changeLine(change.change)}</span>
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
            <div className="mt-2.5 flex items-center gap-1.5" data-verdicts>
              <OrgButton primary size="sm" onClick={onAccept} aria-label="Accept"><Check className="w-3 h-3" /> {failed ? "Retry" : "Accept"}</OrgButton>
              <OrgButton size="sm" onClick={onEdit} aria-label="Edit"><Pencil className="w-3 h-3" /> Edit</OrgButton>
              <OrgButton size="sm" onClick={onSkip} aria-label="Skip"><X className="w-3 h-3" /> Skip</OrgButton>
            </div>
          )}
        </div>
      )}
      {editing && open && <EditChangeForm change={change} onCancel={onCancelEdit} onAccept={onAcceptWithEdits} />}
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
      <p className="mt-1 text-[11.5px] leading-snug" style={{ color: "var(--sol-text-muted)" }}>Records the evidence says are already finished. They apply through the same update paths a person uses, and count nothing against a seat once in line.</p>
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
          <p className="text-[12px]" style={{ color: "var(--sol-text-secondary)" }}>Bring the {summary.remaining} remaining records in line now: {summary.countLine}. Each applies as proposed; the rest of the proposal waits for you.</p>
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

function FlagList({ rows, missing, onSelectNode, limit = 5 }: { rows: HealthFlagRow[]; missing?: boolean; onSelectNode: (nodeId: string) => void; limit?: number }) {
  const [all, setAll] = useState(false);
  if (missing) return <p className="text-[12px] px-1" style={{ color: "var(--sol-text-dim)" }}>Health is not deployed on this backend yet.</p>;
  if (rows.length === 0) return <p className="text-[12px] px-1" style={{ color: "var(--sol-text-dim)" }}>No flags. The company is inside the capacity model.</p>;
  const shown = all ? rows : rows.slice(0, limit);
  return (
    <div className="flex flex-col gap-1" data-flags>
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
        {props.reviewing ? "The chief of staff is reviewing the company; a proposal appears here when it lands." : "No open proposal. What the flow signals say right now."}
      </p>
      {props.reviewing && props.reviewSessionId && <ReviewSessionLink id={props.reviewSessionId} onOpenSession={props.onOpenSession} />}
      <SectionLabel right={flags.length > 0 ? <span className="text-[10.5px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{flags.length}</span> : undefined}>Flags</SectionLabel>
      <FlagList rows={flags} missing={props.healthMissing} onSelectNode={props.onSelectNode} />

      <SectionLabel>Span of control</SectionLabel>
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

      <SectionLabel>Bottleneck roles</SectionLabel>
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
  if (flags.length === 0 && !props.healthMissing) return null;
  return (
    <>
      <SectionLabel>Flags</SectionLabel>
      <FlagList rows={flags} missing={props.healthMissing} onSelectNode={props.onSelectNode} limit={3} />
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
