// The vault graph: every note as a dot, every resolved link as a line.
//
// Lazy-loaded: sigma and graphology are ~40kB gzip that a reader who never
// opens the graph should never download (see VaultQuickSwitcherDock for the
// same shape). The canvas, layout and hover machinery live in
// components/graph/LinkGraphCanvas.tsx, shared with the Memory map; this file
// is the vault's overlay and its picture of the notes.

import { useMemo, useRef, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useEventListener } from "../../hooks/useEventListener";
import { Filter, Loader2, RotateCcw, Waypoints, X } from "lucide-react";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { useTabActive } from "../../hooks/usePagePresence";
import { vaultIndex, useVaultIndexVersion } from "../../lib/vault/indexHost";
import { buildVaultGraph, localSubgraph, type VaultGraph } from "../../lib/vault/graphBuilder";
import { LinkGraphCanvas, hashedTone, matchWithNeighbors, type LinkGraph } from "../graph/LinkGraphCanvas";

/** Hops the local graph reaches. Obsidian's default depth, and the point past
 *  which "neighborhood" stops meaning anything in a densely linked vault. */
const LOCAL_HOPS = 2;

/** Notes are colored by folder; an unresolved link is a ghost you can't open. */
function toLinkGraph(graph: VaultGraph): LinkGraph {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      degree: n.degree,
      tone: n.isUnresolved ? "ghost" : hashedTone(n.folder),
      clickable: !n.isUnresolved,
    })),
    edges: graph.edges,
  };
}

export interface VaultGraphViewProps {
  /** The note the vault has open, if any — it anchors the local graph. */
  activePath: string | null;
  onNavigate: (path: string) => void;
  onClose: () => void;
}

export function VaultGraphView({ activePath, onNavigate, onClose }: VaultGraphViewProps) {
  const indexVersion = useVaultIndexVersion();
  const [showUnresolved, setShowUnresolved] = useState(false);
  const [scope, setScope] = useState<"vault" | "local">("vault");
  const [filter, setFilter] = useState("");
  const [settling, setSettling] = useState(false);
  const [layoutNonce, setLayoutNonce] = useState(0);

  const filterInputRef = useRef<HTMLInputElement | null>(null);

  // The graph is a pure function of the index, so it's rebuilt whenever the
  // index version bumps: a note saved on disk redraws the picture.
  // vaultIndex is a mutable singleton, so the version counter (not the object)
  // is what says the graph changed. eslint can't see that relationship.
  const fullGraph = useMemo<VaultGraph>(
    () => buildVaultGraph(vaultIndex, { includeUnresolved: showUnresolved }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [indexVersion, showUnresolved],
  );

  const graph = useMemo<VaultGraph>(
    () =>
      scope === "local" && activePath ? localSubgraph(fullGraph, activePath, LOCAL_HOPS) : fullGraph,
    [fullGraph, scope, activePath],
  );
  const linkGraph = useMemo(() => toLinkGraph(graph), [graph]);

  const matched = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (!term) return null;
    // Path as well as title: "projects/" is the natural way to ask for a
    // folder, and the title alone can't answer it.
    return matchWithNeighbors(linkGraph, (n) => n.label.toLowerCase().includes(term) || n.id.toLowerCase().includes(term));
  }, [filter, linkGraph]);

  // Esc leaves the graph, matching the header toggle — but not while the
  // filter box has focus, where Esc means "clear what I typed".
  //
  // The tab shell keeps inactive tabs mounted, so a bare window listener would
  // fire this from whatever tab the user is actually looking at.
  const isTabActive = useTabActive();
  useEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !isTabActive) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
      if (target === filterInputRef.current && filter) setFilter("");
      return;
    }
    event.preventDefault();
    onClose();
  });

  // Closing the note that anchors the local graph drops us back to the vault.
  const hasLocalAnchor = activePath !== null;
  useWatchEffect(() => {
    if (!hasLocalAnchor) setScope("vault");
  }, [hasLocalAnchor]);

  return (
    <div className="relative h-full w-full min-h-0 bg-sol-bg">
      <LinkGraphCanvas
        graph={linkGraph}
        matched={matched?.ids ?? null}
        active={activePath}
        onNavigate={onNavigate}
        layoutNonce={layoutNonce}
        onSettlingChange={setSettling}
      />

      {graph.nodes.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center pointer-events-none">
          <Waypoints className="w-8 h-8 text-sol-text-dim opacity-30" />
          <div className="text-sm text-sol-text-muted">
            {scope === "local" ? "This note has no links yet." : "No notes to graph yet."}
          </div>
          <div className="text-xs text-sol-text-dim max-w-xs">
            Link notes with <code className="text-sol-text-muted">[[Wiki Links]]</code> and they
            appear here, connected.
          </div>
        </div>
      )}

      <div className="absolute top-3 right-3 w-60 sol-card p-3 flex flex-col gap-2.5 text-xs shadow-lg">
        <div className="flex items-center gap-2">
          <Waypoints className="w-3.5 h-3.5 text-sol-cyan" />
          <span className="font-medium text-sol-text flex-1">Graph</span>
          {settling && <Loader2 className="w-3 h-3 text-sol-text-dim animate-spin" />}
          <button
            type="button"
            onClick={onClose}
            title="Close graph"
            className="text-sol-text-dim hover:text-sol-text transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="text-sol-text-dim tabular-nums">
          {graph.nodes.length} note{graph.nodes.length === 1 ? "" : "s"} · {graph.edges.length} link
          {graph.edges.length === 1 ? "" : "s"}
        </div>

        {hasLocalAnchor && (
          <div className="flex rounded-md border border-sol-border overflow-hidden">
            {(["vault", "local"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setScope(option)}
                className={`flex-1 px-2 py-1 transition-colors ${
                  scope === option
                    ? "bg-sol-cyan text-sol-bg"
                    : "text-sol-text-muted hover:text-sol-text"
                }`}
              >
                {option === "vault" ? "Whole vault" : "Local"}
              </button>
            ))}
          </div>
        )}

        <div className="relative">
          <Filter className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-sol-text-dim" />
          <input
            ref={filterInputRef}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter notes"
            spellCheck={false}
            className="w-full bg-sol-bg border border-sol-border rounded-md pl-7 pr-2 py-1 text-sol-text placeholder:text-sol-text-dim outline-none focus:border-sol-cyan transition-colors"
          />
        </div>
        {matched && (
          <div className="text-sol-text-dim -mt-1">
            {matched.hits} match{matched.hits === 1 ? "" : "es"}
          </div>
        )}

        <label className="flex items-center gap-2 cursor-pointer text-sol-text-muted hover:text-sol-text transition-colors">
          <input
            type="checkbox"
            checked={showUnresolved}
            onChange={(event) => setShowUnresolved(event.target.checked)}
            className="accent-sol-cyan"
          />
          Show unresolved links
        </label>

        <button
          type="button"
          onClick={() => setLayoutNonce((n) => n + 1)}
          className="flex items-center justify-center gap-1.5 px-2 py-1 rounded-md border border-sol-border text-sol-text-muted hover:text-sol-text hover:border-sol-cyan transition-colors"
        >
          <RotateCcw className="w-3 h-3" />
          Re-run layout
        </button>

        <div className="flex items-center gap-1.5 text-sol-text-dim pt-0.5">
          <KeyCap size="xs">esc</KeyCap>
          <span>back to notes</span>
        </div>
      </div>
    </div>
  );
}

export default VaultGraphView;
