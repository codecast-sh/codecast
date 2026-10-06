import React, { useCallback, useMemo, useRef, memo } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { toast } from "sonner";
import { withSafetyBlock, isHostedAgentType } from "@codecast/shared/contracts";
import { lastNoticeKind } from "../../lib/hostedNotice";
import { imageBytes } from "../../lib/imageByteCache";
import { compressImage } from "../../lib/compressImage";
import { threadStateView } from "../../lib/threadState";
import { sessionIdleAt, sessionLiveAt } from "../../lib/liveness";
import { sessionPanePath, startPaneDrag } from "../../lib/stage";
import { roleLookingAfter } from "../../lib/sessionIdentity";
import { useInboxStore, useTrackedStore, convHasPendingSend, resolveSessionAuthor, showsBlockedBadge, type InboxSession, type SessionRoleSnapshot } from "../../store/inboxStore";
import { useNowWhen } from "../../hooks/useCoarseNow";
import { latestRestartRow, restartPending } from "../../lib/sessionCommands";
import { useAckAssignment } from "../../hooks/useAckAssignment";
import { memberListSig, rosterIdentity } from "../../hooks/useTeamRoster";
import { anchorIdentitySig, anchorIdentityFromSig } from "../../hooks/useSyncAnchors";
import { viewersOf, viewersSig } from "../presence/memberPresence";
import { rosterDeviceOf, deviceWakesOnUse } from "../DeviceBadge";
import { useTipActions, checkMilestone } from "../../tips";
import { formatIdleDuration } from "../../lib/sessionCard";
import { SessionCardView, type SessionCardChrome, type SessionCardViewProps } from "./SessionCardView";
import { useInboxSelection } from "../../lib/inboxSelection";
import { useSurface } from "../../lib/surfaces";
import { showsAgentIcon } from "../simple/lanePaths";

// The inbox session card's container: the store, the clock, the mutations and
// every action a gesture reaches. It renders SessionCardView, which draws.

// The card's store reads as pure projections, so they can be BOTH a dep of the
// card's single subscription and the value it renders (ct-49746).

/** The card-chrome toggles the row draws, as one string. */
function cardChromeSig(clientState: any): string {
  const ui = clientState?.ui;
  return `${ui?.show_model_badge === true ? 1 : 0}${showsAgentIcon(ui) ? 1 : 0}${ui?.inbox_image_thumbs === true ? 1 : 0}${ui?.personify_sessions === true ? 1 : 0}${ui?.show_branch_pill !== false ? 1 : 0}`;
}

/** Visible-child parent link: the parent's title, so the card wakes on that
 *  string and never on the parent row's own churn. */
function spawnedByTitleOf(s: any, spawnedById: string | null): string | null {
  if (!spawnedById) return null;
  return (s.sessions[spawnedById]?.title || (s.conversations[spawnedById] as any)?.title) ?? null;
}

/** The conversation row's authorship fields only — the whole row's identity
 *  flips on every liveness tick. */
function convAuthorSig(conv: any): string | null {
  const c = conv as any;
  if (!c) return null;
  return `${c.user_id ?? ""}\u0000${c.is_own === undefined ? "" : c.is_own ? "1" : "0"}\u0000${c.acting_user_id ?? ""}\u0000${c.user?.name ?? ""}\u0000${c.user?.email ?? ""}\u0000${c.user?.avatar_url ?? ""}`;
}

// The role a standing session rides (S28): the snapshot on the parent's own
// standing row, found by the pointer the row carries. Read once per render
// from the store; the aria text is all it feeds.
function leadRoleOf(session: { org_role_id?: string | null; standing_role_id?: string | null }): SessionRoleSnapshot | null {
  if (!session.standing_role_id || !session.org_role_id) return null;
  const rows = useInboxStore.getState().sessions;
  for (const id in rows) {
    const r = rows[id];
    if (r.standing_role_id && String(r.standing_role_id) === String(session.org_role_id) && r.role) return r.role;
  }
  return null;
}

// Store actions the card reaches, the same for every card.
const toggleFavorite = (id: string) => useInboxStore.getState().toggleFavorite(id);
const openLabels = (session: InboxSession) =>
  useInboxStore.getState().openPalette({ targets: [session], targetType: "session", mode: "bucket" });
const openComments = (id: string) => {
  const st = useInboxStore.getState();
  st.requestNavigate(id, { source: "gesture" });
  st.setCommentRailOpen(true);
};
const toggleSelect = (id: string) => useInboxSelection.getState().toggle(id);
const paneDragStart = (sessionId: string) => (e: React.DragEvent, title: string) =>
  startPaneDrag(e, { path: sessionPanePath(sessionId), title });

export type SessionCardProps = Pick<
  SessionCardViewProps,
  | "session" | "isActive" | "isParentActive" | "isSelected" | "isUnread" | "isFavorite" | "sessionLabel"
  | "variant" | "forkColorKey" | "subRow" | "roleSessions"
  | "onSelect" | "onDismiss" | "onDefer" | "onRestore" | "onKill" | "onNavigateToSession" | "onCardContextMenu" | "onPickCharacter"
> & {
  globalIndex: number;
  onStash?: (id: string) => void;
  onPin?: (id: string) => void;
};

export const SessionCard = memo(function SessionCard({
  session: row,
  onStash,
  onPin,
  onNavigateToSession,
  globalIndex: _globalIndex,
  ...rest
}: SessionCardProps) {
  // Applied here as well as in the view: the clock signature below reads the
  // blocked chip, which a safety block turns on.
  const session = withSafetyBlock(row);
  const tipActions = useTipActions();
  const spawnedById = session.spawned_by_conversation_id || null;
  const anchorId = session.is_anchor ? (session.anchor_id ?? null) : null;
  const deviceId = session.owner_device_id;
  const hasDraft = !!session._hasDraft;
  const cardId = session._id;
  const hosted = isHostedAgentType(session.agent_type);
  // ONE subscription for the whole card (ct-49746). Every value below used to be
  // its own useInboxStore/hook subscription — 13 of them, so a sidebar showing 75
  // rows held ~1000 subscriptions and zustand ran ~1000 selectors on every
  // publish. The deps are the same narrow projections as before, so the card
  // still wakes on exactly the fields it draws and on nothing else; only the
  // number of subscribers changed. Same pattern as SessionListPanel.
  const st = useTrackedStore([
    (s) => s.blockedReviveRequestedAt[cardId],
    (s) => convHasPendingSend(s.pendingMessages[cardId]),
    // This row's restart, from the one sessionCommands home (small: one row
    // per commanded session), Object.is-stable until the row itself changes.
    (s) => latestRestartRow(s.sessionCommands, cardId),
    // The three card-chrome toggles fold into one string: they change together
    // (a settings write) and never independently at heartbeat rate.
    (s) => cardChromeSig(s.clientState),
    (s) => spawnedByTitleOf(s, spawnedById),
    (s) => (hasDraft ? ((s.drafts[cardId]?.draft_message as string | undefined) ?? "") : ""),
    (s) => s.currentUser?._id?.toString?.() ?? null,
    (s) => convAuthorSig(s.conversations[cardId]),
    // The roster's own object, Object.is-stable between roster pushes.
    (s) => rosterDeviceOf(s.machineRoster as any, deviceId),
    (s) => memberListSig(s.teamMembers),
    (s) => anchorIdentitySig((s as any).anchors, anchorId),
    // Teammates who have this session open (their faces in the meta row and
    // a ring on the card). The signature is the viewer id list, so a roster
    // push that changes nothing about who is here wakes nothing.
    (s) => viewersSig(s.teamMembers, cardId, s.currentUser?._id?.toString?.() ?? null),
    // A hosted conversation that ended on a stop notice: the kind, a string,
    // so a streamed message wakes the card only when the answer changes.
    (s) => (hosted ? lastNoticeKind(s.messages[cardId]) : null),
  ]);
  const meId = st.currentUser?._id?.toString?.() ?? null;
  const viewers = viewersOf(st.teamMembers, cardId, meId);
  // The amber blocked chip's revive stamp — read before the clock below so its
  // TTL participates in the clock's re-render signature.
  const reviveRequestedAt = st.blockedReviveRequestedAt[cardId];
  const reviveRequestedAtRef = useRef(reviveRequestedAt);
  reviveRequestedAtRef.current = reviveRequestedAt;
  const restartRow = latestRestartRow(st.sessionCommands, cardId);
  const restartRowRef = useRef(restartRow);
  restartRowRef.current = restartRow;
  // Threshold clock, not a raw tick: every card on screen shares the 30s
  // clock, so a plain useCoarseNow re-rendered the WHOLE list once per tick
  // forever. Project the clock onto what this card actually draws from time —
  // the idle-age label, liveness staleness, the blocked-badge TTL, and the
  // pinned-state age line — and re-render only when one of those flips.
  const coarseNow = useNowWhen(
    (t) =>
      `${formatIdleDuration(session.updated_at)}|${sessionIdleAt(session, t) ? 1 : 0}|` +
      `${showsBlockedBadge(session.pending_api_error, false, reviveRequestedAtRef.current, t) ? 1 : 0}|` +
      `${threadStateView(session, session.message_count, t)?.cardLine ?? ""}|` +
      `${restartPending(restartRowRef.current, t) ? 1 : 0}`,
    30_000,
  );
  // The machine behind a worktree, read straight off the persisted roster —
  // useDevices() here would mount the roster feeder once per card. Only a cloud
  // host earns an icon: a worktree on your own laptop needs no explaining.
  const ownerDevice = rosterDeviceOf(st.machineRoster as any, deviceId);
  const runHost = ownerDevice && deviceWakesOnUse(ownerDevice) ? ownerDevice : null;
  const chromeSig = cardChromeSig(st.clientState);
  const showGitChips = useSurface("gitChips");
  const chrome = useMemo<SessionCardChrome>(() => ({
    showModelBadge: chromeSig[0] === "1",
    showAgentIcon: chromeSig[1] === "1",
    personifyAll: chromeSig[3] === "1",
    showBranchPill: chromeSig[4] === "1",
    showGitChips,
  }), [chromeSig, showGitChips]);
  // Cache-first bytes: a thumbnail seen once paints locally (and offline)
  // instead of re-fetching per scroll-through of the inbox.
  const thumbSrc = imageBytes.useSrc(chromeSig[2] === "1" ? session.image_preview_url : undefined);
  // Distrust a frozen live status the same way the bucket does: a row that aged
  // out of the liveness overlay keeps its last is_idle:false forever, so without
  // this an agent that finished 15 days ago still pulses green while sitting in
  // needs-input. Past the trust TTL (keyed on updated_at, which a real working
  // agent bumps far more often) the pulse goes dark — the dot and the bucket now
  // read the SAME staleness check, so they can't disagree.
  const isLive = sessionLiveAt(session, Date.now());
  // Clears when the daemon reports or the session is confirmed back; a command
  // nothing ever answers expires at its deadline (the coarse clock above).
  const restarting = restartPending(restartRow, coarseNow);
  // Author of THIS session — shown only when it isn't the current user's own. The
  // inbox cache is user-scoped, so a teammate's session is here only because it was
  // opened (deep-link / search / palette). The conversation meta (written on every
  // view: is_own + user) covers rows cached before injection carried author fields;
  // the roster keys display off user_id so a teammate rename/avatar shows instantly.
  // Only the viewer's id is read here (author resolution + foreign check), so
  // subscribe to that string, not the whole user doc — the doc's identity
  // churns on daemon heartbeat fields and would re-render every card.
  const currentUser = useMemo(() => (meId ? ({ _id: meId } as any) : null), [meId]);
  const teamMembers = rosterIdentity(st.teamMembers);
  const convMetaSig = convAuthorSig(st.conversations[cardId]);
  const convMeta = useMemo(() => {
    if (convMetaSig === null) return null;
    const [user_id, is_own, acting_user_id, name, email, avatar_url] = convMetaSig.split("\u0000");
    return {
      user_id: user_id || undefined,
      is_own: is_own === "" ? undefined : is_own === "1",
      acting_user_id: acting_user_id || null,
      user: name || email || avatar_url ? { name: name || null, email: email || null, avatar_url: avatar_url || null } : null,
    };
  }, [convMetaSig]);
  const author = useMemo(
    () => resolveSessionAuthor(session, convMeta, currentUser, teamMembers),
    [session.user_id, session.author_name, session.author_avatar, session.acting_user_id, convMeta, currentUser, teamMembers],
  );
  // An anchor's own row is marked as such — the glyph in place of the agent
  // icon, and the scope pill (Personal / team name) beside the title — so a
  // standing member never reads as just another session.
  const anchorSig = anchorIdentitySig((st as any).anchors, anchorId);
  const anchorIdentity = useMemo(() => anchorIdentityFromSig(anchorSig), [anchorSig]);
  // The role above a nested row (R1), read through lib/sessionIdentity.
  // The role this row rides: its own pointer's snapshot for a hand; for a
  // role's standing session under a role (org-staffing.md S28) the parent's
  // snapshot lives on the parent's standing row, so it is read from there.
  const roleAbove = rest.subRow === "role" ? roleLookingAfter(session) ?? leadRoleOf(session) : null;
  const generateUploadUrl = useMutation(api.images.generateUploadUrl);
  const sendMessage = useInboxStore((s) => s.sendMessage);
  const ackAssignment = useAckAssignment();

  const handleDropFiles = useCallback(async (dropped: File[], title: string) => {
    const files = dropped.filter(f => f.type.startsWith("image/"));
    if (files.length === 0) {
      if (dropped.length > 0) toast.error("Only image files are supported");
      return;
    }
    try {
      const storageIds: Id<"_storage">[] = [];
      for (const file of files) {
        const uploaded = await compressImage(file);
        const uploadUrl = await generateUploadUrl({});
        const result = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": uploaded.type }, body: uploaded });
        const { storageId } = await result.json();
        storageIds.push(storageId);
      }
      sendMessage(cardId, "[image]", storageIds);
      toast.success(`Attached ${files.length} image${files.length > 1 ? "s" : ""} to "${title}"`);
    } catch {
      toast.error("Failed to attach files");
    }
  }, [cardId, generateUploadUrl, sendMessage]);

  const isPinned = !!session.is_pinned;
  const handlePin = useMemo(() => onPin && ((id: string, e: React.MouseEvent) => {
    onPin(id);
    tipActions.whisper("session.pin", e);
    if (!isPinned) checkMilestone("m-first-pin");
  }), [onPin, tipActions, isPinned]);
  const handleStash = useMemo(() => onStash && ((id: string, e: React.MouseEvent) => {
    onStash(id);
    tipActions.whisper("session.stash", e);
  }), [onStash, tipActions]);
  const openParent = useCallback(
    (id: string) => (onNavigateToSession ?? useInboxStore.getState().navigateToSession)(id),
    [onNavigateToSession],
  );
  const handlePaneDragStart = useMemo(() => paneDragStart(cardId), [cardId]);
  const selecting = useInboxSelection((sel) => sel.ids.length > 0);

  return (
    <SessionCardView
      {...rest}
      session={session}
      roleAbove={roleAbove}
      now={coarseNow}
      chrome={chrome}
      liveness={{
        isLive,
        pendingSend: convHasPendingSend(st.pendingMessages[cardId]),
        blockedReviveAt: reviveRequestedAt,
        restarting,
        draft: hasDraft ? ((st.drafts[cardId]?.draft_message as string | undefined) ?? "") : "",
        stopped: hosted ? lastNoticeKind(st.messages[cardId]) : null,
      }}
      viewerId={meId}
      author={author}
      viewers={viewers}
      spawnedByTitle={spawnedByTitleOf(st, spawnedById)}
      anchorIdentity={anchorIdentity}
      runHost={runHost}
      thumbSrc={thumbSrc}
      selecting={selecting}
      onToggleSelect={toggleSelect}
      onPin={handlePin}
      onStash={handleStash}
      onNavigateToSession={onNavigateToSession}
      onToggleFavorite={toggleFavorite}
      onOpenLabels={openLabels}
      onAckAssignment={ackAssignment}
      onOpenComments={openComments}
      onOpenParent={openParent}
      onPaneDragStart={handlePaneDragStart}
      onDropFiles={handleDropFiles}
    />
  );
});
