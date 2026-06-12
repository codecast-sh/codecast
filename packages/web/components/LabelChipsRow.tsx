"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Plus, X, Tag } from "lucide-react";
import {
  useInboxStore,
  useTrackedStore,
  sortLabels,
  computeReorderUpdates,
  isConvexId,
  type BucketItem,
} from "../store/inboxStore";
import { getLabelColor } from "../lib/labelColors";

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
  ]);
  const visibleBuckets = useMemo(() => sortLabels(s.buckets), [s.buckets]);

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
      if ((bucketCounts[b._id] || 0) > 0 || s.activeBucketFilter === b._id || freshLabelIds.has(b._id) || !isConvexId(b._id)) ids.add(b._id);
    }
    return ids;
  }, [visibleBuckets, bucketCounts, s.activeBucketFilter, freshLabelIds]);
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
        if (r?._id) setFreshLabelIds((prev) => new Set(prev).add(r._id));
        toast.success(`Created label "${name}"`);
      })
      .catch(() => toast.error("Couldn't create label"));
  }, [newLabelName]);

  // ── Delete (archive) ─────────────────────────────────────────────────────
  const deleteLabel = useCallback((bucket: BucketItem) => (e: React.MouseEvent) => {
    e.stopPropagation();
    const store = useInboxStore.getState();
    if (store.activeBucketFilter === bucket._id) store.setActiveBucketFilter(null);
    store.updateBucket(bucket._id, { archived_at: Date.now() });
    toast.success(`Deleted label "${bucket.name}"`, {
      action: { label: "Undo", onClick: () => useInboxStore.getState().updateBucket(bucket._id, { archived_at: null }) },
    });
  }, []);

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
  const [popoverOpen, setPopoverOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const popRowEls = useRef<Map<string, HTMLElement>>(new Map());
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
      const last = popRowEls.current.get(labels[labels.length - 1]?._id);
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
    const active = s.activeBucketFilter === bucket._id;
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
        onClick={() => useInboxStore.getState().setActiveBucketFilter(active ? null : bucket._id)}
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
          hiddenKeys.has(key) ? "invisible pointer-events-none" : ""
        } ${draggingLabelId === bucket._id ? "opacity-30" : ""} ${
          dragOverBucketId === bucket._id
            ? `ring-1 ring-sol-cyan ${bc.bg} ${bc.text}`
            : active
              ? `${bc.bg} ${bc.text} font-medium`
              : count === 0
                ? "bg-gray-400/10 text-gray-400/60 hover:bg-gray-400/20 hover:text-gray-500"
                : "bg-gray-400/10 text-gray-400 hover:bg-gray-400/20 hover:text-gray-500"
        }`}
        title={`Label: ${bucket.name} — drag to reorder`}
      >
        <span className={`w-1.5 h-1.5 rounded-[2px] ${bc.dot} ${active ? "" : "opacity-50"}`} />
        {bucket.name}
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
    <div className="relative flex-1 min-w-0 flex items-center gap-1">
      <div
        ref={rowRef}
        className="flex gap-1 overflow-hidden min-w-0 items-center"
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
          const key = `project:${name}`;
          return (
            <button
              key={name}
              ref={chipRef(key)}
              onClick={() => {
                const next = active ? null : name;
                useInboxStore.getState().setActiveProjectFilter(next, next ? (projectPathByName[name] || null) : null);
              }}
              style={rowHint ? { transform: `translateX(${REORDER_GAP}px)`, transition: "transform 150ms ease" } : { transition: "transform 150ms ease" }}
              className={`flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] flex items-center gap-1 ${
                hiddenKeys.has(key) ? "invisible pointer-events-none" : ""
              } ${
                active
                  ? `${pc.bg} ${pc.text} font-medium`
                  : "bg-gray-400/10 text-gray-400 hover:bg-gray-400/20 hover:text-gray-500"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${pc.dot} ${active ? "" : "opacity-50"}`} />
              {name}
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
        const activeBucket = s.activeBucketFilter ? visibleBuckets.find((b) => b._id === s.activeBucketFilter) : undefined;
        if (activeBucket) {
          const bc = getLabelColor(activeBucket.name);
          return (
            <button
              onClick={() => useInboxStore.getState().setActiveBucketFilter(null)}
              title={`Filtering by "${activeBucket.name}" — click to clear`}
              className={`group flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] flex items-center gap-1 font-medium ${bc.bg} ${bc.text}`}
            >
              <span className={`w-1.5 h-1.5 rounded-[2px] ${bc.dot}`} />
              {activeBucket.name}
              <span className="ml-0.5 relative inline-flex items-center justify-center min-w-[10px]">
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
            onClick={() => useInboxStore.getState().setActiveProjectFilter(null, null)}
            title={`Filtering by "${activeProject[0]}" — click to clear`}
            className={`flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] flex items-center gap-1 font-medium ${pc.bg} ${pc.text}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${pc.dot}`} />
            {activeProject[0]}
            <span className="ml-0.5 opacity-50 tabular-nums">{activeProject[1]}</span>
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
            }
          }}
          title={`${hiddenCount + zeroHiddenCount} more — view all labels & projects`}
          className="flex-shrink-0 px-1.5 py-0.5 rounded-full text-[10px] tabular-nums transition-colors border border-sol-border/50 bg-sol-bg/70 text-sol-text-dim hover:text-sol-text hover:border-sol-border"
        >
          +{hiddenCount + zeroHiddenCount}
        </button>
      )}

      {popoverOpen && (
        <div
          ref={popoverRef}
          className="absolute right-0 top-full mt-1.5 z-50 w-64 max-h-[60vh] overflow-y-auto rounded-lg border border-sol-border/70 bg-sol-bg shadow-2xl shadow-black/30 py-1"
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
              const bc = getLabelColor(bucket.name);
              const active = s.activeBucketFilter === bucket._id;
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
                  onClick={() => {
                    useInboxStore.getState().setActiveBucketFilter(active ? null : bucket._id);
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
                  title="Click to filter — drag to reorder"
                >
                  <span className="text-sol-text-dim/40 cursor-grab select-none leading-none">⠿</span>
                  <span className={`w-2 h-2 rounded-[2px] flex-shrink-0 ${bc.dot}`} />
                  <span className={`flex-1 truncate ${active ? "font-medium" : ""}`}>{bucket.name}</span>
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
                return (
                  <div
                    key={name}
                    onClick={() => {
                      const next = active ? null : name;
                      useInboxStore.getState().setActiveProjectFilter(next, next ? (projectPathByName[name] || null) : null);
                      setPopoverOpen(false);
                    }}
                    className={`flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer transition-colors ${
                      active ? "bg-sol-cyan/10 text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt/60"
                    }`}
                  >
                    <span className="w-3" />
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${pc.dot}`} />
                    <span className={`flex-1 truncate ${active ? "font-medium" : ""}`}>{name}</span>
                    <span className="text-[10px] tabular-nums text-sol-text-dim/70">{count}</span>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
