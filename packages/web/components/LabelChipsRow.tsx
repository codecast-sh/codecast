"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Plus, X, Tag, Filter, FilterX, EyeOff, Trash2, ChevronRight } from "lucide-react";
import {
  useInboxStore,
  useTrackedStore,
  sortLabels,
  computeReorderUpdates,
  isConvexId,
  chipBucketFilters,
  type BucketItem,
} from "../store/inboxStore";
import { getLabelColor } from "../lib/labelColors";
import { ContextMenu, useContextMenu, CtxItem, CtxHeader, CtxSeparator } from "./ui/context-menu";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { isMac } from "../shortcuts";

type ChipCtxPayload =
  | { kind: "label"; bucket: BucketItem }
  | { kind: "project"; name: string };

// The session-panel header's filter chips: manual labels (draggable to
// reorder, hover ✕ to delete, drop target for session cards), an inline
// create input, then auto-derived project chips.
//
// Zero-count labels don't render in the row (unless they're the active
// filter) — they live in the +N popover instead, which is their full
// management surface: filter, reorder, delete, AND session drops (the pill
// auto-opens the popover on drag-hover so empty labels stay drop-reachable).
//
// Overflow: the row never scrolls. Chips that don't fit are detected with an
// IntersectionObserver against the row container and hidden outright; a "+N"
// pill (always visible, after the row) opens a popover holding the FULL list —
// filter, reorder, delete, and create all work there too, so nothing clipped
// is ever out of reach. When the ACTIVE filter's chip is among the hidden,
// the +N pill carries the accent so filter state can't silently disappear.
//
// Reorder UX: dragging a label chip opens a real gap at the insertion point —
// chips at/after it slide right (transform transition, so they glide back and
// forth as you move) and a divider line renders inside the gap. Same pattern
// vertically in the popover.
const REORDER_GAP = 14;

export function LabelChipsRow({
  bucketCounts,
  projectCounts,
  projectPathByName,
  dropSessionOnLabel,
}: {
  bucketCounts: Record<string, number>;
  projectCounts: Array<[string, number]>;
  projectPathByName: Record<string, string>;
  dropSessionOnLabel: (draggedId: string, bucketId: string | null) => void;
}) {
  const s = useTrackedStore([
    st => st.buckets,
    st => st.activeBucketFilter,
    st => st.activeProjectFilter,
    st => st.chipFilterExclude,
    st => st.extraBucketFilters,
  ]);
  const visibleBuckets = useMemo(() => sortLabels(s.buckets), [s.buckets]);
  // The label filter as a list (head chip + shift-added terms) — each chip
  // finds its own entry here to know whether it's active and in which polarity.
  const labelFilters = useMemo(
    () => chipBucketFilters(s),
    [s.activeBucketFilter, s.chipFilterExclude, s.extraBucketFilters],
  );

  // Click is a pure toggle: include the chip, click again to clear. Exclude
  // ("everything but this") is a deliberate gesture — ⌥/Alt-click, or the
  // right-click menu — never a state the plain click cycles through. Clicking
  // a chip that is THE filter in either mode clears it, so a click's result
  // never surprises: same chip = off, different chip = on (a plain click on a
  // multi-term filter collapses it to just the clicked chip). ⇧ makes the
  // gesture ADDITIVE instead: toggle this label in the include list, ⇧⌥ in
  // the negative list.
  const toggleBucket = useCallback((bucketId: string, alt?: boolean, shift?: boolean) => {
    const store = useInboxStore.getState();
    if (shift) {
      store.toggleBucketFilterTerm(bucketId, !!alt);
      return;
    }
    const filters = chipBucketFilters(store);
    const sole = filters.length === 1 && filters[0].id === bucketId;
    if (alt) {
      if (sole && filters[0].exclude) store.setActiveBucketFilter(null);
      else store.setActiveBucketFilter(bucketId, true);
    } else {
      store.setActiveBucketFilter(sole ? null : bucketId);
    }
  }, []);
  const toggleProject = useCallback((name: string, path: string | null, alt?: boolean) => {
    const store = useInboxStore.getState();
    const active = store.activeProjectFilter === name;
    if (alt) {
      if (active && store.chipFilterExclude) store.setActiveProjectFilter(null, null);
      else store.setActiveProjectFilter(name, path, true);
    } else {
      if (active) store.setActiveProjectFilter(null, null);
      else store.setActiveProjectFilter(name, path);
    }
  }, []);
  // Modifier-click hints, rendered as real keycaps (never bare glyphs in text).
  const clickHint = (...mods: string[]) => (
    <span className="flex items-center gap-[3px]">
      {mods.map((m) => <KeyCap key={m} size="xs">{m}</KeyCap>)}
      <KeyCap size="xs">click</KeyCap>
    </span>
  );
  const altClickHint = clickHint(isMac ? "⌥" : "Alt");
  const shiftClickHint = clickHint("⇧");
  const shiftAltClickHint = clickHint("⇧", isMac ? "⌥" : "Alt");

  // Labels created inline THIS session stay row-visible at count 0 — creating
  // a chip that instantly vanishes into +N is broken feedback. The exemption
  // ends when the label is ✕'d (archived labels leave visibleBuckets; the
  // stale set entry is harmless and lets an Undo restore visibility too).
  const [freshLabelIds, setFreshLabelIds] = useState<Set<string>>(() => new Set());

  // Zero-count labels disappear from the row (unless they're the active
  // filter or freshly created) but stay in the +N popover, which remains
  // their management surface — delete, reorder, and session-drop all still
  // work there. The pill counts them so an empty label is never unreachable.
  const rowBucketIds = useMemo(() => {
    const ids = new Set<string>();
    for (const b of visibleBuckets) {
      // Non-Convex ids are optimistic create-stubs — inherently fresh, visible
      // from the instant Enter is pressed until the server row supersedes.
      if ((bucketCounts[b._id] || 0) > 0 || labelFilters.some((t) => t.id === b._id) || freshLabelIds.has(b._id) || !isConvexId(b._id)) ids.add(b._id);
    }
    return ids;
  }, [visibleBuckets, bucketCounts, labelFilters, freshLabelIds]);
  const zeroHiddenCount = visibleBuckets.length - rowBucketIds.size;

  // ── Inline label creation ────────────────────────────────────────────────
  const [creatingLabel, setCreatingLabel] = useState(false);
  const [newLabelName, setNewLabelName] = useState("");
  const commitNewLabel = useCallback(() => {
    const name = newLabelName.trim();
    setCreatingLabel(false);
    setNewLabelName("");
    if (!name) return;
    useInboxStore.getState().createBucket({ name })
      .then((r: any) => {
        if (r?.bucketId) setFreshLabelIds((prev) => new Set(prev).add(r.bucketId));
        toast.success(`Created label "${name}"`);
      })
      .catch(() => toast.error("Couldn't create label"));
  }, [newLabelName]);

  // ── Delete (archive) ─────────────────────────────────────────────────────
  const performDeleteLabel = useCallback((bucket: BucketItem) => {
    const store = useInboxStore.getState();
    // Pull the label out of the filter list first: sole term clears the
    // filter, a multi-term list just loses this entry (head removal promotes).
    const filters = chipBucketFilters(store);
    const term = filters.find((t) => t.id === bucket._id);
    if (term) {
      if (filters.length === 1) store.setActiveBucketFilter(null);
      else store.toggleBucketFilterTerm(bucket._id, term.exclude);
    }
    store.updateBucket(bucket._id, { archived_at: Date.now() });
    toast.success(`Deleted label "${bucket.name}"`, {
      action: { label: "Undo", onClick: () => useInboxStore.getState().updateBucket(bucket._id, { archived_at: null }) },
    });
  }, []);
  const deleteLabel = useCallback((bucket: BucketItem) => (e: React.MouseEvent) => {
    e.stopPropagation();
    performDeleteLabel(bucket);
  }, [performDeleteLabel]);

  // ── Right-click menu (one instance serves every chip in the row) ─────────
  const ctxMenu = useContextMenu<ChipCtxPayload>();

  // ── Label drag-reorder ───────────────────────────────────────────────────
  // The row (not individual chips) owns reorder dragover: insertion index is
  // derived from pointer position vs chip midpoints, which also covers the
  // gaps between chips. Chips keep their own handlers for session-card drops.
  const [draggingLabelId, setDraggingLabelId] = useState<string | null>(null);
  // Insertion gap: index into visibleBuckets (0..n) + a line coordinate in the
  // positioning container's coordinate space.
  const [rowHint, setRowHint] = useState<{ index: number; x: number } | null>(null);
  const [popHint, setPopHint] = useState<{ index: number; y: number } | null>(null);
  const [dragOverBucketId, setDragOverBucketId] = useState<string | null>(null);

  const clearDragState = useCallback(() => {
    setDraggingLabelId(null);
    setRowHint(null);
    setPopHint(null);
    setDragOverBucketId(null);
  }, []);

  const applyReorder = useCallback((draggedId: string, insertion: number) => {
    const ordered = sortLabels(useInboxStore.getState().buckets);
    const fromIndex = ordered.findIndex((b) => b._id === draggedId);
    if (fromIndex < 0) return;
    const finalIndex = fromIndex < insertion ? insertion - 1 : insertion;
    const updates = computeReorderUpdates(ordered, fromIndex, finalIndex);
    const store = useInboxStore.getState();
    for (const u of updates) store.updateBucket(u.id, { sort_order: u.sort_order });
  }, []);

  // ── Chip element registry (stable per-key ref callbacks!) ────────────────
  // A fresh ref callback per render makes React detach/reattach every chip on
  // every render — which both thrashes the IntersectionObserver and wiped the
  // hidden-set (the "+N never appears" bug). Callbacks are minted once per key.
  const rowRef = useRef<HTMLDivElement | null>(null);
  const ioRef = useRef<IntersectionObserver | null>(null);
  const chipEls = useRef<Map<string, HTMLElement>>(new Map());
  const refCache = useRef<Map<string, (el: HTMLElement | null) => void>>(new Map());
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(() => new Set());

  const chipRef = (key: string) => {
    let cb = refCache.current.get(key);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        const prev = chipEls.current.get(key);
        if (el) {
          if (prev && prev !== el) ioRef.current?.unobserve(prev);
          el.dataset.chipkey = key;
          chipEls.current.set(key, el);
          ioRef.current?.observe(el);
        } else {
          if (prev) ioRef.current?.unobserve(prev);
          chipEls.current.delete(key);
          setHiddenKeys((cur) => {
            if (!cur.has(key)) return cur;
            const next = new Set(cur);
            next.delete(key);
            return next;
          });
        }
      };
      refCache.current.set(key, cb);
    }
    return cb;
  };

  useEffect(() => {
    if (!rowRef.current || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      setHiddenKeys((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.chipkey;
          if (!key) continue;
          const hidden = entry.intersectionRatio < 0.98;
          if (hidden && !next.has(key)) { next.add(key); changed = true; }
          if (!hidden && next.has(key)) { next.delete(key); changed = true; }
        }
        return changed ? next : prev;
      });
    }, { root: rowRef.current, threshold: [0.98] });
    ioRef.current = io;
    for (const el of chipEls.current.values()) io.observe(el);
    return () => { io.disconnect(); ioRef.current = null; };
  }, []);

  const hiddenCount = hiddenKeys.size;
  const activeFilterHidden =
    (s.activeBucketFilter && hiddenKeys.has(`label:${s.activeBucketFilter}`)) ||
    (s.activeProjectFilter && hiddenKeys.has(`project:${s.activeProjectFilter}`));

  // The first chip that overflows the row's right edge. Unlike the rest of the
  // hidden chips, this one stays PAINTED — clipped in place where it sits (flush
  // after the last fully-visible chip) and dissolved into the +N pill by the
  // row's right-edge mask. So the slack reads as "the list keeps going" — a faded
  // half-label — instead of going blank. It's the first hidden label/project in
  // render order (left→right); the inline create "+" never plays this role.
  const peekKey = useMemo(() => {
    const ordered: string[] = [];
    for (const b of visibleBuckets) if (rowBucketIds.has(b._id)) ordered.push(`label:${b._id}`);
    ordered.push("create");
    for (const [name] of projectCounts) ordered.push(`project:${name}`);
    const first = ordered.find((k) => hiddenKeys.has(k));
    if (!first || first === "create") return null;
    // The active filter, when hidden, is already pinned separately above — don't
    // also render it as the faded peek.
    if (first === `label:${s.activeBucketFilter}` || first === `project:${s.activeProjectFilter}`) return null;
    return first;
  }, [visibleBuckets, rowBucketIds, projectCounts, hiddenKeys, s.activeBucketFilter, s.activeProjectFilter]);

  // ── Row-level reorder dragover: insertion index from chip midpoints ──────
  const rowDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("codecast/label-id")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const labels = sortLabels(useInboxStore.getState().buckets);
    let index = labels.length;
    for (let i = 0; i < labels.length; i++) {
      const el = chipEls.current.get(`label:${labels[i]._id}`);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (e.clientX < rect.left + rect.width / 2) { index = i; break; }
    }
    // Line x in the outer (relative) wrapper's space: the insertion boundary
    // is the target chip's UNSHIFTED left edge (transforms don't move offsets),
    // or just past the last chip when inserting at the end.
    let x: number;
    if (index < labels.length) {
      const el = chipEls.current.get(`label:${labels[index]._id}`);
      x = el ? el.offsetLeft + REORDER_GAP / 2 - 4 : 0;
    } else {
      const last = chipEls.current.get(`label:${labels[labels.length - 1]?._id}`);
      x = last ? last.offsetLeft + last.offsetWidth + 3 : 0;
    }
    setRowHint((cur) => (cur?.index === index && cur.x === x ? cur : { index, x }));
  }, []);

  const rowDrop = useCallback((e: React.DragEvent) => {
    const labelId = e.dataTransfer.getData("codecast/label-id");
    if (labelId && rowHint) {
      e.preventDefault();
      applyReorder(labelId, rowHint.index);
    }
    clearDragState();
  }, [rowHint, applyReorder, clearDragState]);

  const rowDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setRowHint(null);
  }, []);

  // Slide chips at/after the insertion point rightward to open the gap. The
  // dragged chip itself dims in place instead of collapsing (no layout jump).
  const chipShift = (labelIndex: number): React.CSSProperties => ({
    transform: rowHint && labelIndex >= rowHint.index ? `translateX(${REORDER_GAP}px)` : undefined,
    transition: "transform 150ms ease",
  });

  // ── Overflow popover ─────────────────────────────────────────────────────
  // Rendered through a portal with fixed positioning: the chips row lives
  // inside a layout panel whose sibling panels form their own stacking
  // contexts, so an absolutely-positioned dropdown gets painted over by a
  // neighboring panel no matter its z-index. Anchored to the row's right edge.
  const [popoverOpen, setPopoverOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const popRowEls = useRef<Map<string, HTMLElement>>(new Map());
  const POPOVER_WIDTH = 256; // w-64
  // Empty labels (not in rowBucketIds) are tucked behind a collapsed "N empty"
  // row in the popover — the list defaults to labels that hold something.
  // Expanding restores the FULL sortLabels order, so the index-based reorder
  // gap math is untouched. Collapses again on every close.
  const [emptyOpen, setEmptyOpen] = useState(false);
  useEffect(() => {
    if (!popoverOpen) setEmptyOpen(false);
  }, [popoverOpen]);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!popoverOpen) { setPopoverPos(null); return; }
    const place = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPopoverPos({
        top: rect.bottom + 6,
        left: Math.max(8, rect.right - POPOVER_WIDTH),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [popoverOpen]);
  useEffect(() => {
    if (!popoverOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) setPopoverOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); setPopoverOpen(false); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [popoverOpen]);

  const popDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("codecast/label-id")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const labels = sortLabels(useInboxStore.getState().buckets);
    let index = labels.length;
    for (let i = 0; i < labels.length; i++) {
      const el = popRowEls.current.get(labels[i]._id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) { index = i; break; }
    }
    let y: number;
    if (index < labels.length) {
      const el = popRowEls.current.get(labels[index]._id);
      y = el ? el.offsetTop + REORDER_GAP / 2 - 4 : 0;
    } else {
      // Trailing labels can be tucked away (collapsed empties) — anchor the
      // end-of-list line on the last row that is actually rendered.
      let last: HTMLElement | undefined;
      for (let i = labels.length - 1; i >= 0 && !last; i--) last = popRowEls.current.get(labels[i]._id);
      y = last ? last.offsetTop + last.offsetHeight + 3 : 0;
    }
    setPopHint((cur) => (cur?.index === index && cur.y === y ? cur : { index, y }));
  }, []);

  const popDrop = useCallback((e: React.DragEvent) => {
    const labelId = e.dataTransfer.getData("codecast/label-id");
    if (labelId && popHint) {
      e.preventDefault();
      applyReorder(labelId, popHint.index);
    }
    clearDragState();
  }, [popHint, applyReorder, clearDragState]);

  const popRowShift = (labelIndex: number): React.CSSProperties => ({
    transform: popHint && labelIndex >= popHint.index ? `translateY(${REORDER_GAP}px)` : undefined,
    transition: "transform 150ms ease",
  });

  // ── Chips ────────────────────────────────────────────────────────────────
  const labelChip = (bucket: BucketItem, index: number) => {
    const bc = getLabelColor(bucket.name);
    const term = labelFilters.find((t) => t.id === bucket._id);
    const active = !!term;
    const excluded = !!term?.exclude;
    const sole = active && labelFilters.length === 1;
    const count = bucketCounts[bucket._id] || 0;
    const key = `label:${bucket._id}`;
    return (
      <button
        key={bucket._id}
        ref={chipRef(key)}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("codecast/label-id", bucket._id);
          e.dataTransfer.effectAllowed = "move";
          setDraggingLabelId(bucket._id);
        }}
        onDragEnd={clearDragState}
        onClick={(e) => toggleBucket(bucket._id, e.altKey, e.shiftKey)}
        onContextMenu={(e) => ctxMenu.open(e, { kind: "label", bucket })}
        onDragOver={(e) => {
          // Session-card drops target the chip itself; label reorders are
          // handled by the row (gap math) and just pass through here.
          if (e.dataTransfer.types.includes("codecast/session-id")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDragOverBucketId(bucket._id);
          }
        }}
        onDragLeave={() => setDragOverBucketId((cur) => (cur === bucket._id ? null : cur))}
        onDrop={(e) => {
          const sessionId = e.dataTransfer.getData("codecast/session-id");
          if (sessionId) {
            e.preventDefault();
            e.stopPropagation();
            setDragOverBucketId(null);
            dropSessionOnLabel(sessionId, bucket._id);
          }
        }}
        style={chipShift(index)}
        className={`group flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] flex items-center gap-1 ${
          hiddenKeys.has(key) && key !== peekKey ? "invisible pointer-events-none" : ""
        } ${draggingLabelId === bucket._id ? "opacity-30" : ""} ${
          dragOverBucketId === bucket._id
            ? `ring-1 ring-sol-cyan ${bc.bg} ${bc.text}`
            : active
              ? `${bc.bg} ${bc.text}`
              : count === 0
                ? "bg-gray-400/10 text-gray-400/60 hover:bg-gray-400/20 hover:text-gray-500"
                : "bg-gray-400/10 text-gray-400 hover:bg-gray-400/20 hover:text-gray-500"
        }`}
        title={
          excluded
            ? sole ? `Hiding "${bucket.name}" — click to clear` : `Hiding "${bucket.name}" — click to focus only it`
            : active
              ? sole ? `Filtering to "${bucket.name}" — click to clear` : `In filter — click to focus only "${bucket.name}"`
              : `Label: ${bucket.name} — click to filter, right-click for more, drag to reorder`
        }
      >
        {/* Exclude keeps the filter's colors; the dot flattens into a minus
            bar ("without this"). bg-current inherits the chip's label-colored
            text, and the fixed 1.5 width keeps the chip size constant. */}
        <span className={`w-1.5 flex-shrink-0 ${excluded ? "h-[2px] rounded-full bg-current" : `h-1.5 rounded-[2px] ${bc.dot}`} ${active ? "" : "opacity-50"}`} />
        {/* Bold invisible twin reserves the active state's text width so the
            chip is the SAME width in all three filter states — toggling never
            shifts the row under the pointer. */}
        <span className="inline-grid">
          <span aria-hidden className="invisible font-medium col-start-1 row-start-1">{bucket.name}</span>
          <span className={`col-start-1 row-start-1 ${active ? "font-medium" : ""} ${excluded ? "opacity-75" : ""}`}>{bucket.name}</span>
        </span>
        {/* Fixed-width slot: the ✕ overlays the count on hover instead of
            replacing it, so the chip never changes size and the row never
            shifts under the pointer. */}
        <span className="ml-0.5 relative inline-flex items-center justify-center min-w-[10px]">
          <span className="opacity-50 group-hover:opacity-0 tabular-nums">{count}</span>
          <span
            role="button"
            onClick={deleteLabel(bucket)}
            title={`Delete label "${bucket.name}"`}
            className="absolute inset-0 hidden group-hover:flex items-center justify-center text-current opacity-60 hover:opacity-100 hover:text-sol-red"
          >
            <X className="w-2.5 h-2.5" />
          </span>
        </span>
      </button>
    );
  };

  return (
    <div ref={anchorRef} className="relative flex-1 min-w-0 flex items-center">
      {/* Clip shell: everything in-flow (row, pinned active chip, +N pill) is
          hard-clipped at the component's edge so nothing can bleed under the
          panel's icon cluster at narrow widths. The popover lives outside the
          shell — clipping it would cut the dropdown off. */}
      <div className="flex-1 min-w-0 flex items-center gap-1 overflow-hidden">
      <div
        ref={rowRef}
        // flex-1 (basis 0): the row claims only the space LEFT OVER after the
        // pinned active chip and the +N pill take their natural width — its
        // chips just hide into +N when squeezed, so it collapses first and the
        // pinned chip ellipsizes only when it and the pill alone don't fit.
        className="flex flex-1 gap-1 overflow-hidden min-w-0 items-center"
        // When a chip overflows, soften the row's right edge so that boundary
        // chip dissolves into the +N pill instead of ending on a hard clip.
        style={peekKey ? {
          WebkitMaskImage: "linear-gradient(to right, #000 calc(100% - 28px), transparent 100%)",
          maskImage: "linear-gradient(to right, #000 calc(100% - 28px), transparent 100%)",
        } : undefined}
        onDragOver={rowDragOver}
        onDragLeave={rowDragLeave}
        onDrop={rowDrop}
      >
        {/* Index stays in full-list space so reorder gap math (rowHint.index)
            lines up even with zero-count chips filtered out. */}
        {visibleBuckets.map((bucket, i) => (rowBucketIds.has(bucket._id) ? labelChip(bucket, i) : null))}
        {creatingLabel ? (
          <input
            autoFocus
            value={newLabelName}
            onChange={(e) => setNewLabelName(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commitNewLabel();
              if (e.key === "Escape") { setCreatingLabel(false); setNewLabelName(""); }
            }}
            onBlur={() => { setCreatingLabel(false); setNewLabelName(""); }}
            placeholder="new label…"
            className="flex-shrink-0 w-24 px-2 py-0.5 rounded-full text-[10px] bg-sol-bg border border-sol-cyan/50 text-sol-text placeholder:text-sol-text-dim/60 outline-none"
          />
        ) : (
          <button
            ref={chipRef("create")}
            onClick={() => setCreatingLabel(true)}
            title="New label"
            style={rowHint ? { transform: `translateX(${REORDER_GAP}px)`, transition: "transform 150ms ease" } : { transition: "transform 150ms ease" }}
            className={`flex-shrink-0 p-1 rounded-full text-sol-text-dim/50 hover:text-sol-cyan hover:bg-sol-cyan/10 transition-colors ${hiddenKeys.has("create") ? "invisible pointer-events-none" : ""}`}
          >
            <Plus className="w-2.5 h-2.5" />
          </button>
        )}
        {projectCounts.map(([name, count]) => {
          const pc = getLabelColor(name);
          const active = s.activeProjectFilter === name;
          const excluded = active && s.chipFilterExclude;
          const key = `project:${name}`;
          return (
            <button
              key={name}
              ref={chipRef(key)}
              onClick={(e) => toggleProject(name, projectPathByName[name] || null, e.altKey)}
              onContextMenu={(e) => ctxMenu.open(e, { kind: "project", name })}
              style={rowHint ? { transform: `translateX(${REORDER_GAP}px)`, transition: "transform 150ms ease" } : { transition: "transform 150ms ease" }}
              className={`flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] flex items-center gap-1 ${
                hiddenKeys.has(key) && key !== peekKey ? "invisible pointer-events-none" : ""
              } ${
                active
                  ? `${pc.bg} ${pc.text}`
                  : "bg-gray-400/10 text-gray-400 hover:bg-gray-400/20 hover:text-gray-500"
              }`}
              title={
                excluded
                  ? `Hiding "${name}" — click to clear`
                  : active
                    ? `Filtering to "${name}" — click to clear`
                    : `Project: ${name} — click to filter, right-click to hide`
              }
            >
              {/* Same exclude cues + constant-width construction as the label
                  chips above. */}
              <span className={`w-1.5 flex-shrink-0 ${excluded ? "h-[2px] rounded-full bg-current" : `h-1.5 rounded-full ${pc.dot}`} ${active ? "" : "opacity-50"}`} />
              <span className="inline-grid">
                <span aria-hidden className="invisible font-medium col-start-1 row-start-1">{name}</span>
                <span className={`col-start-1 row-start-1 ${active ? "font-medium" : ""} ${excluded ? "opacity-75" : ""}`}>{name}</span>
              </span>
              <span className="ml-0.5 opacity-50">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Insertion divider — rendered in the gap the sliding chips opened. */}
      {rowHint && (
        <div
          className="absolute top-[3px] bottom-[3px] w-[2px] rounded-full bg-sol-cyan pointer-events-none"
          style={{ left: rowHint.x }}
        />
      )}

      {/* The active filter's chip, pinned OUTSIDE the clipped row whenever its
          in-row twin is hidden — what's selected is always visible, without
          mutating the user's order. Resizing wider un-hides the in-row chip
          and this pin dissolves automatically. */}
      {activeFilterHidden && (() => {
        const excluded = s.chipFilterExclude;
        const activeBucket = s.activeBucketFilter ? visibleBuckets.find((b) => b._id === s.activeBucketFilter) : undefined;
        if (activeBucket) {
          const bc = getLabelColor(activeBucket.name);
          return (
            <button
              onClick={(e) => toggleBucket(activeBucket._id, e.altKey, e.shiftKey)}
              onContextMenu={(e) => ctxMenu.open(e, { kind: "label", bucket: activeBucket })}
              title={excluded ? `Hiding "${activeBucket.name}" — click to clear` : `Filtering to "${activeBucket.name}" — click to clear`}
              className={`group min-w-0 px-2 py-0.5 rounded-full text-[10px] flex items-center gap-1 font-medium ${bc.bg} ${bc.text}`}
            >
              <span className={`w-1.5 flex-shrink-0 ${excluded ? "h-[2px] rounded-full bg-current" : `h-1.5 rounded-[2px] ${bc.dot}`}`} />
              <span className={`truncate ${excluded ? "opacity-75" : ""}`}>{activeBucket.name}</span>
              <span className="ml-0.5 relative inline-flex flex-shrink-0 items-center justify-center min-w-[10px]">
                <span className="opacity-50 group-hover:opacity-0 tabular-nums">{bucketCounts[activeBucket._id] || 0}</span>
                <span className="absolute inset-0 hidden group-hover:flex items-center justify-center opacity-70">
                  <X className="w-2.5 h-2.5" />
                </span>
              </span>
            </button>
          );
        }
        const activeProject = s.activeProjectFilter ? projectCounts.find(([name]) => name === s.activeProjectFilter) : undefined;
        if (!activeProject) return null;
        const pc = getLabelColor(activeProject[0]);
        return (
          <button
            onClick={(e) => toggleProject(activeProject[0], projectPathByName[activeProject[0]] || null, e.altKey)}
            onContextMenu={(e) => ctxMenu.open(e, { kind: "project", name: activeProject[0] })}
            title={excluded ? `Hiding "${activeProject[0]}" — click to clear` : `Filtering to "${activeProject[0]}" — click to clear`}
            className={`min-w-0 px-2 py-0.5 rounded-full text-[10px] flex items-center gap-1 font-medium ${pc.bg} ${pc.text}`}
          >
            <span className={`w-1.5 flex-shrink-0 ${excluded ? "h-[2px] rounded-full bg-current" : `h-1.5 rounded-full ${pc.dot}`}`} />
            <span className={`truncate ${excluded ? "opacity-75" : ""}`}>{activeProject[0]}</span>
            <span className="ml-0.5 opacity-50 tabular-nums flex-shrink-0">{activeProject[1]}</span>
          </button>
        );
      })()}

      {hiddenCount + zeroHiddenCount > 0 && (
        <button
          onClick={() => setPopoverOpen((v) => !v)}
          onDragOver={(e) => {
            // Hidden (clipped or zero-count) labels are still drop targets:
            // hovering the pill mid-drag opens the popover, where every label
            // accepts session drops.
            if (
              e.dataTransfer.types.includes("codecast/session-id") ||
              e.dataTransfer.types.includes("codecast/label-id")
            ) {
              e.preventDefault();
              setPopoverOpen(true);
              // The drag may be headed for an empty label — untuck them.
              setEmptyOpen(true);
            }
          }}
          title={`${hiddenCount + zeroHiddenCount} more — view all labels & projects`}
          // ml-auto pins the pill to the row's right edge: when chips don't fill
          // the width, the slack opens up to its LEFT (chips stay clustered with
          // the active-filter pin). Collapses to 0 when the row is full, so the
          // overflow/narrow case is unchanged.
          className="flex-shrink-0 ml-auto px-1.5 py-0.5 rounded-full text-[10px] tabular-nums transition-colors border border-sol-border/50 bg-sol-bg/70 text-sol-text-dim hover:text-sol-text hover:border-sol-border"
        >
          +{hiddenCount + zeroHiddenCount}
        </button>
      )}
      </div>

      {popoverOpen && popoverPos && createPortal(
        <div
          ref={popoverRef}
          style={{ top: popoverPos.top, left: popoverPos.left }}
          className="fixed z-[9999] w-64 max-h-[60vh] overflow-y-auto rounded-lg border border-sol-border/70 bg-sol-bg shadow-2xl shadow-black/30 py-1"
        >
          <div className="px-3 pt-1.5 pb-1 text-[9px] font-semibold uppercase tracking-widest text-sol-text-dim/70 flex items-center gap-1.5">
            <Tag className="w-2.5 h-2.5" /> Labels
          </div>
          {visibleBuckets.length === 0 && (
            <div className="px-3 py-1.5 text-[11px] text-sol-text-dim">No labels yet</div>
          )}
          <div
            className="relative"
            onDragOver={popDragOver}
            onDragLeave={(e) => {
              if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) return;
              setPopHint(null);
            }}
            onDrop={popDrop}
          >
            {visibleBuckets.map((bucket, i) => {
              // Tucked-away empty label: keep i (full-list index) for the rows
              // that do render so the reorder shift math stays aligned.
              if (!emptyOpen && !rowBucketIds.has(bucket._id)) return null;
              const bc = getLabelColor(bucket.name);
              const term = labelFilters.find((t) => t.id === bucket._id);
              const active = !!term;
              const excluded = !!term?.exclude;
              return (
                <div
                  key={bucket._id}
                  ref={(el) => {
                    if (el) popRowEls.current.set(bucket._id, el);
                    else popRowEls.current.delete(bucket._id);
                  }}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("codecast/label-id", bucket._id);
                    e.dataTransfer.effectAllowed = "move";
                    setDraggingLabelId(bucket._id);
                  }}
                  onDragEnd={clearDragState}
                  onClick={(e) => {
                    toggleBucket(bucket._id, e.altKey, e.shiftKey);
                    if (!e.shiftKey) setPopoverOpen(false);
                  }}
                  // The popover sits at z-9999 and would paint over the menu —
                  // hand the interaction off to the menu instead.
                  onContextMenu={(e) => {
                    ctxMenu.open(e, { kind: "label", bucket });
                    setPopoverOpen(false);
                  }}
                  onDragOver={(e) => {
                    // Session-card drops land on popover rows too — for
                    // zero-count labels (hidden from the row) this is the only
                    // drop target. Label reorders pass through to the
                    // container's gap math.
                    if (e.dataTransfer.types.includes("codecast/session-id")) {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setDragOverBucketId(bucket._id);
                    }
                  }}
                  onDragLeave={() => setDragOverBucketId((cur) => (cur === bucket._id ? null : cur))}
                  onDrop={(e) => {
                    const sessionId = e.dataTransfer.getData("codecast/session-id");
                    if (sessionId) {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOverBucketId(null);
                      setPopoverOpen(false);
                      dropSessionOnLabel(sessionId, bucket._id);
                    }
                  }}
                  style={popRowShift(i)}
                  className={`group flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer ${
                    draggingLabelId === bucket._id ? "opacity-30" : ""
                  } ${
                    dragOverBucketId === bucket._id
                      ? "ring-1 ring-inset ring-sol-cyan bg-sol-cyan/10 text-sol-text"
                      : active ? "bg-sol-cyan/10 text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt/60"
                  }`}
                  title={excluded ? "Hidden — click to clear" : active ? "Filtering — click to clear" : "Click to filter — right-click to hide, drag to reorder"}
                >
                  <span className="text-sol-text-dim/40 cursor-grab select-none leading-none">⠿</span>
                  <span className={`w-2 flex-shrink-0 ${excluded ? `h-[2px] rounded-full ${bc.dot}` : `h-2 rounded-[2px] ${bc.dot}`}`} />
                  <span className={`flex-1 truncate ${active ? "font-medium" : ""} ${excluded ? "opacity-75" : ""}`}>{bucket.name}</span>
                  <span className="text-[10px] tabular-nums text-sol-text-dim/70">{bucketCounts[bucket._id] || 0}</span>
                  {/* Fixed slot — ✕ appears without shifting the count. */}
                  <span className="w-3 inline-flex items-center justify-center">
                    <span
                      role="button"
                      onClick={deleteLabel(bucket)}
                      title={`Delete label "${bucket.name}"`}
                      className="hidden group-hover:inline-flex items-center text-sol-text-dim hover:text-sol-red"
                    >
                      <X className="w-3 h-3" />
                    </span>
                  </span>
                </div>
              );
            })}
            {popHint && (
              <div
                className="absolute left-2 right-2 h-[2px] rounded-full bg-sol-cyan pointer-events-none"
                style={{ top: popHint.y }}
              />
            )}
          </div>
          {zeroHiddenCount > 0 && (
            <button
              onClick={() => setEmptyOpen((v) => !v)}
              onDragOver={(e) => {
                // A dragged session may be headed for an empty label — this
                // popover is its only drop target, so reveal them mid-drag.
                if (e.dataTransfer.types.includes("codecast/session-id")) {
                  e.preventDefault();
                  setEmptyOpen(true);
                }
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[10px] text-sol-text-dim/70 hover:text-sol-text hover:bg-sol-bg-alt/60"
              title={emptyOpen ? "Tuck empty labels away" : "Show labels with no sessions"}
            >
              <ChevronRight className={`w-3 h-3 transition-transform ${emptyOpen ? "rotate-90" : ""}`} />
              <span className="tabular-nums">{zeroHiddenCount} empty</span>
            </button>
          )}
          <div className="px-3 py-1.5">
            <input
              value={newLabelName}
              onChange={(e) => setNewLabelName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commitNewLabel();
              }}
              placeholder="+ new label…"
              className="w-full px-2 py-1 rounded-md text-[11px] bg-sol-bg-alt/50 border border-sol-border/40 text-sol-text placeholder:text-sol-text-dim/60 outline-none focus:border-sol-cyan/50"
            />
          </div>
          {projectCounts.length > 0 && (
            <>
              <div className="mt-0.5 border-t border-sol-border/40 px-3 pt-2 pb-1 text-[9px] font-semibold uppercase tracking-widest text-sol-text-dim/70">
                Projects
              </div>
              {projectCounts.map(([name, count]) => {
                const pc = getLabelColor(name);
                const active = s.activeProjectFilter === name;
                const excluded = active && s.chipFilterExclude;
                return (
                  <div
                    key={name}
                    onClick={(e) => {
                      toggleProject(name, projectPathByName[name] || null, e.altKey);
                      setPopoverOpen(false);
                    }}
                    onContextMenu={(e) => {
                      ctxMenu.open(e, { kind: "project", name });
                      setPopoverOpen(false);
                    }}
                    className={`flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer transition-colors ${
                      active ? "bg-sol-cyan/10 text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt/60"
                    }`}
                    title={excluded ? "Hidden — click to clear" : active ? "Filtering — click to clear" : "Click to filter — right-click to hide"}
                  >
                    <span className="w-3" />
                    <span className={`w-2 flex-shrink-0 ${excluded ? `h-[2px] rounded-full ${pc.dot}` : `h-2 rounded-full ${pc.dot}`}`} />
                    <span className={`flex-1 truncate ${active ? "font-medium" : ""} ${excluded ? "opacity-75" : ""}`}>{name}</span>
                    <span className="text-[10px] tabular-nums text-sol-text-dim/70">{count}</span>
                  </div>
                );
              })}
            </>
          )}
        </div>,
        document.body
      )}

      <ContextMenu state={ctxMenu}>
        {(p) => {
          // Include and exclude are peers in the menu; whichever is currently
          // active swaps for its "clear" counterpart, so exactly one item ever
          // reads as an undo.
          if (p.kind === "label") {
            const term = labelFilters.find((t) => t.id === p.bucket._id);
            const sole = !!term && labelFilters.length === 1;
            const inOtherFilter = labelFilters.length > 0 && !term;
            return (
              <>
                <CtxHeader title={p.bucket.name} />
                {term && !term.exclude ? (
                  sole ? (
                    <CtxItem icon={FilterX} onSelect={() => useInboxStore.getState().setActiveBucketFilter(null)}>
                      Clear filter
                    </CtxItem>
                  ) : (
                    <CtxItem
                      icon={FilterX}
                      trailing={shiftClickHint}
                      onSelect={() => useInboxStore.getState().toggleBucketFilterTerm(p.bucket._id, false)}
                    >
                      Remove from filter
                    </CtxItem>
                  )
                ) : (
                  <CtxItem icon={Filter} onSelect={() => useInboxStore.getState().setActiveBucketFilter(p.bucket._id)}>
                    Filter by this label
                  </CtxItem>
                )}
                {/* Additive verbs, only while some other filter is on — the
                    menu twin of ⇧-click / ⇧⌥-click. */}
                {inOtherFilter && (
                  <CtxItem
                    icon={Filter}
                    trailing={shiftClickHint}
                    onSelect={() => useInboxStore.getState().toggleBucketFilterTerm(p.bucket._id, false)}
                  >
                    Add to filter
                  </CtxItem>
                )}
                {term?.exclude ? (
                  <CtxItem
                    icon={FilterX}
                    onSelect={() => {
                      const store = useInboxStore.getState();
                      if (sole) store.setActiveBucketFilter(null);
                      else store.toggleBucketFilterTerm(p.bucket._id, true);
                    }}
                  >
                    Stop hiding
                  </CtxItem>
                ) : (
                  <CtxItem
                    icon={EyeOff}
                    trailing={altClickHint}
                    onSelect={() => useInboxStore.getState().setActiveBucketFilter(p.bucket._id, true)}
                  >
                    Hide this label
                  </CtxItem>
                )}
                {inOtherFilter && (
                  <CtxItem
                    icon={EyeOff}
                    trailing={shiftAltClickHint}
                    onSelect={() => useInboxStore.getState().toggleBucketFilterTerm(p.bucket._id, true)}
                  >
                    Also hide this label
                  </CtxItem>
                )}
                <CtxSeparator />
                <CtxItem danger icon={Trash2} onSelect={() => performDeleteLabel(p.bucket)}>
                  Delete label
                </CtxItem>
              </>
            );
          }
          const active = s.activeProjectFilter === p.name;
          const excluded = active && s.chipFilterExclude;
          return (
            <>
              <CtxHeader title={p.name} />
              {active && !excluded ? (
                <CtxItem icon={FilterX} onSelect={() => useInboxStore.getState().setActiveProjectFilter(null, null)}>
                  Clear filter
                </CtxItem>
              ) : (
                <CtxItem
                  icon={Filter}
                  onSelect={() => useInboxStore.getState().setActiveProjectFilter(p.name, projectPathByName[p.name] || null)}
                >
                  Filter by project
                </CtxItem>
              )}
              {excluded ? (
                <CtxItem icon={FilterX} onSelect={() => useInboxStore.getState().setActiveProjectFilter(null, null)}>
                  Stop hiding
                </CtxItem>
              ) : (
                <CtxItem
                  icon={EyeOff}
                  trailing={altClickHint}
                  onSelect={() => useInboxStore.getState().setActiveProjectFilter(p.name, projectPathByName[p.name] || null, true)}
                >
                  Hide this project
                </CtxItem>
              )}
            </>
          );
        }}
      </ContextMenu>
    </div>
  );
}
