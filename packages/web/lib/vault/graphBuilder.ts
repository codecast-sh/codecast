// The graph view's data model: a plain {nodes, edges} projection of the vault
// index. Pure and isomorphic — no DOM, no sigma, no graphology — so it runs in
// tests and could run in a worker unchanged. The renderer turns this into a
// graphology Graph; the layout worker only ever sees ids and edges.
//
// Two shaping decisions worth stating, because they define what the picture
// means:
//   * Edges are UNDIRECTED and deduped. A note linking back to its linker is
//     one line, not two, and `degree` counts distinct NEIGHBORS. Degree drives
//     node size, so counting link occurrences instead would inflate a note
//     that mentions the same target five times into a hub it isn't.
//   * Only markdown participates. Links resolve to attachments too (embeds),
//     but a vault's images would swamp the layout with leaf nodes that carry
//     no navigational meaning.
// Unresolved targets — `[[Note]]` nothing answers to — are optional ghost
// nodes, off by default: they're the shape of what you meant to write, which
// is interesting sometimes and noise the rest of the time.

import { isVaultAssetPath, isVaultMarkdownPath } from "@codecast/shared/contracts";
import { normalizeTarget } from "./vaultIndex";

/** Ghost-node id prefix. Vault paths are relative and never start with a
 *  slash, so a ghost id can never collide with a real note. */
const UNRESOLVED_PREFIX = "/unresolved:";

/** Ghost id for a link target. Normalized and lowercased exactly as the index
 *  keys unresolved targets, so every spelling of one missing note lands on the
 *  same ghost — the node's `label` is what preserves the original casing. */
export function unresolvedNodeId(target: string): string {
  return UNRESOLVED_PREFIX + normalizeTarget(target).toLowerCase();
}

export interface VaultGraphNode {
  /** Vault-relative path, or a ghost id for an unresolved target. */
  id: string;
  /** Note title (frontmatter > H1 > basename), or the raw target for ghosts. */
  label: string;
  /** Distinct neighbors — drives node size. */
  degree: number;
  /** Top-level folder segment, "" for vault root. Drives node color. */
  folder: string;
  isUnresolved?: boolean;
}

export interface VaultGraphEdge {
  source: string;
  target: string;
}

export interface VaultGraph {
  nodes: VaultGraphNode[];
  edges: VaultGraphEdge[];
}

/** The slice of VaultIndex the graph needs. Structural, so tests can drive it
 *  with a real index or a hand-built stub. */
export interface VaultGraphSource {
  paths(): string[];
  note(path: string): { title: string } | undefined;
  outgoing(path: string): { resolved: string | null; link: { target: string } }[];
}

export interface BuildGraphOptions {
  /** Add ghost nodes for `[[targets]]` no file answers to. Default false. */
  includeUnresolved?: boolean;
}

/** Top-level folder segment of a vault path; "" for a note at the vault root. */
export function topFolder(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Append to a Map-of-arrays, creating the array on first use. */
function pushNeighbor(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function buildVaultGraph(
  index: VaultGraphSource,
  { includeUnresolved = false }: BuildGraphOptions = {},
): VaultGraph {
  const notePaths = index.paths().filter(isVaultMarkdownPath);
  const isNote = new Set(notePaths);

  // Undirected adjacency, built once and reused for both degree and edges, so
  // the two can never disagree.
  const neighbors = new Map<string, Set<string>>();
  const touch = (id: string): Set<string> => {
    let set = neighbors.get(id);
    if (!set) neighbors.set(id, (set = new Set()));
    return set;
  };
  for (const path of notePaths) touch(path);

  const link = (a: string, b: string): void => {
    if (a === b) return;
    touch(a).add(b);
    touch(b).add(a);
  };

  // Ghost labels keep the target's ORIGINAL spelling while grouping by the
  // index's normalized key, so `[[Project Ideas]]` and `[[project ideas]]`
  // are one ghost that still reads as it was written. First spelling wins,
  // and notePaths is sorted, so which one that is stays deterministic.
  const ghostLabels = new Map<string, string>();

  for (const path of notePaths) {
    for (const { resolved, link: noteLink } of index.outgoing(path)) {
      if (resolved) {
        if (isNote.has(resolved)) link(path, resolved);
        continue;
      }
      if (!includeUnresolved) continue;
      const target = normalizeTarget(noteLink.target);
      // A missing image is a missing attachment, not a note worth drawing.
      if (!target || isVaultAssetPath(target)) continue;
      const id = unresolvedNodeId(target);
      if (!ghostLabels.has(id)) ghostLabels.set(id, target);
      link(path, id);
    }
  }

  // Sorted output keeps the layout's circle seed — and therefore the whole
  // rendered picture — reproducible across rebuilds of the same vault.
  const nodes: VaultGraphNode[] = [];
  for (const id of [...neighbors.keys()].sort()) {
    const ghost = ghostLabels.get(id);
    nodes.push(
      ghost === undefined
        ? {
            id,
            label: index.note(id)?.title || id.split("/").pop() || id,
            degree: neighbors.get(id)!.size,
            folder: topFolder(id),
          }
        : {
            id,
            label: ghost,
            degree: neighbors.get(id)!.size,
            folder: "",
            isUnresolved: true,
          },
    );
  }

  // Each undirected pair is emitted once, from its alphabetically lower end.
  const edges: VaultGraphEdge[] = [];
  for (const node of nodes) {
    for (const other of [...neighbors.get(node.id)!].sort()) {
      if (node.id < other) edges.push({ source: node.id, target: other });
    }
  }

  return { nodes, edges };
}

/**
 * The local graph: everything within `hops` links of `rootId`, in either
 * direction. Obsidian's local view — it answers "what is this note's
 * neighborhood" without the whole vault's hairball around it.
 * Returns an empty graph if the root isn't in the graph.
 */
export function localSubgraph(graph: VaultGraph, rootId: string, hops: number): VaultGraph {
  if (!graph.nodes.some((n) => n.id === rootId)) return { nodes: [], edges: [] };

  const adjacency = new Map<string, string[]>();
  for (const { source, target } of graph.edges) {
    pushNeighbor(adjacency, source, target);
    pushNeighbor(adjacency, target, source);
  }

  const kept = new Set([rootId]);
  let frontier = [rootId];
  for (let hop = 0; hop < hops; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (kept.has(neighbor)) continue;
        kept.add(neighbor);
        next.push(neighbor);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  const nodes = graph.nodes.filter((n) => kept.has(n.id));
  const edges = graph.edges.filter((e) => kept.has(e.source) && kept.has(e.target));
  // Degree is recomputed against the subgraph: in a local view, size should
  // mean "connected here", not "connected somewhere off screen".
  const localDegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const { source, target } of edges) {
    localDegree.set(source, (localDegree.get(source) ?? 0) + 1);
    localDegree.set(target, (localDegree.get(target) ?? 0) + 1);
  }
  return {
    nodes: nodes.map((n) => ({ ...n, degree: localDegree.get(n.id) ?? 0 })),
    edges,
  };
}
