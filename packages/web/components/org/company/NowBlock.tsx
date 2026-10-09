"use client";
// "Now" on every sheet (cohesive build spec §5.1, D8): what is moving on the
// object this minute. The sessions at work under it in their state colours,
// each decision that waits on the person and is about it, a role that is
// stuck, and one violet line per open proposal change whose subject it is,
// which sends the reader to the card in the conversation. Nothing is
// answered here. With nothing moving the block is not drawn at all.
import { useMemo } from "react";
import { useInboxStore } from "../../../store/inboxStore";
import { useOpenLinkedSession } from "../../../hooks/useOpenLinkedSession";
import { cn } from "../../../lib/utils";
import { StateBar } from "../OrgNodeCards";
import { RoleFace } from "../RoleFace";
import { useOrgAsks } from "../useNeedsYou";
import { workspaceOpenProposals } from "../staffingModel";
import { joinProposals } from "../orgStaffingTypes";
import { countStates, type OrgSession, type OrgTree } from "../orgTypes";
import { asksFor, proposalLinesFor, sessionsLine, type NowSubject } from "./nowModel";

export type { NowSubject } from "./nowModel";
import type { CompanyRows } from "./useCompanyRows";
import { SheetSection } from "./SheetFrame";

/** `lead` says in words what is at work (a role's current session, a
 *  person's work role by role), as NowLines that take the place of the bare
 *  count of `sessions`. */
export function NowBlock({ subject, sessions, rows, lead }: { subject: NowSubject; sessions: readonly OrgSession[]; rows: CompanyRows; lead?: React.ReactNode }) {
  const openLinked = useOpenLinkedSession();
  // The full tree (the screen's feeder keeps it), for the asks' role lookup.
  const fullTree = useInboxStore((s) => s.orgTree) as OrgTree | null;
  const asks = asksFor(useOrgAsks(fullTree), subject);
  const proposalRows = useInboxStore((s) => s.orgProposals);
  const proposalChanges = useInboxStore((s) => s.orgProposalChanges);
  const ws = rows.tree?.workspace;
  const open = useMemo(
    () => (ws ? workspaceOpenProposals(joinProposals(proposalRows, proposalChanges), ws) : []),
    [proposalRows, proposalChanges, ws?.kind, ws?.id], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const keysSig = `${subject.keys.join("|")}#${(subject.users ?? []).join("|")}`;
  const proposals = useMemo(
    () => proposalLinesFor(open, { tree: rows.tree, goals: rows.goals, projects: rows.projects, plans: [], tasks: [] }, subject.keys, subject.users),
    [open, rows, keysSig], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const live = sessionsLine(sessions);
  if (!live && !lead && asks.length === 0 && proposals.length === 0) return null;

  return (
    <SheetSection title="Now">
    <div className="rounded-[9px] border py-0.5 divide-y divide-[color-mix(in_srgb,var(--sol-border)_22%,transparent)]" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)" }} data-sheet-now>
      {lead ?? (live && (
        <NowLine data={{ "data-now-sessions": "" }}>
          <NowBar sessions={sessions} />
          <span className="min-w-0 truncate">{live.line}</span>
        </NowLine>
      ))}
      {asks.map((a) => a.kind === "decision" ? (
        <NowLine key={a.key} wraps onClick={() => openLinked({ _id: a.item.conversationId, updated_at: Date.now() })} data={{ "data-now-decision": a.item.decisionId ?? a.key }}>
          <span className="mt-[5px] w-2 h-2 rounded-full shrink-0" style={{ background: "var(--sol-yellow)" }} aria-hidden />
          <span className="min-w-0 line-clamp-2">{a.item.question} <span style={{ color: "var(--sol-text-dim)" }}>waits on you</span></span>
        </NowLine>
      ) : a.kind === "blocked" ? (
        <NowLine key={a.key} wraps data={{ "data-now-stuck": a.role.short_id }}>
          <span className="mt-[5px] w-2 h-2 rounded-full shrink-0" style={{ background: "var(--sol-red)" }} aria-hidden />
          <span className="min-w-0 line-clamp-2">Stuck: {a.line}</span>
        </NowLine>
      ) : null)}
      {proposals.map(({ proposal, card }) => {
        const author = proposal.author.kind === "role" ? rows.tree?.roles.find((r) => r._id === proposal.author.id || r.short_id === proposal.author.short_id) : undefined;
        return (
          <NowLine key={`${proposal._id}:${card.key}`} violet wraps data={{ "data-now-proposal": `${proposal.short_id}#${card.seqs[0] ?? ""}` }}>
            {author ? <RoleFace role={author} size={16} className="mt-px shrink-0" /> : <span className="mt-[5px] w-2 h-2 rounded-full shrink-0" style={{ background: "var(--sol-violet)" }} aria-hidden />}
            <span className="min-w-0 line-clamp-2" data-now-proposal-words>{proposesSentence(proposal.author.name, card.sentenceThis)}</span>
            <span className="ml-auto shrink-0 pl-2 text-[11.5px] whitespace-nowrap" style={{ color: "var(--sol-violet)" }}>See it ›</span>
          </NowLine>
        );
      })}
    </div>
    </SheetSection>
  );
}

/** The state bar a Now line leads with: the sessions it speaks for, in their state colours. */
export function NowBar({ sessions }: { sessions: readonly OrgSession[] }) {
  return <span className="w-[54px] shrink-0"><StateBar counts={countStates([...sessions])} className="!h-[6px]" /></span>;
}

/** "Head of People proposes to move this goal under the purpose": the card's
 *  own sentence (an imperative, "Move this goal …") after who proposes it. */
const proposesSentence = (author: string | null | undefined, sentence: string): string => {
  const s = sentence.trim().replace(/\.$/, "");
  const lower = /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
  return `${author ?? "A proposal"} proposes to ${lower}`;
};

/** One line of a Now. `wraps`: its words may take two lines, the lead mark
 *  at the top, so the substance is never what gets cut. */
export function NowLine({ children, onClick, violet, wraps, data }: { children: React.ReactNode; onClick?: () => void; violet?: boolean; wraps?: boolean; data?: Record<string, string> }) {
  const cls = cn("w-full flex gap-2.5 px-[11px] py-[7px] text-left text-[12.5px]", wraps ? "items-start leading-[1.4]" : "items-center", onClick && "hover:bg-sol-bg-highlight/50 transition-colors");
  const style = { color: "var(--sol-text-secondary)", ...(violet ? { background: "color-mix(in srgb, var(--sol-violet) 9%, transparent)" } : {}) };
  return onClick
    ? <button type="button" onClick={onClick} className={cls} style={style} {...data}>{children}</button>
    : <div className={cls} style={style} {...data}>{children}</div>;
}
