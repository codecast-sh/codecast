import type React from "react";
import type { ThreadStateStatus } from "@codecast/shared/contracts";
import type { NoticeKind } from "@codecast/shared/contracts/assistant";
import type { AvatarKey } from "@codecast/shared/contracts/orgAvatars";
import type { InboxSession, SessionRoleSnapshot } from "../../store/inboxStore";
import type { Device } from "../DeviceBadge";
import type { IdentityPrefs, IdentityRow } from "../../lib/sessionIdentity";
import type { AnchorIdentity } from "../../hooks/useSyncAnchors";
import type { SessionShip } from "../../lib/ship/sessionShip";

// The props of the inbox session card (SessionCardView): the row, its chrome
// toggles, its live facts and the handlers every gesture leaves through.

/** The card-chrome toggles (clientState.ui) the row draws. */
export type SessionCardChrome = {
  showModelBadge: boolean;
  showAgentIcon: boolean;
  showBranchPill: boolean;
  /** Mark sessions on a cloud machine or on another of your machines. Absent means shown. */
  showDeviceIcon?: boolean;
  /** The viewer's identity prefs: characters, and every session personified. */
  prefs: IdentityPrefs;
};

/** The per-card live facts that are not fields of the session row. */
export type SessionCardLiveness = {
  /** The agent is running now, by the staleness-aware check (lib/liveness). */
  isLive: boolean;
  /** A sent message the daemon has not confirmed yet. */
  pendingSend: boolean;
  /** The blocked chip's revive stamp (showsBlockedBadge drops the chip while it is fresh). */
  blockedReviveAt?: number;
  /** A kill+restart is in flight for this session (useSessionRestart), age-gated. */
  restarting: boolean;
  /** The kept compose draft's unsent text; "" when there is none. */
  draft: string;
  /** A hosted conversation whose transcript ends on a stop notice: the
   *  notice's kind, so the row says it stopped rather than looking like one
   *  that was answered. */
  stopped?: NoticeKind | null;
  /** A hosted conversation waits on the person's OK (an approval card). */
  asksOk?: boolean;
  /** A pending `cast decide` waits on the person (the Decisions section's
   *  ask). Only the Modern card reads it (lib/sessionStatus). */
  asking?: boolean;
};

export type SessionCardViewProps = {
  session: InboxSession;
  /** The project it works in (lib/workProjectSig). */
  workProject?: string;
  isActive: boolean;
  isParentActive?: boolean;
  /** Ticked in the inbox multi-selection (lib/inboxSelection). */
  isSelected?: boolean;
  /** A multi-selection is live, so every card shows its tick box. */
  selecting?: boolean;
  /** The tick box: adds the card to the selection or takes it out. */
  onToggleSelect?: (id: string) => void;
  /** Lit for this viewer: the session moved since they last acknowledged it,
   *  or they marked it unread by hand (store/inboxStore.sessionUnreadMap). */
  isUnread?: boolean;
  /** The name the open conversation's header shows, when the container has
   *  one fresher than the row's own (SessionCard reads it for hosted rows). */
  liveTitle?: string;
  isFavorite: boolean;
  /** The user label the row is filed under, else the project name shows. */
  sessionLabel: string | null;
  variant?: "default" | "working" | "dismissed" | "stashed" | "snoozed";
  /** The declared status the row's section header already says (Needs you
   *  under NEEDS YOU): the card leaves that chip off rather than repeat it. */
  sectionStatus?: ThreadStateStatus;
  forkColorKey?: string;
  // Force the compact child-row look for a session that isn't itself a
  // subagent — the trigger view renders a trigger's sessions as sub rows under
  // the trigger's own row. The ↳ arrow goes schedule-amber there (child of a
  // trigger, not of a parent session).
  // "role": one of a role's sessions under the role's card (org-roles-run-work
  // .md R1): a subagent row whose arrow names the role.
  // "worker": a session an agent spawned (cast spawn, a workflow sub) drawn
  // under its spawner's card in Modern (inboxStore.nestsWorkers). On its own
  // row it stays a full card.
  subRow?: "trigger" | "role" | "worker";
  /** On a role's own card: how many of its sessions ride it (org-staffing.md S23.3); the pill opens the role's page. */
  roleSessions?: number;
  /** On a "role" sub row: the role above it, which its arrow names. */
  roleAbove?: SessionRoleSnapshot | null;
  /** The card's clock: relative ages, thread-state freshness, the blocked chip's TTL. */
  now: number;
  chrome: SessionCardChrome;
  liveness: SessionCardLiveness;
  /** The signed-in viewer; a row by anyone else, with no steering rights, is read-only. */
  viewerId: string | null;
  /** The session's author, shown only when it is not the viewer. `face` is a
   *  role's avatar key: a role's standing session is shown as its role. */
  author: { name: string; avatar?: string | null; face?: AvatarKey; role?: SessionRoleSnapshot } | null;
  /** Who the row is (lib/sessionIdentity) with its role read live; defaults
   *  to the session row itself. */
  identity?: IdentityRow;
  /** Teammates who have this session open. */
  viewers: any[];
  /** The title of the session that spawned this one. */
  spawnedByTitle: string | null;
  anchorIdentity: AnchorIdentity | null;
  /** The cloud host a worktree runs on; a local worktree needs no host. */
  runHost?: Device | null;
  /** The machine to mark beside the title: a cloud one, or one this window is not on. */
  placeDevice?: Device | null;
  /** The resolved image thumbnail, when the row shows one. */
  thumbSrc?: string | null;
  /** Where the session's work is on its way to production (lib/ship/sessionShip). */
  ship?: SessionShip | null;
  /** A plain click opens; the panel reads the event for ⌘/shift selection gestures. */
  onSelect: (session: InboxSession, e?: React.MouseEvent) => void;
  onDismiss?: (id: string) => void;
  onStash?: (id: string, e: React.MouseEvent) => void;
  onDefer?: (id: string) => void;
  onPin?: (id: string, e: React.MouseEvent) => void;
  onRestore?: (id: string) => void;
  onKill?: (id: string) => void;
  /** The implementation session's link. */
  onNavigateToSession?: (id: string) => void;
  /** Right-click: the panel owns ONE cursor-anchored menu for all cards. */
  onCardContextMenu?: (e: React.MouseEvent, session: InboxSession, isForeign: boolean) => void;
  /** Clicking the face: the panel owns ONE picker for all cards, the same way. */
  onPickCharacter?: (session: InboxSession, e: React.MouseEvent) => void;
  onToggleFavorite?: (id: string) => void;
  onOpenLabels?: (session: InboxSession) => void;
  /** Clicking the card's project or label name: filter the list to it. */
  onFilterProject?: (session: InboxSession, e: React.MouseEvent) => void;
  onFilterLabel?: (session: InboxSession, e: React.MouseEvent) => void;
  onAckAssignment?: (id: string) => void;
  onOpenComments?: (id: string) => void;
  /** The "spawned by" / "handed off from" link. */
  onOpenParent?: (id: string) => void;
  /** The card drag doubles as a pane drag onto the stage. */
  onPaneDragStart?: (e: React.DragEvent, title: string) => void;
  /** Files dropped on the card, unfiltered. */
  onDropFiles?: (files: File[], title: string) => void;
};
