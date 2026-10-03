// Every memory as a dot and every [[link]] as a line, colored by what kind of
// memory it is or by whether Claude ever reaches it. Lazy-loaded with sigma
// (see LinkGraphCanvas).

import { useMemo, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import type { MemoryAtlas } from "@codecast/shared/memory";
import { MEMORY_REACH } from "@codecast/shared/memory";
import { LinkGraphCanvas, matchWithNeighbors, type LinkGraph } from "../graph/LinkGraphCanvas";
import { REACH, TYPE_TONE, toneCss, typeKey } from "./memoryView";

export type MemoryColorBy = "reach" | "type";

export interface MemoryMapProps {
  atlas: MemoryAtlas;
  /** Files that pass the page's search and type filters; null = all. */
  visible: Set<string> | null;
  active: string | null;
  onOpen: (file: string) => void;
}

export function MemoryMap({ atlas, visible, active, onOpen }: MemoryMapProps) {
  const [colorBy, setColorBy] = useState<MemoryColorBy>("reach");
  const [settling, setSettling] = useState(false);
  const [layoutNonce, setLayoutNonce] = useState(0);

  const graph = useMemo<LinkGraph>(
    () => ({
      nodes: atlas.notes.map((n) => ({
        id: n.file,
        label: n.name.replace(/[_-]+/g, " "),
        degree: n.inbound.length + n.links.length,
        tone: colorBy === "reach" ? REACH[n.reach].tone : TYPE_TONE[typeKey(n.type)],
      })),
      edges: atlas.edges,
    }),
    [atlas, colorBy],
  );
  const matched = useMemo(() => (visible ? matchWithNeighbors(graph, (n) => visible.has(n.id)).ids : null), [graph, visible]);

  const legend =
    colorBy === "reach"
      ? MEMORY_REACH.map((r) => ({ key: r, label: REACH[r].label, tone: REACH[r].tone, count: atlas.notes.filter((n) => n.reach === r).length }))
      : Object.entries(TYPE_TONE).map(([t, tone]) => ({ key: t, label: t, tone, count: atlas.notes.filter((n) => typeKey(n.type) === t).length }));

  return (
    <div className="relative h-full w-full min-h-0 bg-sol-bg">
      <LinkGraphCanvas
        graph={graph}
        matched={matched}
        active={active}
        onNavigate={onOpen}
        layoutNonce={layoutNonce}
        onSettlingChange={setSettling}
      />
      <div className="absolute left-3 bottom-3 w-56 sol-card p-3 flex flex-col gap-2 text-xs shadow-lg">
        <div className="flex items-center gap-2">
          <div className="flex flex-1 rounded-md border border-sol-border overflow-hidden">
            {(["reach", "type"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setColorBy(option)}
                className={`flex-1 px-2 py-1 transition-colors ${colorBy === option ? "bg-sol-cyan text-sol-bg" : "text-sol-text-muted hover:text-sol-text"}`}
              >
                {option === "reach" ? "Reach" : "Type"}
              </button>
            ))}
          </div>
          {settling && <Loader2 className="w-3 h-3 text-sol-text-dim animate-spin" />}
          <button
            type="button"
            onClick={() => setLayoutNonce((n) => n + 1)}
            title="Re-run layout"
            className="text-sol-text-dim hover:text-sol-text transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
        {legend
          .filter((l) => l.count > 0)
          .map((l) => (
            <div key={l.key} className="flex items-center gap-2 text-sol-text-muted" title={colorBy === "reach" ? REACH[l.key as keyof typeof REACH].why : undefined}>
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: toneCss(l.tone) }} />
              <span className="flex-1 first-letter:uppercase">{l.label}</span>
              <span className="tabular-nums text-sol-text-dim">{l.count}</span>
            </div>
          ))}
        <div className="text-sol-text-dim pt-0.5">Size is links in and out. Drag to pin, click to edit.</div>
      </div>
    </div>
  );
}

export default MemoryMap;
