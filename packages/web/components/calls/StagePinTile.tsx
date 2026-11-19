// A thing pinned on a call's stage (convex/callStage.ts), as everyone in the
// call sees it: the thing itself, live, where a screen share would be. A
// board, sheet or dashboard is the editable artifact with everyone's cursors
// on it; a doc is its collaborative editor; a published page is the page; any
// other object is its card. In a strip it is a small card that says what it is.
import { createContext, memo, useContext, type ReactNode } from "react";
import { ExternalLink, FileText, Globe, Lock, PinOff } from "lucide-react";
import { isArtifactDocType, type ArtifactType } from "@codecast/shared/artifacts";
import { DOC_TYPE_LABELS, type DocType } from "@codecast/shared/docs";
import { useInboxStore } from "../../store/inboxStore";
import type { StagePinRow } from "../../hooks/useStagePins";
import { useSyncDocDetail } from "../../hooks/useSyncDocs";
import { LiveArtifactEmbed } from "../live/LiveArtifactEmbed";
import { CollabDocEditor } from "../editor/CollabDocEditor";
import { PublishedPageEmbed } from "../PublishedPageEmbed";
import { EntityObjectCard } from "../EntityObjectCard";
import { DocTypeMark } from "../docs/DocTypeMark";
import { AppLoader } from "../AppLoader";
import { useEntityResolution } from "../../lib/entityDisplay";
import { ErrorBoundary } from "../ErrorBoundary";
import type { StagePinShare } from "./stageHost";

/** What a pin's tile may do outside itself: open the thing whole (in the app,
 *  or the main window from a call's own window), and take it off the stage. */
export type StagePinActions = { roomKey: string; openPath: (path: string) => void };
export const StagePinContext = createContext<StagePinActions | null>(null);

/** The stage share for a pin row: what the views lay out. */
export function pinShare(row: StagePinRow): StagePinShare {
  return { kind: "pin", key: `pin:${row.ref}`, identity: `pin:${row.ref}`, name: pinTitle(row), pin: row, at: row.at };
}

/** An object pin's own title (a task's, a plan's), else the pin's stored one. */
function usePinTitle(row: StagePinRow): string {
  const r = useEntityResolution(row.kind === "object" ? row.ref : "");
  const named = row.kind === "object" ? r.entity?.title ?? r.entity?.display_title ?? r.entity?.name ?? null : null;
  return named || pinTitle(row);
}

/** A pin's name where the stage labels it (its tab). */
export function StagePinLabel({ share }: { share: StagePinShare }) {
  return <>{usePinTitle(share.pin as StagePinRow)}</>;
}

function pinTitle(row: StagePinRow): string {
  if (row.title) return row.title;
  if (row.kind === "page") return "Published page";
  if (row.kind === "doc") return row.doc_type ? DOC_TYPE_LABELS[row.doc_type as DocType] ?? "Doc" : "Doc";
  return row.ref;
}

function pinPath(row: StagePinRow): string | null {
  if (row.kind === "doc" && row.doc_id) return `/docs/${row.doc_id}`;
  if (row.kind === "page" && row.slug) return `/a/${row.slug}`;
  return null;
}

function PinMark({ row, size = 14 }: { row: StagePinRow; size?: number }) {
  if (row.kind === "doc" && row.doc_type) return <DocTypeMark type={row.doc_type} size={size} />;
  if (row.kind === "page") return <Globe className="shrink-0 text-sol-blue" style={{ width: size, height: size }} />;
  return <FileText className="shrink-0 text-sol-text-muted" style={{ width: size, height: size }} />;
}

export const StagePinTile = memo(function StagePinTile({ share, small }: { share: StagePinShare; small?: boolean }) {
  const row = share.pin as StagePinRow;
  if (small) return <PinCard row={row} />;
  // Its own surface, lighter than the stage, the way a screen share is a
  // picture in a frame: the thing is the room's to work on.
  return (
    <div className="h-full w-full overflow-hidden rounded-xl bg-sol-bg-alt ring-1 ring-white/[0.06]" data-stage-pin={row.ref}>
      <PinWhole row={row} />
    </div>
  );
});

/** A pin in a strip: what it is and who put it there. Pressing it is the
 *  strip's to decide (Speaker view brings it to the stage). */
function PinCard({ row }: { row: StagePinRow }) {
  const title = usePinTitle(row);
  return (
    <div className="stage-tile-small flex aspect-video w-full shrink-0 flex-col justify-between rounded-lg bg-white/[0.05] p-2 ring-1 ring-white/[0.06]">
      <PinMark row={row} size={16} />
      <div className="min-w-0">
        <div className="truncate font-mono text-meta text-sol-text">{title}</div>
        <PinnedBy row={row} />
      </div>
    </div>
  );
}

function PinnedBy({ row }: { row: StagePinRow }) {
  const who = row.pinned_by_agent ?? row.pinned_by_name;
  if (!who) return null;
  return <div className="truncate text-meta text-sol-text-dim">{row.pinned_by_agent ? `✳ ${who}` : who}</div>;
}

function PinWhole({ row }: { row: StagePinRow }) {
  const isLive = row.kind === "doc" && !!row.doc_type && isArtifactDocType(row.doc_type);
  if (!row.readable) {
    return (
      <PinFrame row={row}>
        <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
          <Lock className="h-6 w-6 text-sol-text-dim" />
          <div className="font-mono text-[13px] text-sol-text-muted">
            {row.kind === "doc" ? "You can't open this doc" : "This page is gone"}
          </div>
          {row.kind === "doc" && row.pinned_by_name && (
            <div className="text-meta text-sol-text-dim">Ask {row.pinned_by_name} to share it with the team</div>
          )}
        </div>
      </PinFrame>
    );
  }
  if (isLive && row.doc_id) {
    const doc = { _id: row.doc_id, title: pinTitle(row), doc_type: row.doc_type as ArtifactType };
    return <LiveArtifactEmbed doc={doc} toolbarSlot={(toolbar) => <PinHead row={row} toolbar={toolbar} />} />;
  }
  return (
    <PinFrame row={row}>
      {row.kind === "doc" && row.doc_id ? (
        <ProseDoc id={row.doc_id} />
      ) : row.kind === "page" && row.slug ? (
        <PublishedPageEmbed slug={row.slug} fill />
      ) : (
        <div className="h-full overflow-auto p-4">
          <EntityObjectCard refId={row.ref} count={1} />
        </div>
      )}
    </PinFrame>
  );
}

/** The tile around a pin that draws no controls of its own. */
function PinFrame({ row, children }: { row: StagePinRow; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PinHead row={row} />
      <div className="relative min-h-0 flex-1 select-text">
        <ErrorBoundary name={`StagePin:${row.kind}`} level="panel">
          {children}
        </ErrorBoundary>
      </div>
    </div>
  );
}

/** The pin's header: what it is, who put it up, the thing's own controls
 *  (a board's tools), and the two ways out: open it whole, take it down. */
function PinHead({ row, toolbar }: { row: StagePinRow; toolbar?: ReactNode }) {
  const actions = useContext(StagePinContext);
  const path = pinPath(row);
  const title = usePinTitle(row);
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/[0.06] px-2.5" data-stage-pin-head={row.ref}>
      <PinMark row={row} />
      <span className="min-w-0 max-w-[40%] truncate font-mono text-[12.5px] text-sol-text" title={title}>{title}</span>
      {(row.pinned_by_agent || row.pinned_by_name) && (
        <span className="hidden shrink-0 truncate text-meta text-sol-text-dim md:inline">
          · {row.pinned_by_agent ? `✳ ${row.pinned_by_agent}` : row.pinned_by_name}
        </span>
      )}
      <div data-live-toolbar className="flex min-w-0 flex-1 items-center justify-end gap-2 overflow-hidden">
        {toolbar}
      </div>
      {path && actions && (
        <button
          type="button"
          onClick={() => actions.openPath(path)}
          className="shrink-0 rounded-md p-1 text-sol-text-muted transition-colors hover:bg-white/[0.06] hover:text-sol-text"
          title="Open it whole"
          aria-label="Open it whole"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      )}
      {actions && (
        <button
          type="button"
          onClick={() => useInboxStore.getState().unpinFromStage(actions.roomKey, row.ref)}
          className="shrink-0 rounded-md p-1 text-sol-text-muted transition-colors hover:bg-white/[0.06] hover:text-sol-text"
          title="Take it off the stage for everyone"
          aria-label="Take it off the stage"
        >
          <PinOff className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/** A prose doc, editable together: the same collaborative editor as its page. */
function ProseDoc({ id }: { id: string }) {
  const detailResult = useSyncDocDetail(id);
  const detail = useInboxStore((s: any) => s.docDetails[id] ?? s.docs[id]) as { content?: string; title?: string } | undefined;
  if (!detail && detailResult === undefined) return <AppLoader className="h-full" />;
  return (
    <div className="h-full overflow-y-auto px-6 py-4">
      <div className="mx-auto max-w-[760px]">
      <CollabDocEditor key={id} docId={id} markdownContent={detail?.content ?? ""} editable contentReady={!!detail} placeholder="Write together…" />
      </div>
    </div>
  );
}
