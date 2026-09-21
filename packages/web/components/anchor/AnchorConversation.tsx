"use client";

// A standing agent's live conversation, embedded. Used by the slide-over and
// the proposal thread alike — the same store-fed conversation, the same
// composer, so talking to the agent feels identical wherever you open it.

import { ConversationDiffLayout, type ConversationDiffLayoutProps } from "../ConversationDiffLayout";
import type { ConversationData } from "../conversation/types";
import { ProjectPathPicker } from "../ProjectPathPicker";
import { useConversationMessages } from "../../hooks/useConversationMessages";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AnchorGlyph } from "./AnchorIdentity";
import { bootstrapCut, windowConversationSince, type WindowedConversation } from "../../lib/anchorWindow";
import { useSeedOwnership } from "../../hooks/useSeedOwnership";
import { useSyncOrgTree } from "../../hooks/useSyncOrgTree";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { CHIEF_OF_STAFF_NAME } from "../org/orgStaffingTypes";

export function AnchorConversation({ conversationId, hideHeader, seedOwnership = true, onSendOverride, composerNode, autoFocusInput, since, foldBootstrap, foldWorkingTurns, openAtTop, composerPlaceholder, leadNode, leadPinned, stickyPrompt, initialDensity, hideDiff }: {
  conversationId: string;
  hideHeader?: boolean;
  /** The staffing pane owns the send into a proposal's thread (S18). */
  onSendOverride?: ConversationDiffLayoutProps["onSendOverride"];
  composerNode?: React.ReactNode;
  autoFocusInput?: boolean;
  /** A proposal's thread (org-staffing.md S19) is a standing session with a
   *  history from before the proposal: the embed shows what was said from
   *  `since` on, under the host's `leadNode` (the letter), and stops paging
   *  older once the loaded window reaches back past it. */
  since?: number;
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
  /** The slide-over owns the workspace's agent by construction, so it seeds
   *  `is_own` before the row lands and the owner UI paints at once. A thread
   *  embedded elsewhere (the staffing pane's chief of staff, hosted by whoever
   *  hired it) passes false and takes ownership from the row itself. */
  seedOwnership?: boolean;
}) {
  useSeedOwnership(conversationId, seedOwnership);

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
  } = useConversationMessages(conversationId);

  const windowed = useMemo(() => {
    const c = conversation as WindowedConversation | null;
    const cut = foldBootstrap ? bootstrapCut(c) : undefined;
    return windowConversationSince(c, cut !== undefined && (since === undefined || cut > since) ? cut : since);
  }, [conversation, since, foldBootstrap]);

  if (!conversation || !windowed) return <CenteredNote>Loading conversation…</CenteredNote>;

  return (
    <div className="h-full">
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
  const meId = useTrackedStore([(st) => st.currentUser?._id]).currentUser?._id;
  const [project, setProject] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const team = tree?.workspace.kind === "team" ? tree.workspace : null;

  const create = async () => {
    if (!tree || !meId) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await useInboxStore.getState().staffChiefOfStaff({
        ...(team ? { team_id: team.id } : {}),
        ...(project.trim() ? { project_path: project.trim() } : {}),
        host_user_id: String(meId),
        client_id: `orgrolestub-chief-${Math.random().toString(36).slice(2)}`,
      });
      if (r?.role) toast.success(`${r.role.name} is coming online`);
    } catch (e: any) {
      setErr(e?.message ?? "Could not bring the agent online");
      setBusy(false);
    }
  };

  const who = team ? `${team.name}'s agent` : "your agent";
  return (
    <div className={`h-full flex items-center justify-center ${compact ? "px-5" : "px-6"}`}>
      <div className="max-w-md w-full text-center">
        <div className={`mx-auto ${compact ? "w-11 h-11 mb-3" : "w-14 h-14 mb-5"} rounded-2xl bg-sol-cyan/15 flex items-center justify-center`}>
          <AnchorGlyph className={`${compact ? "w-6 h-6" : "w-7 h-7"} text-sol-cyan`} />
        </div>
        <h1 className={`${compact ? "text-base" : "text-xl"} font-semibold tracking-tight mb-2`}>Meet {who}</h1>
        <p className="text-sm text-sol-text-muted mb-5 leading-relaxed">
          {team
            ? `One standing agent every member of ${team.name} can talk to. It sits at the top of the org as ${CHIEF_OF_STAFF_NAME}: it keeps the team's context, runs routines, answers in chat and Slack, reads how work flows and proposes who should own what.`
            : `One standing agent that is yours alone. It sits at the top of your org as ${CHIEF_OF_STAFF_NAME}: it keeps your context, tracks your sessions against your goals, runs the routines you give it, and speaks up when something needs you.`}
        </p>
        <div className="text-left space-y-3">
          <div>
            <span className="text-xs text-sol-text-dim">Project it lives and works in</span>
            <ProjectPathPicker value={project} onChange={setProject} className="mt-1" />
            <span className="text-[11px] text-sol-text-dim/70">
              It runs on your machine at this path. Leave blank to let the daemon pick.
            </span>
          </div>
        </div>
        {err && <div className="text-sol-red text-xs mt-3">{err}</div>}
        <button
          onClick={create}
          disabled={busy || !tree || !meId}
          className="mt-5 w-full bg-sol-cyan text-sol-bg font-medium rounded-lg px-4 py-2.5 text-sm disabled:opacity-60 hover:bg-sol-cyan/90 transition-colors"
        >
          {busy ? "Bringing it online…" : `Hire ${CHIEF_OF_STAFF_NAME}`}
        </button>
        <p className="text-[11px] text-sol-text-dim mt-3">You can rename it and give it a face on its page.</p>
      </div>
    </div>
  );
}
