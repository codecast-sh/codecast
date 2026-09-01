// Stage splits: a tab's content as a TREE of panes instead of one path.
//
// A tab normally shows one route (AppTab.path). Dropping a second surface onto
// the stage grows the tab a `layout`: a tree of row/col branches whose leaves
// each hold a route path. One leaf is FOCUSED, and the invariant the whole
// shell leans on is `tab.path === focused leaf's path` — every consumer of a
// tab's path (sidebar highlight, breadcrumbs, URL sync, titles, stamping)
// keeps working without knowing splits exist. A tab with no `layout` is
// exactly today's single-path tab, so every persisted tab stays valid.
//
// Pure functions only — the store's actions are thin wrappers, and the drag
// preview calls the same ops on a hypothetical tree, so the preview and the
// real layout can never disagree.

export type SplitDir = "row" | "col";
export type SplitEdge = "left" | "right" | "top" | "bottom";

export type StageLeaf = { type: "leaf"; id: string; path: string };
export type StageBranch = {
  type: "split";
  id: string;
  dir: SplitDir;
  children: StageNode[];
  /** Percent of this branch per child; kept summing to ~100. */
  sizes: number[];
};
export type StageNode = StageLeaf | StageBranch;

/** Panes stop being useful smaller than this; the cap is a product choice
 *  (a 2x2 grid), not a technical limit. */
export const MAX_STAGE_LEAVES = 4;

let idCounter = 0;
export function newLeafId(): string {
  // Time + counter: unique across a session, stable to persist.
  return `sl_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
}

export function leafNode(path: string, id?: string): StageLeaf {
  return { type: "leaf", id: id ?? newLeafId(), path };
}

export function leavesOf(root: StageNode | null | undefined): StageLeaf[] {
  if (!root) return [];
  if (root.type === "leaf") return [root];
  return root.children.flatMap(leavesOf);
}

export function countLeaves(root: StageNode | null | undefined): number {
  return leavesOf(root).length;
}

export function findLeaf(root: StageNode | null | undefined, id: string): StageLeaf | null {
  if (!root) return null;
  if (root.type === "leaf") return root.id === id ? root : null;
  for (const c of root.children) {
    const hit = findLeaf(c, id);
    if (hit) return hit;
  }
  return null;
}

export function findBranch(root: StageNode | null | undefined, id: string): StageBranch | null {
  if (!root || root.type === "leaf") return null;
  if (root.id === id) return root;
  for (const c of root.children) {
    const hit = findBranch(c, id);
    if (hit) return hit;
  }
  return null;
}

function edgeDir(edge: SplitEdge): SplitDir {
  return edge === "left" || edge === "right" ? "row" : "col";
}

function edgeBefore(edge: SplitEdge): boolean {
  return edge === "left" || edge === "top";
}

function renormalize(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= 0) return sizes.map(() => 100 / sizes.length);
  return sizes.map((s) => (s / total) * 100);
}

/**
 * Collapse the tree to its canonical form: single-child branches hoist their
 * child, and a branch nested in a same-direction parent melts into it (its
 * children take a share of the slot it occupied). Canonical trees are what
 * every op returns, so depth stays bounded by the leaf cap.
 */
export function normalize(node: StageNode): StageNode {
  if (node.type === "leaf") return node;
  const children: StageNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((rawChild, i) => {
    const child = normalize(rawChild);
    const share = node.sizes[i] ?? 100 / node.children.length;
    if (child.type === "split" && child.dir === node.dir) {
      // Same-direction nesting melts: the child's children split its share.
      child.children.forEach((gc, j) => {
        children.push(gc);
        sizes.push((share * (child.sizes[j] ?? 0)) / 100);
      });
    } else {
      children.push(child);
      sizes.push(share);
    }
  });
  if (children.length === 0) return node; // malformed; caller validates
  if (children.length === 1) return children[0];
  return { ...node, children, sizes: renormalize(sizes) };
}

/** Where a new leaf goes: beside an existing leaf, or along a whole stage edge. */
export type SplitTarget = { leafId: string } | "root";

/**
 * Insert a new leaf into the tree. Beside a leaf whose parent already runs in
 * the split's direction, the leaf's share is halved between the pair; anywhere
 * else the target wraps in a new two-child branch. Returns null when the
 * target leaf doesn't exist. Callers enforce MAX_STAGE_LEAVES.
 */
export function insertLeaf(
  root: StageNode,
  target: SplitTarget,
  edge: SplitEdge,
  path: string,
): { root: StageNode; leafId: string } | null {
  return insertNode(root, target, edge, leafNode(path));
}

/**
 * Move an existing leaf to a new position in ONE tree operation. The leaf
 * keeps its identity (no remount) and the tree never passes through the
 * collapsed single-pane state — the trap where a two-pane rearrange rewrote
 * the stationary pane's path through the plain-tab conversion. Null when the
 * move is meaningless: unknown leaf, moving onto itself, or the only leaf.
 */
export function moveLeaf(
  root: StageNode,
  leafId: string,
  target: SplitTarget,
  edge: SplitEdge,
): StageNode | null {
  const leaf = findLeaf(root, leafId);
  if (!leaf) return null;
  if (target !== "root" && target.leafId === leafId) return null;
  const without = removeLeaf(root, leafId);
  if (!without) return null;
  const res = insertNode(without, target, edge, leaf);
  return res ? res.root : null;
}

function insertNode(
  root: StageNode,
  target: SplitTarget,
  edge: SplitEdge,
  fresh: StageLeaf,
): { root: StageNode; leafId: string } | null {
  const dir = edgeDir(edge);
  const before = edgeBefore(edge);

  if (target === "root") {
    if (root.type === "split" && root.dir === dir) {
      const share = 100 / (root.children.length + 1);
      const children = before ? [fresh, ...root.children] : [...root.children, fresh];
      const scaled = root.sizes.map((s) => s * (1 - share / 100));
      const sizes = before ? [share, ...scaled] : [...scaled, share];
      return { root: normalize({ ...root, children, sizes: renormalize(sizes) }), leafId: fresh.id };
    }
    // Wrapping a whole arrangement: the newcomer takes a modest share of a
    // multi-pane stage, an even half of a single pane.
    const share = root.type === "split" ? 32 : 50;
    const branch: StageBranch = {
      type: "split",
      id: newLeafId(),
      dir,
      children: before ? [fresh, root] : [root, fresh],
      sizes: before ? [share, 100 - share] : [100 - share, share],
    };
    return { root: normalize(branch), leafId: fresh.id };
  }

  const insert = (node: StageNode): StageNode | null => {
    if (node.type === "leaf") {
      if (node.id !== target.leafId) return null;
      const branch: StageBranch = {
        type: "split",
        id: newLeafId(),
        dir,
        children: before ? [fresh, node] : [node, fresh],
        sizes: [50, 50],
      };
      return branch;
    }
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (child.type === "leaf" && child.id === target.leafId && node.dir === dir) {
        // Parent already runs this way: the pair shares the leaf's slot.
        const half = (node.sizes[i] ?? 100 / node.children.length) / 2;
        const children = [...node.children];
        const sizes = [...node.sizes];
        children.splice(before ? i : i + 1, 0, fresh);
        sizes[i] = half;
        sizes.splice(before ? i : i + 1, 0, half);
        return { ...node, children, sizes };
      }
      const replaced = insert(child);
      if (replaced) {
        const children = [...node.children];
        children[i] = replaced;
        return { ...node, children };
      }
    }
    return null;
  };

  const next = insert(root);
  return next ? { root: normalize(next), leafId: fresh.id } : null;
}

/**
 * Remove a leaf. Its share flows back to its siblings proportionally; a branch
 * left with one child hoists it. Null when the last leaf was removed — the
 * caller drops the layout and the tab is a plain single-path tab again.
 */
export function removeLeaf(root: StageNode, leafId: string): StageNode | null {
  if (root.type === "leaf") return root.id === leafId ? null : root;
  const strip = (node: StageBranch): StageNode | null => {
    const children: StageNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((child, i) => {
      const share = node.sizes[i] ?? 100 / node.children.length;
      if (child.type === "leaf") {
        if (child.id === leafId) return; // dropped; renormalize spreads its share
        children.push(child);
        sizes.push(share);
        return;
      }
      const next = strip(child);
      if (next) {
        children.push(next);
        sizes.push(share);
      }
    });
    if (children.length === 0) return null;
    return { ...node, children, sizes: renormalize(sizes) };
  };
  const next = strip(root);
  return next ? normalize(next) : null;
}

export function setLeafPath(root: StageNode, leafId: string, path: string): StageNode {
  if (root.type === "leaf") return root.id === leafId ? { ...root, path } : root;
  let changed = false;
  const children = root.children.map((c) => {
    const next = setLeafPath(c, leafId, path);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...root, children } : root;
}

/** Replace one branch's sizes (a resize-handle drag). Values renormalize. */
export function setBranchSizes(root: StageNode, branchId: string, sizes: number[]): StageNode {
  if (root.type === "leaf") return root;
  if (root.id === branchId) {
    if (sizes.length !== root.children.length) return root;
    return { ...root, sizes: renormalize(sizes) };
  }
  let changed = false;
  const children = root.children.map((c) => {
    const next = setBranchSizes(c, branchId, sizes);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...root, children } : root;
}

// ---------------------------------------------------------------------------
// Geometry
//
// Leaves render FLAT: absolutely positioned cells whose percent rects come
// from one walk of the tree. Structure changes morph cells via CSS transitions
// instead of remounting content, and the drop preview runs the same function
// over a predicted tree — layout and preview share one geometry.
// ---------------------------------------------------------------------------

export type PctRect = { left: number; top: number; width: number; height: number };

export type StageHandleGeom = {
  branchId: string;
  /** Boundary after child `index` (drag adjusts sizes[index]/sizes[index+1]). */
  index: number;
  dir: SplitDir;
  /** Zero-thickness boundary line; the renderer centers a grab strip on it. */
  rect: PctRect;
  /** The whole branch's cell — a drag's pixel delta converts to a share of
   *  this extent. */
  branchRect: PctRect;
};

export type StageGeometry = {
  leaves: Array<{ id: string; path: string; rect: PctRect }>;
  handles: StageHandleGeom[];
};

export function stageGeometry(root: StageNode): StageGeometry {
  const leaves: StageGeometry["leaves"] = [];
  const handles: StageHandleGeom[] = [];
  const walk = (node: StageNode, rect: PctRect) => {
    if (node.type === "leaf") {
      leaves.push({ id: node.id, path: node.path, rect });
      return;
    }
    let offset = 0;
    node.children.forEach((child, i) => {
      const share = node.sizes[i] ?? 100 / node.children.length;
      const cell: PctRect =
        node.dir === "row"
          ? {
              left: rect.left + (rect.width * offset) / 100,
              top: rect.top,
              width: (rect.width * share) / 100,
              height: rect.height,
            }
          : {
              left: rect.left,
              top: rect.top + (rect.height * offset) / 100,
              width: rect.width,
              height: (rect.height * share) / 100,
            };
      walk(child, cell);
      offset += share;
      if (i < node.children.length - 1) {
        handles.push({
          branchId: node.id,
          index: i,
          dir: node.dir,
          rect:
            node.dir === "row"
              ? { left: rect.left + (rect.width * offset) / 100, top: rect.top, width: 0, height: rect.height }
              : { left: rect.left, top: rect.top + (rect.height * offset) / 100, width: rect.width, height: 0 },
          branchRect: rect,
        });
      }
    });
  };
  walk(root, { left: 0, top: 0, width: 100, height: 100 });
  return { leaves, handles };
}

// ---------------------------------------------------------------------------
// Drop-zone resolution — shared by the drop layer and its preview.
// ---------------------------------------------------------------------------

export type DropZone =
  | { kind: "center"; leafId: string }
  | { kind: "edge"; leafId: string; edge: SplitEdge }
  | { kind: "root"; edge: SplitEdge };

/** Fraction of a pane's span that reads as an edge band. */
const EDGE_BAND = 0.26;
/** Pixels from the stage bounds that read as a whole-stage split. */
const ROOT_BAND_PX = 20;

/**
 * Which drop zone a pointer position means, given the current geometry and the
 * stage's pixel size. `x`/`y` are pixels within the stage.
 */
export function resolveDropZone(
  geo: StageGeometry,
  stage: { width: number; height: number },
  x: number,
  y: number,
): DropZone | null {
  if (stage.width <= 0 || stage.height <= 0) return null;
  const multi = geo.leaves.length > 1;
  if (multi) {
    if (x < ROOT_BAND_PX) return { kind: "root", edge: "left" };
    if (x > stage.width - ROOT_BAND_PX) return { kind: "root", edge: "right" };
    if (y < ROOT_BAND_PX) return { kind: "root", edge: "top" };
    if (y > stage.height - ROOT_BAND_PX) return { kind: "root", edge: "bottom" };
  }
  const px = (x / stage.width) * 100;
  const py = (y / stage.height) * 100;
  const leaf = geo.leaves.find(
    (l) => px >= l.rect.left && px <= l.rect.left + l.rect.width && py >= l.rect.top && py <= l.rect.top + l.rect.height,
  );
  if (!leaf) return null;
  // Position within the leaf, 0..1 per axis.
  const fx = (px - leaf.rect.left) / leaf.rect.width;
  const fy = (py - leaf.rect.top) / leaf.rect.height;
  // Bands rank by aspect-corrected (pixel-space) nearness so a wide pane
  // doesn't make top/bottom unreachable — but ANY band containing the pointer
  // may win: testing only the nearest one carved dead zones out of the long
  // edges of stretched panes (a failed nearer band shadowed a valid one).
  const leafW = (leaf.rect.width / 100) * stage.width;
  const leafH = (leaf.rect.height / 100) * stage.height;
  const bands: Array<{ edge: SplitEdge; depth: number; rawDepth: number }> = [
    { edge: "left", depth: fx, rawDepth: fx },
    { edge: "right", depth: 1 - fx, rawDepth: 1 - fx },
    { edge: "top", depth: fy * (leafH / leafW), rawDepth: fy },
    { edge: "bottom", depth: (1 - fy) * (leafH / leafW), rawDepth: 1 - fy },
  ];
  bands.sort((a, b) => a.depth - b.depth);
  for (const band of bands) {
    if (band.rawDepth <= EDGE_BAND) return { kind: "edge", leafId: leaf.id, edge: band.edge };
  }
  return { kind: "center", leafId: leaf.id };
}

/**
 * The geometry a drop would produce, plus which cell is the newcomer — what
 * the preview animates toward. A center drop keeps the geometry and marks the
 * target. Null when the zone can't apply (missing leaf).
 */
export function predictDrop(
  root: StageNode,
  zone: DropZone,
  path: string,
): { geometry: StageGeometry; newLeafId: string } | null {
  if (zone.kind === "center") {
    const leaf = findLeaf(root, zone.leafId);
    if (!leaf) return null;
    return { geometry: stageGeometry(root), newLeafId: zone.leafId };
  }
  if (countLeaves(root) >= MAX_STAGE_LEAVES) return null;
  const res = insertLeaf(root, zone.kind === "root" ? "root" : { leafId: zone.leafId }, zone.edge, path);
  if (!res) return null;
  return { geometry: stageGeometry(res.root), newLeafId: res.leafId };
}

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

/**
 * Validate a persisted layout (tabs sync across clients and versions). Returns
 * a normalized tree, or undefined for anything malformed — the tab then falls
 * back to its plain path, which is always present.
 */
export function sanitizeLayout(raw: unknown, isValidPath?: (p: string) => boolean): StageNode | undefined {
  const seen = new Set<string>();
  const valid = (node: unknown, depth: number): StageNode | null => {
    if (!node || typeof node !== "object" || depth > 6) return null;
    const n = node as Record<string, unknown>;
    if (n.type === "leaf") {
      if (typeof n.id !== "string" || !n.id || typeof n.path !== "string" || !n.path) return null;
      if (seen.has(n.id)) return null;
      if (isValidPath && !isValidPath(n.path)) return null;
      seen.add(n.id);
      return { type: "leaf", id: n.id, path: n.path };
    }
    if (n.type === "split") {
      if (typeof n.id !== "string" || !n.id || (n.dir !== "row" && n.dir !== "col") || !Array.isArray(n.children)) return null;
      const children: StageNode[] = [];
      for (const c of n.children) {
        const cc = valid(c, depth + 1);
        if (!cc) return null;
        children.push(cc);
      }
      if (children.length < 1) return null;
      const sizes = Array.isArray(n.sizes) && n.sizes.length === children.length && n.sizes.every((s) => typeof s === "number" && isFinite(s) && s >= 0)
        ? (n.sizes as number[])
        : children.map(() => 100 / children.length);
      return { type: "split", id: n.id, dir: n.dir, children, sizes: renormalize(sizes) };
    }
    return null;
  };
  const root = valid(raw, 0);
  if (!root) return undefined;
  if (countLeaves(root) > MAX_STAGE_LEAVES) return undefined;
  return normalize(root);
}
