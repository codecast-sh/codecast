"use client";
// The Head of People's offer above its composer (docs/architecture/org-staffing.md
// S24): what a person would otherwise type a slash command for, as the role's
// own next step. "Set up the org" before any proposal exists and "Review the
// org now" after, both the Company review trigger run now (the same run the
// Triggers tab and `cast trigger run` start, so it stays one trigger the
// person controls); "Plan the goal tree", that run with a focus; and "Open
// the proposal" while one waits. While a run is in flight the row says so and
// offers nothing that would start a second one; the proposal's card lands in
// the thread itself, where the role posts it.
//
// Store-fed: the trigger from the seat's triggers, the seat's work state from
// the org tree, the proposals from the orgProposals collection. A press is
// the store's triggerAction, so the row moves in the same tick.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowUpRight, Play } from "lucide-react";
import { ORG_REVIEW_FOCUSES } from "@codecast/shared/contracts/orgReview";
import { useInboxStore } from "../../../store/inboxStore";
import { useSyncOrgTree } from "../../../hooks/useSyncOrgTree";
import { useSyncOrgProposals } from "../../../hooks/useSyncOrgProposals";
import { useSeatTriggers } from "../../../hooks/useSyncTriggers";
import { useCollectionRows } from "../../../hooks/useCollectionRows";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { canEditRole } from "../../../lib/scopePage";
import { entityRoute } from "../../../lib/entityLinks";
import { compactAge } from "../../../lib/threadState";
import { cn } from "../../../lib/utils";
import { EntityIdPill } from "../../EntityIdPill";
import { RoleFace } from "../RoleFace";
import { isHeadOfPeopleRole, type OrgProposalListRow } from "../orgStaffingTypes";
import { proposalWorkspace, sameWorkspace } from "../staffingModel";
import type { OrgRole, OrgTree } from "../orgTypes";
import { GOAL_TREE_FOCUS, companyReviewOf, deriveRoleOffer, offerTriggerOf, type RoleOfferInput, type RoleOfferProposal } from "./roleOfferModel";

/** The Head of People whose standing session this conversation is, or null:
 *  the row belongs to that one seat and renders nowhere else. */
export function headOfPeopleSeat(tree: OrgTree | null, conversationId: string | null | undefined): OrgRole | null {
  if (!tree || !conversationId) return null;
  return tree.roles.find((r) => {
    if (!isHeadOfPeopleRole(r) || r.status === "retired") return false;
    const seat = r.standing?.conversation_id ?? (r.anchor_id ? tree.anchors.find((a) => a.anchor_id === r.anchor_id)?.conversation_id : undefined);
    return seat === conversationId;
  }) ?? null;
}

// ---------------------------------------------------------------- the fake seam
// `window.__roleOffer.fake({ trigger, working, proposals })` replaces what the
// row reads, and `fake(null)` clears it, so every state can be looked at on a
// real page without a run being started: while a fake is set a press moves
// the fake and dispatches nothing. The same idea as `window.__faceRow`.
export type RoleOfferFake = Partial<Pick<RoleOfferInput, "trigger" | "working" | "proposals">>;
let fake: RoleOfferFake | null = null;
const fakeListeners = new Set<() => void>();
export function fakeRoleOffer(next: RoleOfferFake | null): void {
  fake = next;
  for (const cb of fakeListeners) cb();
}
const subscribeFake = (cb: () => void) => { fakeListeners.add(cb); return () => { fakeListeners.delete(cb); }; };
const readFake = () => fake;
if (typeof window !== "undefined") (window as any).__roleOffer = { fake: fakeRoleOffer, read: readFake };

// ---------------------------------------------------------------- the row

const proposalSig = (p: OrgProposalListRow) => `${p._id}:${p.status}:${p.created_at}:${p.counts?.decided ?? 0}/${p.counts?.total ?? 0}`;

const CHIP = "inline-flex h-[26px] items-center gap-1.5 rounded-full border px-3 text-[12px] leading-none transition-colors hover:bg-[color-mix(in_srgb,var(--sol-violet)_9%,transparent)] hover:text-sol-text hover:border-[color-mix(in_srgb,var(--sol-violet)_45%,transparent)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sol-violet/50";
const CHIP_STYLE = { borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)", color: "var(--sol-text-muted)" } as const;

function Chip({ children, onClick, lead, ...rest }: { children: React.ReactNode; onClick: () => void; lead?: boolean } & Record<`data-${string}`, string>) {
  return (
    <button type="button" onClick={onClick} className={cn(CHIP, lead && "font-medium")} style={lead ? { ...CHIP_STYLE, color: "var(--sol-text-secondary, var(--sol-text))" } : CHIP_STYLE} {...rest}>
      {children}
    </button>
  );
}

export function RoleOffer({ conversationId }: { conversationId: string | null | undefined }) {
  const { tree } = useSyncOrgTree();
  const role = useMemo(() => headOfPeopleSeat(tree, conversationId), [tree, conversationId]);
  if (!tree || !role || !conversationId) return null;
  return <RoleOfferRow tree={tree} role={role} conversationId={conversationId} />;
}

function RoleOfferRow({ tree, role, conversationId }: { tree: OrgTree; role: OrgRole; conversationId: string }) {
  const now = useCoarseNow(30_000);
  const faked = useSyncExternalStore(subscribeFake, readFake, readFake);
  const tasks = useSeatTriggers(conversationId);
  useSyncOrgProposals();
  const workspace = tree.workspace;
  const inWorkspace = useCallback((p: OrgProposalListRow) => sameWorkspace(proposalWorkspace(p), workspace), [workspace.kind, workspace.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const proposals = useCollectionRows<OrgProposalListRow>("orgProposals", { where: inWorkspace, sig: proposalSig });
  const meId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  // Who may start a run is who may talk to the seat: its host, the person it
  // reports to, an admin. Anyone else reads the state and opens the proposal.
  const me = tree.people.find((p) => p.is_me)?.user_id ?? meId;
  const canAct = canEditRole(tree, role, meId) || (role.reports_to.kind === "user" && role.reports_to.user_id === me);

  const input: RoleOfferInput = useMemo(() => ({
    trigger: offerTriggerOf(companyReviewOf(tasks)),
    working: role.standing?.state === "working",
    proposals: proposals as readonly RoleOfferProposal[],
    now,
    ...(faked ?? {}),
  }), [tasks, role.standing?.state, proposals, now, faked]);
  const offer = deriveRoleOffer(input);

  const act = useCallback((verb: "runNow" | "resume", focus?: string) => {
    const t = input.trigger;
    if (!t) return;
    if (faked) {
      fakeRoleOffer({ ...faked, trigger: verb === "resume" ? { ...t, status: "scheduled" } : { ...t, status: "scheduled", requested: true, run_at: Date.now(), focus: focus ?? null } });
      return;
    }
    useInboxStore.getState().triggerAction(t.id, verb, focus);
  }, [input.trigger, faked]);

  if (offer.kind === "none") return null;
  const openProposal = offer.kind === "offer" ? offer.open : (input.proposals.filter((p) => p.status === "open").sort((a, b) => b.created_at - a.created_at)[0] ?? null);
  const openRow = openProposal ? proposals.find((p) => p._id === openProposal._id) : undefined;
  const toDecide = openRow?.counts ? openRow.counts.total - openRow.counts.decided : 0;
  const openChip = openProposal && (
    <Link href={entityRoute("proposal", openProposal.short_id) ?? "/org"} className={cn(CHIP, "no-underline")} style={CHIP_STYLE} title={openProposal.title} data-offer-open={openProposal.short_id}>
      Open the proposal
      {toDecide > 0 && <span className="text-[11px]" style={{ color: "var(--sol-text-dim)" }}>{toDecide} to decide</span>}
      <ArrowUpRight className="h-3 w-3 opacity-60" />
    </Link>
  );
  const inFlight = offer.kind === "starting" || offer.kind === "reviewing";

  return (
    <div className="relative z-20 bg-sol-bg" data-role-offer={offer.kind}>
      <div className="mx-auto conv-col px-2 sm:px-4 pb-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 pl-1">
          <RoleFace role={role} size={18} className="shrink-0" />
          {inFlight && (
            <span className="inline-flex min-w-0 items-center gap-1.5 text-[12px]" style={{ color: "var(--sol-text-muted)" }} role="status" data-offer-run={offer.kind}>
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full" style={{ background: "var(--sol-violet)" }} aria-hidden />
              <span className="truncate">
                {offer.kind === "starting"
                  ? (offer.focus ? `${offer.focus.label}: starting…` : "Starting the review…")
                  : `${offer.focus ? offer.focus.running : "Reviewing the org"}…`}
              </span>
              {offer.kind === "reviewing" && now - offer.since >= 60_000 && <span className="shrink-0 text-[11px]" style={{ color: "var(--sol-text-dim)" }}>{compactAge(now - offer.since)}</span>}
              {offer.trigger.short_id && <span className="shrink-0"><EntityIdPill shortId={offer.trigger.short_id} compact /></span>}
            </span>
          )}
          {offer.kind === "paused" && (
            <>
              <span className="text-[12px]" style={{ color: "var(--sol-text-muted)" }}>My weekly review is paused.</span>
              {canAct && <Chip onClick={() => act("resume")} data-offer-action="resume"><Play className="h-3 w-3" /> Resume it</Chip>}
            </>
          )}
          {offer.kind === "offer" && openChip}
          {offer.kind === "offer" && canAct && (
            <>
              <Chip lead={!openProposal} onClick={() => act("runNow")} data-offer-action={offer.setUp ? "set-up" : "review"}>{offer.setUp ? "Set up the org" : "Review the org now"}</Chip>
              <Chip onClick={() => act("runNow", GOAL_TREE_FOCUS)} data-offer-action="goal-tree">{ORG_REVIEW_FOCUSES[GOAL_TREE_FOCUS].label}</Chip>
            </>
          )}
          {inFlight && openChip}
        </div>
      </div>
    </div>
  );
}
