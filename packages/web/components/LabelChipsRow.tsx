"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Plus, X, Tag } from "lucide-react";
import {
  useInboxStore,
  useTrackedStore,
  isConvexId,
  sortLabels,
  computeReorderUpdates,
  type BucketItem,
} from "../store/inboxStore";
import { getLabelColor } from "../lib/labelColors";

// The session-panel header's filter chips: manual labels (draggable to
// reorder, hover ✕ to delete, drop target for session cards), an inline
// create input, then auto-derived project chips.
//
// Overflow: the row never scrolls. Chips that don't fit are detected with an
// IntersectionObserver against the row container and hidden outright; a "+N"
// pill (always visible, after the row) opens a popover holding the FULL list —
// filter, reorder, delete, and create all work there too, so nothing clipped
// is ever out of reach. When the ACTIVE filter's chip is among the hidden,
// the +N pill carries the accent so filter state can't silently disappear.
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

  // ── Inline label creation ────────────────────────────────────────────────
  const [creatingLabel, setCreatingLabel] = useState(false);
  const [newLabelName, setNewLabelName] = useState("");
  const commitNewLabel = useCallback(() => {
    const name = newLabelName.trim();
    setCreatingLabel(false);
    setNewLabelName("");
    if (!name) return;
    useInboxStore.getState().createBucket({ name })
      .then(() => toast.success(`Created label "${name}"`))
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
  // Chips carry their own dataTransfer type so a chip drag and a session-card
  // drag can share the same targets without ambiguity.
  const [reorderHint, setReorderHint] = useState<{ overId: string; after: boolean } | null>(null);
  const [dragOverBucketId, setDragOverBucketId] = useState<string | null>(null);

  const applyReorder = useCallback((draggedId: string, overId: string, after: boolean) => {
    const ordered = sortLabels(useInboxStore.getState().buckets);
    const fromIndex = ordered.findIndex((b) => b._id === draggedId);
    const overIndex = ordered.findIndex((b) => b._id === overId);
    if (fromIndex < 0 || overIndex < 0) return;
    const insertion = overIndex + (after ? 1 : 0);
    const finalIndex = fromIndex < insertion ? insertion - 1 : insertion;
    const updates = computeReorderUpdates(ordered, fromIndex, finalIndex);
    const store = useInboxStore.getState();
    for (const u of updates) store.updateBucket(u.id, { sort_order: u.sort_order });
  }, []);

  const labelChipDragOver = useCallback((bucket: BucketItem, horizontal: boolean) => (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("codecast/label-id")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = e.currentTarget.getBoundingClientRect();
      const after = horizontal
        ? e.clientX > rect.left + rect.width / 2
        : e.clientY > rect.top + rect.height / 2;
      setReorderHint({ overId: bucket._id, after });
      return;
    }
    if (e.dataTransfer.types.includes("codecast/session-id")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOverBucketId(bucket._id);
    }
  }, []);

  const labelChipDrop = useCallback((bucket: BucketItem) => (e: React.DragEvent) => {
    setDragOverBucketId(null);
    setReorderHint(null);
    const labelId = e.dataTransfer.getData("codecast/label-id");
    if (labelId) {
      e.preventDefault();
      if (labelId !== bucket._id && reorderHint?.overId === bucket._id) {
        applyReorder(labelId, bucket._id, reorderHint.after);
      }
      return;
    }
    const sessionId = e.dataTransfer.getData("codecast/session-id");
    if (sessionId) {
      e.preventDefault();
      dropSessionOnLabel(sessionId, bucket._id);
    }
  }, [applyReorder, dropSessionOnLabel, reorderHint]);

  const clearDragHints = useCallback(() => {
    setReorderHint(null);
    setDragOverBucketId(null);
  }, []);

  // ── Overflow detection ───────────────────────────────────────────────────
  const rowRef = useRef<HTMLDivElement | null>(null);
  const ioRef = useRef<IntersectionObserver | null>(null);
  const chipEls = useRef<Map<string, HTMLElement>>(new Map());
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(() => new Set());

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

  const chipRef = useCallback((key: string) => (el: HTMLElement | null) => {
    const prev = chipEls.current.get(key);
    if (prev && prev !== el) ioRef.current?.unobserve(prev);
    if (el) {
      el.dataset.chipkey = key;
      chipEls.current.set(key, el);
      ioRef.current?.observe(el);
    } else {
      chipEls.current.delete(key);
      setHiddenKeys((cur) => {
        if (!cur.has(key)) return cur;
        const next = new Set(cur);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const hiddenCount = hiddenKeys.size;
  const activeFilterHidden =
    (s.activeBucketFilter && hiddenKeys.has(`label:${s.activeBucketFilter}`)) ||
    (s.activeProjectFilter && hiddenKeys.has(`project:${s.activeProjectFilter}`));

  // ── Overflow popover ─────────────────────────────────────────────────────
  const [popoverOpen, setPopoverOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
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

  const reorderShadow = (bucketId: string, horizontal: boolean): React.CSSProperties | undefined => {
    if (reorderHint?.overId !== bucketId) return undefined;
    if (horizontal) {
      return { boxShadow: reorderHint.after ? "inset -2px 0 0 var(--sol-cyan)" : "inset 2px 0 0 var(--sol-cyan)" };
    }
    return { boxShadow: reorderHint.after ? "inset 0 -2px 0 var(--sol-cyan)" : "inset 0 2px 0 var(--sol-cyan)" };
  };

  const labelChip = (bucket: BucketItem) => {
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
        }}
        onDragEnd={clearDragHints}
        onClick={() => useInboxStore.getState().setActiveBucketFilter(active ? null : bucket._id)}
        onDragOver={labelChipDragOver(bucket, true)}
        onDragLeave={() => setDragOverBucketId((cur) => (cur === bucket._id ? null : cur))}
        onDrop={labelChipDrop(bucket)}
        style={reorderShadow(bucket._id, true)}
        className={`group flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] transition-all flex items-center gap-1 ${
          hiddenKeys.has(key) ? "invisible pointer-events-none" : ""
        } ${
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
        <span className="ml-0.5 opacity-50 group-hover:hidden tabular-nums">{count}</span>
        <span
          role="button"
          onClick={deleteLabel(bucket)}
          title={`Delete label "${bucket.name}"`}
          className="ml-0.5 hidden group-hover:inline-flex items-center text-current opacity-60 hover:opacity-100 hover:text-sol-red"
        >
          <X className="w-2.5 h-2.5" />
        </span>
      </button>
    );
  };

  return (
    <div className="relative flex-1 min-w-0 flex items-center gap-1">
      <div ref={rowRef} className="flex gap-1 overflow-hidden min-w-0 items-center">
        {visibleBuckets.map(labelChip)}
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
              className={`flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] transition-all flex items-center gap-1 ${
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

      {hiddenCount > 0 && (
        <button
          onClick={() => setPopoverOpen((v) => !v)}
          title={`${hiddenCount} more — view all labels & projects`}
          className={`flex-shrink-0 px-1.5 py-0.5 rounded-full text-[10px] tabular-nums transition-colors border ${
            activeFilterHidden
              ? "border-sol-cyan/60 bg-sol-cyan/15 text-sol-cyan font-medium"
              : "border-sol-border/50 bg-sol-bg/70 text-sol-text-dim hover:text-sol-text hover:border-sol-border"
          }`}
        >
          +{hiddenCount}
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
          {visibleBuckets.map((bucket) => {
            const bc = getLabelColor(bucket.name);
            const active = s.activeBucketFilter === bucket._id;
            return (
              <div
                key={bucket._id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("codecast/label-id", bucket._id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={clearDragHints}
                onDragOver={labelChipDragOver(bucket, false)}
                onDrop={labelChipDrop(bucket)}
                onClick={() => {
                  useInboxStore.getState().setActiveBucketFilter(active ? null : bucket._id);
                  setPopoverOpen(false);
                }}
                style={reorderShadow(bucket._id, false)}
                className={`group flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer transition-colors ${
                  dragOverBucketId === bucket._id
                    ? "bg-sol-cyan/10"
                    : active
                      ? "bg-sol-cyan/10 text-sol-text"
                      : "text-sol-text-muted hover:bg-sol-bg-alt/60"
                }`}
                title="Click to filter — drag to reorder"
              >
                <span className="text-sol-text-dim/40 cursor-grab select-none leading-none">⠿</span>
                <span className={`w-2 h-2 rounded-[2px] flex-shrink-0 ${bc.dot}`} />
                <span className={`flex-1 truncate ${active ? "font-medium" : ""}`}>{bucket.name}</span>
                <span className="text-[10px] tabular-nums text-sol-text-dim/70">{bucketCounts[bucket._id] || 0}</span>
                <span
                  role="button"
                  onClick={deleteLabel(bucket)}
                  title={`Delete label "${bucket.name}"`}
                  className="hidden group-hover:inline-flex items-center text-sol-text-dim hover:text-sol-red"
                >
                  <X className="w-3 h-3" />
                </span>
              </div>
            );
          })}
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
