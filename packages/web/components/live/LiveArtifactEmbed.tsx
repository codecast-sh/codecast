// A live artifact (a board, sheet or dashboard) drawn inside another surface,
// fully editable: the product's own view with its own controls, and every
// other participant's cursor on it. A call's stage shows a pinned artifact
// this way, so the people in the call work on the same board together with
// the agents keeping it. What only the artifact's page has (its title field,
// comments, history, share) stays on the page, one click away.
import { Suspense, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { ArtifactType } from "@codecast/shared/artifacts";
import { useInboxStore } from "../../store/inboxStore";
import { AppLoader } from "../AppLoader";
import { ErrorBoundary } from "../ErrorBoundary";
import "./live.css";
import { useLiveArtifact } from "./useLiveArtifact";
import { useLiveElements, useLivePresence } from "./liveArtifactReads";
import { CursorLayer } from "./LiveCursors";
import { createScreenMap } from "../../lib/liveScreenMap";
import { AskClaimProvider, useAskClaims } from "./askAgent";
import { LIVE_VIEWS, type LiveExport, type LiveImport } from "./registry";

export type LiveEmbedDoc = { _id: string; title: string; doc_type: ArtifactType; workspace?: string };

const noop = () => {};

export function LiveArtifactEmbed({
  doc,
  toolbarSlot,
  onOpenPage,
}: {
  doc: LiveEmbedDoc;
  /** Where the product's controls go; null draws them in a row of the embed's own. */
  toolbarSlot?: (node: ReactNode) => ReactNode;
  /** Comments and other page-only surfaces open the artifact's page. */
  onOpenPage?: () => void;
}) {
  const live = useLiveArtifact(doc._id);
  const others = useLivePresence(doc._id);
  const elements = useLiveElements(doc._id);
  const askClaims = useAskClaims();
  const View = LIVE_VIEWS[doc.doc_type];
  const screenMap = useRef(createScreenMap()).current;
  const [selection, setSelectionState] = useState<string[]>([]);
  const [toolbar, setToolbar] = useState<ReactNode>(null);
  const [panel, setPanelNode] = useState<ReactNode | null>(null);
  const setSelection = useCallback(
    (keys: string[]) => {
      setSelectionState(keys);
      live.setPresence({ selection: keys, position: keys.length ? { key: keys[keys.length - 1] } : undefined });
    },
    [live],
  );
  const setPanel = useCallback((node: ReactNode | null) => setPanelNode(node), []);
  const openComments = useCallback(() => onOpenPage?.(), [onOpenPage]);
  const canEdit = useInboxStore((s: any) => s.liveHeads?.[doc._id]?.can_edit !== false);
  const archived = !!(doc as any).archived_at;
  const cold = !live.ready && elements.length === 0;
  const mode = archived || !canEdit || cold ? "view" : "edit";
  const view = useMemo(
    () => (
      <View
        doc={doc}
        live={live}
        selection={selection}
        setSelection={setSelection}
        mode={mode}
        toScreen={screenMap.set}
        setToolbar={setToolbar}
        setPanel={setPanel}
        setExports={noop as (e: LiveExport[] | null) => void}
        setImport={noop as (i: LiveImport | null) => void}
        openComments={openComments}
        setTypeLabel={noop}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- doc fields named explicitly
    [View, doc._id, doc.title, doc.doc_type, live, selection, setSelection, mode, setPanel, openComments],
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-live-embed={doc.doc_type} data-detail-owns-keys="">
      {toolbarSlot ? toolbarSlot(toolbar) : toolbar ? (
        <div data-live-toolbar className="flex h-9 shrink-0 items-center justify-end gap-2 overflow-hidden border-b border-sol-border/40 px-2">{toolbar}</div>
      ) : null}
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 select-text" data-live-body>
          <ErrorBoundary name={`LiveEmbed:${doc.doc_type}`} level="panel">
            <AskClaimProvider value={askClaims.value}>
              <Suspense fallback={<AppLoader className="h-full" />}>{view}</Suspense>
            </AskClaimProvider>
          </ErrorBoundary>
          <CursorLayer others={others} screenMap={screenMap} />
        </div>
        {panel && (
          <aside className="live-panel absolute inset-y-0 right-0 z-10 flex w-[min(420px,80%)] flex-col overflow-hidden border-l border-sol-border/40 bg-sol-bg shadow-2xl" data-live-panel="product">
            <button
              type="button"
              onClick={() => setPanelNode(null)}
              className="absolute right-2 top-2 z-10 rounded p-1 text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text"
              title="Close"
              aria-label="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            {panel}
          </aside>
        )}
      </div>
    </div>
  );
}
