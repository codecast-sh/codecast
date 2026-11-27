// The call's board as a stage view, and what brings Scribe to it: the invite
// banner over the board, the "Next time" banner that turns the invite into
// the person's default for the workspace, and the header chip that stands
// for Scribe while it is in the call.
import { useState, useSyncExternalStore } from "react";
import { ChevronDown, PenLine, SquareKanban, SquareArrowOutUpRight, X } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useMountEffect } from "../../hooks/useMountEffect";
import { boardBannerState, markNextTimeSeen, SCRIBE_INVITE_WORDS, setHuddleSettings, useHuddleSetting, useNextTimeSeen, type BannerMemo } from "../../lib/calls/huddleSettings";
import type { ParticipantTile } from "../../lib/calls/callMedia";
import { pinShare } from "../../lib/calls/stagePins";
import type { StagePinRow } from "../../hooks/useStagePins";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { AppLoader } from "../AppLoader";
import { AutoStage } from "./StageViews";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { autoScribeLedger } from "../consequential/ledgers";

type Scribe = { present: boolean; status: "absent" | "joining" | "listening"; invite: (opts?: { auto?: boolean }) => void; remove: () => void };

// ── The board on the stage ────────────────────────────────────────────────

// The call's board, by call: got (made if the room has none) the first time
// this window opens board view in the call (callStage.openCallBoard). Board
// view is one person's way of looking: it never pins, so nobody else's stage
// moves. Putting the board on everyone's stage is the pin picker's.
const boards = new Map<string, string>();

/** The stage share for the call's board: its pin row when the room has it
 *  pinned, else a row naming the doc, so taking the pin down leaves the view. */
function boardShare(roomKey: string, docId: string, pins: StagePinRow[]) {
  const ref = `doc:${docId}`;
  const row: StagePinRow = pins.find((p) => p.ref === ref) ?? {
    _id: `board:${docId}`,
    room_key: roomKey,
    ref,
    kind: "doc",
    doc_id: docId,
    slug: null,
    at: 0,
    title: "Call board",
    doc_type: "board",
    readable: true,
    pinned_by: "",
    pinned_by_name: null,
    pinned_by_session: null,
    pinned_by_agent: null,
  };
  return pinShare(row);
}

export function BoardStage({
  roomKey,
  callKey,
  pins,
  roster,
  cameras,
  phase,
  banner,
}: {
  roomKey: string;
  /** The live call's id: the board is the call's, so a new call makes a new one. */
  callKey: string | null;
  pins: StagePinRow[];
  roster: any[];
  cameras: ParticipantTile[];
  phase: string;
  banner?: React.ReactNode;
}) {
  const key = `${roomKey}|${callKey ?? ""}`;
  const [docId, setDocId] = useState<string | null>(() => boards.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  useMountEffect(() => {
    if (docId) return;
    let gone = false;
    useInboxStore
      .getState()
      .openCallBoard(roomKey)
      .then((r) => {
        if (!r?.doc_id || gone) return;
        boards.set(key, r.doc_id);
        setDocId(r.doc_id);
      })
      .catch((e: any) => !gone && setError(typeof e?.data === "string" ? e.data : e?.message ?? "Could not open the board"));
    return () => {
      gone = true;
    };
  });
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1" data-stage-view="board">
      {docId ? (
        <AutoStage roster={roster} cameras={cameras} screens={[boardShare(roomKey, docId, pins)]} phase={phase} />
      ) : (
        <div className="flex flex-1 items-center justify-center rounded-xl bg-sol-bg-alt text-meta text-sol-text-muted ring-1 ring-sol-text/[0.06]">
          {error ?? <AppLoader className="h-full" />}
        </div>
      )}
      {docId && banner && (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-3">
          <div className="pointer-events-auto max-w-full">{banner}</div>
        </div>
      )}
    </div>
  );
}

// ── The banners ───────────────────────────────────────────────────────────

// What this person did with the banners in one call: dismissed the invite,
// invited Scribe from it, closed or saved the "Next time" one. Held for the
// call (by its key), across switching views and back.
const bannerMemos = new Map<string, BannerMemo>();
const bannerListeners = new Set<() => void>();
const EMPTY: BannerMemo = {};
function noteBanner(callKey: string, patch: BannerMemo) {
  bannerMemos.set(callKey, { ...bannerMemos.get(callKey), ...patch });
  bannerListeners.forEach((fn) => fn());
}
function subscribeBanners(fn: () => void) {
  bannerListeners.add(fn);
  return () => void bannerListeners.delete(fn);
}

const BANNER = "flex items-center gap-2.5 rounded-xl bg-sol-bg px-3 py-1.5 text-[13px] text-sol-text shadow-lg ring-1 ring-sol-text/[0.08]";
const CLOSE = "shrink-0 rounded-md p-1 text-sol-text-muted transition-colors hover:bg-sol-text/[0.06] hover:text-sol-text";

export function BoardBanner({
  callKey,
  workspace,
  workspaceName,
  scribe,
}: {
  callKey: string;
  /** The huddle's workspace key, where "Next time" saves. */
  workspace: string | null;
  workspaceName: string;
  scribe: Scribe;
}) {
  const memo = useSyncExternalStore(subscribeBanners, () => bannerMemos.get(callKey) ?? EMPTY, () => EMPTY);
  const boardViewOn = useHuddleSetting("huddleBoardView", workspace);
  const autoScribeOn = useHuddleSetting("huddleAutoScribe", workspace);
  const nextSeen = useNextTimeSeen(workspace);
  const state = boardBannerState({ present: scribe.present, memo, boardViewOn, autoScribeOn, nextSeen });
  if (state === "invite") {
    return (
      <div className={BANNER} role="status" data-banner="invite">
        <PenLine className="h-3.5 w-3.5 shrink-0 text-sol-violet" />
        <span className="min-w-0 truncate">{SCRIBE_INVITE_WORDS}</span>
        <button
          type="button"
          onClick={() => {
            noteBanner(callKey, { invited: true });
            scribe.invite();
          }}
          className="shrink-0 rounded-md bg-sol-violet px-2.5 py-1 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90"
        >
          Invite Scribe
        </button>
        <button type="button" onClick={() => noteBanner(callKey, { dismissed: true })} className={CLOSE} aria-label="Dismiss for this call">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }
  if (state === "next" && workspace) {
    return (
      <NextTimeBanner
        workspace={workspace}
        workspaceName={workspaceName}
        autoScribeOn={autoScribeOn}
        onShown={() => {
          // Shown once is shown for good in this workspace; it stays up for
          // the rest of this call (nextShown) until saved or closed.
          noteBanner(callKey, { nextShown: true });
          markNextTimeSeen(workspace);
        }}
        onClose={() => noteBanner(callKey, { nextClosed: true })}
      />
    );
  }
  return null;
}

function NextTimeBanner({
  workspace,
  workspaceName,
  autoScribeOn,
  onShown,
  onClose,
}: {
  workspace: string;
  workspaceName: string;
  autoScribeOn: boolean;
  onShown: () => void;
  onClose: () => void;
}) {
  useMountEffect(onShown);
  const [boardView, setBoardView] = useState(true);
  const [autoScribe, setAutoScribe] = useState(true);
  // Saving "Invite Scribe" on starts an agent in every huddle: that goes
  // through the review first. Anything else saves on the press.
  const [reviewing, setReviewing] = useState(false);
  const save = () => {
    setHuddleSettings(workspace, { huddleBoardView: boardView, huddleAutoScribe: autoScribe });
    onClose();
  };
  return (
    <div className={BANNER} role="status" data-banner="next">
      <span className="shrink-0 font-medium">
        Next time in <span className="rounded bg-sol-text/[0.06] px-1.5 py-px">{workspaceName}</span>:
      </span>
      <label className="flex shrink-0 items-center gap-1.5">
        <input type="checkbox" checked={boardView} onChange={(e) => setBoardView(e.target.checked)} className="accent-sol-violet" />
        Open huddles on the board
      </label>
      <label className="flex shrink-0 items-center gap-1.5">
        <input type="checkbox" checked={autoScribe} onChange={(e) => setAutoScribe(e.target.checked)} className="accent-sol-violet" />
        Invite Scribe
      </label>
      <button
        type="button"
        onClick={() => (autoScribe && !autoScribeOn ? setReviewing(true) : save())}
        className="shrink-0 rounded-md bg-sol-text px-2.5 py-1 text-[12.5px] font-medium text-sol-bg transition-opacity hover:opacity-90"
      >
        Save
      </button>
      <button type="button" onClick={onClose} className={CLOSE} aria-label="Close">
        <X className="h-3.5 w-3.5" />
      </button>
      {reviewing && (
        <SwitchReview
          ledger={autoScribeLedger({ workspace: workspaceName })}
          onClose={() => setReviewing(false)}
          onConfirm={() => {
            setReviewing(false);
            save();
          }}
        />
      )}
    </div>
  );
}

// ── The header chip ───────────────────────────────────────────────────────

/** Scribe in the header while it is in the call, its menu the way to remove
 *  it. Nothing while it is absent: the board's banner and the Add menu invite. */
export function ScribeChip({
  scribe,
  session,
  onOpenBoard,
  onOpenSession,
}: {
  scribe: Scribe;
  /** Scribe's session, once seated. */
  session: string | null;
  onOpenBoard: () => void;
  onOpenSession: (id: string) => void;
}) {
  if (!scribe.present) return null;
  const word = scribe.status === "listening" ? "listening" : "joining";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-sol-violet/10 px-2 py-1 font-mono text-meta text-sol-violet transition-colors hover:bg-sol-violet/15 data-[state=open]:bg-sol-violet/20"
          title="Scribe keeps the call's board as you talk"
          aria-label={`Scribe, ${word}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full bg-sol-violet${word === "joining" ? " animate-pulse" : ""}`} aria-hidden="true" />
          Scribe · {word}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        collisionPadding={8}
        className="w-[220px] rounded-lg border-0 bg-sol-bg-alt p-1 font-mono text-meta shadow-2xl ring-1 ring-sol-text/[0.08]"
      >
        <DropdownMenuItem onSelect={onOpenBoard} className="gap-2 rounded-md px-2 py-1.5 focus:bg-sol-text/[0.06]">
          <SquareKanban className="h-3.5 w-3.5 text-sol-text-muted" />
          Open the board
        </DropdownMenuItem>
        {session && (
          <DropdownMenuItem onSelect={() => onOpenSession(session)} className="gap-2 rounded-md px-2 py-1.5 focus:bg-sol-text/[0.06]">
            <SquareArrowOutUpRight className="h-3.5 w-3.5 text-sol-text-muted" />
            Open Scribe's session
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator className="bg-sol-text/[0.06]" />
        <DropdownMenuItem onSelect={scribe.remove} className="gap-2 rounded-md px-2 py-1.5 text-sol-red focus:bg-sol-red/10 focus:text-sol-red">
          <X className="h-3.5 w-3.5" />
          Remove from the call
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
