"use client";

// A standing agent's live conversation, embedded. The slide-over and the org
// screen mount the same store-fed conversation and the same composer, so
// talking to the agent feels identical wherever you open it.

import { ConversationDiffLayout, type ConversationDiffLayoutProps } from "../ConversationDiffLayout";
import { Button } from "../ui/button";
import type { ConversationData } from "../conversation/types";
import { ProjectPathPicker } from "../ProjectPathPicker";
import { useConversationMessages } from "../../hooks/useConversationMessages";
import { useCallback, useMemo, useRef, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { toast } from "sonner";
import { HeadOfPeopleFace } from "./AnchorIdentity";
import { bootstrapCut, windowConversationSince, type WindowedConversation } from "../../lib/anchorWindow";
import { useSeedOwnership } from "../../hooks/useSeedOwnership";
import { useSyncOrgTree } from "../../hooks/useSyncOrgTree";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { HEAD_OF_PEOPLE_NAME } from "../org/orgStaffingTypes";
import { EXECUTIVE_ASSISTANT_HANDLE, EXECUTIVE_ASSISTANT_NAME } from "@codecast/shared/contracts/orgLead";
import { RoleFace } from "../org/RoleFace";
import type { HireAssistantResult } from "../../store/orgSlice";
import { findProposalCardMessage, type JumpRequest } from "../org/orgScreenModel";
import { useAnchorSpace } from "../../hooks/useSyncAnchorSpace";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { hireAssistantLedger, hireHeadLedger } from "../consequential/roleOnline";

/** How many newer pages a time jump reads while looking for its card. */
const FIND_PAGES_MAX = 4;

export function AnchorConversation({ conversationId, hideHeader, seedOwnership = true, onSendOverride, composerNode, autoFocusInput, foldBootstrap, foldWorkingTurns, openAtTop, composerPlaceholder, leadNode, leadPinned, stickyPrompt, initialDensity, hideDiff, jump }: {
  conversationId: string;
  hideHeader?: boolean;
  /** The staffing pane owns the send into a proposal's thread (S18). */
  onSendOverride?: ConversationDiffLayoutProps["onSendOverride"];
  composerNode?: React.ReactNode;
  autoFocusInput?: boolean;
  /** A standing session opens on its provisioning prompt: the seat's own
   *  system text, sent by the host as the first message. The scope page
   *  (scopes-and-feed.md F4.1) folds it away so the page opens on the agent
   *  talking to the person; the cut is the first message after it. */
  foldBootstrap?: boolean;
  /** The conversation as the agent talking to the person (ConversationView
   *  foldWorkingTurns): working turns and machine prompts fold away. */
  foldWorkingTurns?: boolean;
  openAtTop?: ConversationDiffLayoutProps["openAtTop"];
  composerPlaceholder?: ConversationDiffLayoutProps["composerPlaceholder"];
  leadNode?: ConversationDiffLayoutProps["leadNode"];
  leadPinned?: ConversationDiffLayoutProps["leadPinned"];
  stickyPrompt?: ConversationDiffLayoutProps["stickyPrompt"];
  initialDensity?: ConversationDiffLayoutProps["initialDensity"];
  hideDiff?: boolean;
  /** The host's scroll-to request (org-staffing.md S41): a message to land on,
   *  or a timestamp to centre the window on when the message is not loaded,
   *  with `find` naming the proposal whose card is then looked for in the
   *  window. A new nonce is a new request, so the same card can be asked for
   *  twice. A send ends the request: the person's own bubble lands on the
   *  live tail, which the target window would never show. */
  jump?: JumpRequest | null;
  /** The slide-over owns the workspace's agent by construction, so it seeds
   *  `is_own` before the row lands and the owner UI paints at once. A thread
   *  embedded elsewhere (the staffing pane's head of people, hosted by whoever
   *  hired it) passes false and takes ownership from the row itself. */
  seedOwnership?: boolean;
}) {
  useSeedOwnership(conversationId, seedOwnership);

  // The request a send has ended; the host keeps its own until the next one.
  const [endedNonce, setEndedNonce] = useState<number | null>(null);
  const request = jump && jump.nonce !== endedNonce ? jump : null;
  const {
    conversation,
    hasMoreAbove,
    hasMoreBelow,
    isLoadingOlder,
    isLoadingNewer,
    loadOlder,
    loadNewer,
    jumpToStart,
    jumpToEnd,
    jumpToTimestamp,
    targetMode,
  } = useConversationMessages(conversationId, request?.messageId, undefined, undefined, request?.nonce);
  // The thread settled on the request's row: the host lands on what it wanted
  // inside it, once per nonce (the layout can settle the same target again
  // when its window re-renders) and never for a request already replaced.
  const requestRef = useRef(request);
  requestRef.current = request;
  const settledNonce = useRef<number | null>(null);
  const onTargetSettled = useCallback((_messageId: string, nonce: number | undefined) => {
    const r = requestRef.current;
    if (!r || nonce !== r.nonce || settledNonce.current === r.nonce) return;
    settledNonce.current = r.nonce;
    r.onSettled?.();
  }, []);

  // A request with no message id lands on the time instead.
  useWatchEffect(() => {
    if (request && request.timestamp !== undefined && !request.messageId) jumpToTimestamp(request.timestamp);
  }, [request?.nonce]);
  // The card the request named, once its message is in the window the hook
  // holds: the layout then lands on that row under the same nonce. The hook
  // itself is not re-armed, which would start a second around-window read.
  const found = useMemo(() => request?.find && !request.messageId ? findProposalCardMessage(conversation?.messages, request.find) : null, [conversation?.messages, request?.find, request?.messageId]);
  const targetMessageId = request?.messageId ?? found ?? undefined;
  // The window around the time landed without the card (the author wrote
  // many rows between the proposal and its card): page newer, a few times,
  // until it is in the window or the pages run out.
  const pagedFor = useRef<{ nonce: number; pages: number }>({ nonce: -1, pages: 0 });
  useWatchEffect(() => {
    if (!request?.find || request.messageId || found || !conversation?.messages?.length || isLoadingNewer || !hasMoreBelow) return;
    if (pagedFor.current.nonce !== request.nonce) pagedFor.current = { nonce: request.nonce, pages: 0 };
    if (pagedFor.current.pages >= FIND_PAGES_MAX) return;
    pagedFor.current.pages += 1;
    loadNewer();
  }, [request?.nonce, found, conversation?.messages?.length, isLoadingNewer, hasMoreBelow]);
  // A message the person sends from here: leave the target window for the
  // live tail, where the bubble and the reply land.
  const pendingCount = useInboxStore((s) => s.pendingMessages[conversationId]?.length ?? 0);
  const seenPending = useRef(pendingCount);
  useWatchEffect(() => {
    const grew = pendingCount > seenPending.current;
    seenPending.current = pendingCount;
    if (grew && request) { setEndedNonce(request.nonce); jumpToEnd(); }
  }, [pendingCount]);

  const windowed = useMemo(() => {
    const c = conversation as WindowedConversation | null;
    return windowConversationSince(c, foldBootstrap ? bootstrapCut(c) : undefined);
  }, [conversation, foldBootstrap]);

  if (!conversation || !windowed) return <CenteredNote>Loading conversation…</CenteredNote>;

  return (
    // The thread is live (new messages land) or a window around a target: a
    // host or a check reads which from the root.
    <div className="h-full" data-conv-target-mode={targetMode ? "target" : "live"}>
      <ConversationDiffLayout
        conversation={windowed.conversation as unknown as ConversationData}
        embedded
        hasMoreAbove={hasMoreAbove && !windowed.reachedStart}
        hasMoreBelow={hasMoreBelow}
        isLoadingOlder={isLoadingOlder}
        isLoadingNewer={isLoadingNewer}
        onLoadOlder={loadOlder}
        onLoadNewer={loadNewer}
        onJumpToStart={jumpToStart}
        onJumpToEnd={jumpToEnd}
        onJumpToTimestamp={jumpToTimestamp}
        targetMessageId={targetMessageId}
        targetNonce={request?.nonce}
        onTargetSettled={onTargetSettled}
        isOwner={seedOwnership || !!(conversation as { is_own?: boolean }).is_own}
        showMessageInput
        hideHeader={hideHeader}
        onSendOverride={onSendOverride}
        composerNode={composerNode}
        autoFocusInput={autoFocusInput}
        leadNode={leadNode}
        leadPinned={leadPinned}
        stickyPrompt={stickyPrompt}
        initialDensity={initialDensity}
        foldWorkingTurns={foldWorkingTurns}
        openAtTop={openAtTop}
        composerPlaceholder={composerPlaceholder}
        hideDiff={hideDiff}
      />
    </div>
  );
}

export function CenteredNote({ children }: { children: React.ReactNode }) {
  return <div className="h-full flex items-center justify-center text-sol-text-dim text-sm px-6 text-center">{children}</div>;
}

/** The workspace has no standing agent yet: pick where it lives and bring it
 *  online. Creating one is seating the workspace's root role (org-staffing.md
 *  S22), the same hire the org page makes, so the agent is born with a name,
 *  a face, a charter and its place on the chart. `compact` fits the
 *  slide-over; the page uses the full form. */
export function AnchorOnboarding({ compact }: { compact?: boolean }) {
  const { tree } = useSyncOrgTree();
  // A personal workspace's agent is the person's global Executive Assistant
  // (org-staffing.md S30); a team's is its Head of People.
  if (tree && tree.workspace.kind !== "team") return <HireAssistantCard compact />;
  return <HireHeadOfPeopleCard compact />;
}

/** Hire the Head of People through the staff path (org-staffing.md S6): the
 *  onboarding card, and the built-in entry at the top of the hire gallery.
 *  `onHired` lets a dialog close once the seat is online. */
export function HireHeadOfPeopleCard({ compact, onHired }: { compact?: boolean; onHired?: () => void }) {
  const { tree } = useSyncOrgTree();
  const meId = useTrackedStore([(st) => st.currentUser?._id]).currentUser?._id;
  const [project, setProject] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const team = tree?.workspace.kind === "team" ? tree.workspace : null;
  // Hiring starts an agent and its first review: one confirmed press through the shared review.
  const [reviewing, setReviewing] = useState(false);
  const me = useTrackedStore([(st) => st.currentUser?.name]).currentUser as { name?: string } | undefined;
  const { space } = useAnchorSpace(team ? "team" : "user", team?.id);
  const seats = (space?.anchor?.bot_name as string | undefined) ?? (space?.anchor ? "The standing agent" : null);
  const ledger = hireHeadLedger({ workspace: tree?.workspace.name ?? "This workspace", host: me?.name || "Your", seats });

  const create = async () => {
    if (!tree || !meId) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await useInboxStore.getState().staffHeadOfPeople({
        ...(team ? { team_id: team.id } : {}),
        ...(project.trim() ? { project_path: project.trim() } : {}),
        host_user_id: String(meId),
        client_id: `orgrolestub-head-${Math.random().toString(36).slice(2)}`,
      });
      // The page swaps to the role's page when the tree gains the root; a
      // seat that already stood (a client whose rows were behind) has nothing
      // to wait for, so say so rather than sit on "Bringing it online".
      if (r?.already_existed) toast.success(`${r.role?.name ?? HEAD_OF_PEOPLE_NAME} is already online`);
      else if (r?.role) toast.success(`${r.role.name} is coming online`);
      if (r) onHired?.();
    } catch (e: any) {
      setErr(e?.message ?? "Could not bring the agent online");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`h-full flex items-center justify-center ${compact ? "px-5" : "px-6"}`}>
      <div className="max-w-md w-full text-center">
        <div className={`mx-auto ${compact ? "mb-3" : "mb-5"} flex items-center justify-center`}>
          <HeadOfPeopleFace size={compact ? 44 : 56} />
        </div>
        <h1 className={`${compact ? "text-base" : "text-xl"} font-semibold tracking-tight mb-1.5`}>{HEAD_OF_PEOPLE_NAME}</h1>
        <p className="text-sm text-sol-text-muted mb-5">Proposes who owns what. You approve each change.</p>
        <label className="block text-left">
          <span className="text-xs text-sol-text-dim">Runs in</span>
          <ProjectPathPicker value={project} onChange={setProject} className="mt-1" />
        </label>
        {err && <div className="text-sol-red text-xs mt-3">{err}</div>}
        <Button
          variant="cyan"
          size="lg"
          onClick={() => setReviewing(true)}
          disabled={busy || !tree || !meId}
          className="mt-5 w-full rounded-lg"
          aria-haspopup="dialog"
          data-hire-head
        >
          {busy ? "Bringing it online…" : `Hire ${HEAD_OF_PEOPLE_NAME}`}
        </Button>
        {reviewing && <SwitchReview ledger={ledger} onClose={() => setReviewing(false)} onConfirm={() => { setReviewing(false); void create(); }} />}
      </div>
    </div>
  );
}

/** Hire an Executive Assistant (org-staffing.md S30): the person's right hand,
 *  named, global by default; a team's, or the person's own for one team,
 *  when asked. The seat lands through the anchors feed and becomes the
 *  header's default pin. `compact` fits the slide-over. */
export function HireAssistantCard({ compact, onHired }: { compact?: boolean; onHired?: (r: HireAssistantResult) => void }) {
  const { tree } = useSyncOrgTree();
  const team = tree?.workspace.kind === "team" ? tree.workspace : null;
  const [name, setName] = useState("");
  const [reach, setReach] = useState<"global" | "team" | "personal_team">("global");
  const [project, setProject] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Hiring starts an agent: one confirmed press through the shared review.
  const [reviewing, setReviewing] = useState(false);
  const me = useTrackedStore([(st) => st.currentUser?.name]).currentUser as { name?: string } | undefined;
  const reachWords = reach === "global" || !team ? "All your workspaces" : reach === "team" ? `${team.name}, shared with the team` : `${team.name}, yours alone`;
  const ledger = hireAssistantLedger({ name: name.trim() || EXECUTIVE_ASSISTANT_NAME, reach: reachWords, host: me?.name || "Your" });

  const hire = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await useInboxStore.getState().hireExecutiveAssistant({
        reach: reach === "global" || !team ? { reach: "global" } : { reach: "team", team_id: team.id },
        ...(reach === "personal_team" ? { personal: true } : {}),
        ...(name.trim() ? { given_name: name.trim() } : {}),
        ...(project.trim() ? { project_path: project.trim() } : {}),
      });
      if (r?.already_existed) toast.success(`${r.role.given_name} is already online`);
      else if (r?.role) toast.success(`${r.role.given_name} is coming online as your ${EXECUTIVE_ASSISTANT_NAME}`);
      if (r) onHired?.(r);
    } catch (e: any) {
      setErr(e?.message ?? "Could not hire an Executive Assistant");
    } finally {
      setBusy(false);
    }
  };

  const Option = ({ value, label, hint }: { value: typeof reach; label: string; hint: string }) => (
    <label className={`flex items-start gap-2 rounded-md border px-2.5 py-2 cursor-pointer ${reach === value ? "border-sol-cyan/50 bg-sol-cyan/5" : "border-sol-border/60 hover:bg-sol-bg-highlight/40"}`} data-assistant-reach={value}>
      <input type="radio" name="assistant-reach" className="mt-[3px]" checked={reach === value} onChange={() => setReach(value)} />
      <span className="min-w-0">
        <span className="block text-[12.5px] font-medium">{label}</span>
        <span className="block text-[11px] text-sol-text-dim leading-snug">{hint}</span>
      </span>
    </label>
  );

  return (
    <div className={`h-full flex items-center justify-center ${compact ? "px-5" : "px-6"}`} data-hire-assistant>
      <div className="max-w-md w-full">
        <div className={`mx-auto ${compact ? "mb-3" : "mb-5"} flex items-center justify-center`}>
          <RoleFace role={{ handle: EXECUTIVE_ASSISTANT_HANDLE, avatar: null, name: EXECUTIVE_ASSISTANT_NAME }} size={compact ? 44 : 56} />
        </div>
        <h1 className={`${compact ? "text-base" : "text-xl"} font-semibold tracking-tight mb-2 text-center`}>Hire your {EXECUTIVE_ASSISTANT_NAME}</h1>
        <p className="text-sm text-sol-text-muted mb-4 leading-relaxed text-center">
          Your right hand: it keeps your focus in view, answers anything, sends what a lead owns to that lead, and brings every decision with a recommendation. It lives here in the header, on every page.
        </p>
        <div className="space-y-3">
          <div>
            <span className="text-xs text-sol-text-dim">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada" maxLength={24} className="mt-1 w-full rounded-md border border-sol-border/60 bg-sol-bg px-2.5 py-1.5 text-sm" data-assistant-name />
            <span className="text-[11px] text-sol-text-dim/70">Leave blank and it picks one to match its face.</span>
          </div>
          <div className="space-y-1.5">
            <Option value="global" label="Across all your workspaces" hint="Yours alone. Sees what you see, everywhere you work." />
            {team && <Option value="team" label={`For ${team.name}, shared with the team`} hint="Every member can talk to it; it answers in chat and Slack." />}
            {team && <Option value="personal_team" label={`For ${team.name}, yours alone`} hint="Your own assistant for this team's work." />}
          </div>
          <div>
            <span className="text-xs text-sol-text-dim">Project it lives and works in</span>
            <ProjectPathPicker value={project} onChange={setProject} className="mt-1" />
          </div>
        </div>
        {err && <div className="text-sol-red text-xs mt-3">{err}</div>}
        <Button variant="cyan" size="lg" onClick={() => setReviewing(true)} disabled={busy || !tree} className="mt-4 w-full rounded-lg" aria-haspopup="dialog" data-assistant-hire>
          {busy ? "Bringing it online…" : `Hire ${EXECUTIVE_ASSISTANT_NAME}`}
        </Button>
        {reviewing && <SwitchReview ledger={ledger} onClose={() => setReviewing(false)} onConfirm={() => { setReviewing(false); void hire(); }} />}
      </div>
    </div>
  );
}
