"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { showUndoToast } from "../store/undoStack";
import { undoAsOne } from "../store/undoActions";
import { Check, ChevronLeft, ChevronRight, EyeOff, Filter, FilterX, ListFilter, Plus, Search, Trash2, X } from "lucide-react";
import {
  useInboxStore,
  useTrackedStore,
  sortLabels,
  computeReorderUpdates,
  isConvexId,
  chipBucketFilters,
  chipProjectFilters,
  type BucketItem,
} from "../store/inboxStore";
import { clickBucketChip, clickProjectChip } from "../store/chipFilterClicks";
import { projectChipLabel, workProjectIdOfChipKey } from "../store/workProjects";
import { useRouter } from "next/navigation";
import { getLabelColor } from "../lib/labelColors";
import { OWNS_MODIFIER_CLICK } from "../lib/openIntent";
import { folderShortList, type FolderActivity } from "../lib/railFolderFilter";
import { ContextMenu, useContextMenu, CtxItem, CtxHeader, CtxSeparator } from "./ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { KeyCap, ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { isMac } from "../shortcuts";

type ChipCtxPayload =
  | { kind: "label"; bucket: BucketItem }
  | { kind: "project"; name: string };

// The session rail's filter: ONE quiet "Filter" button in the panel header
// that opens one menu. It replaced a row of label and folder chips, which put
// every folder a session ever ran in (scratch folders named after prompts or
// UUIDs included) in front of the person all the time.
//
// The menu leads with the five folders the person works in most over the last
// 30 days (lib/railFolderFilter), then "All folders…", which swaps the menu to
// the full list with a search field. Labels follow in their own group, with
// "New label…". Every chip capability survives in the menu:
//   - click filters to one term; ⇧-click adds or removes a term and keeps the
//     menu open; ⌥-click hides (the same keys work with Enter on the keyboard);
//   - right-click opens the shared chip menu (filter, add, hide, delete label);
//   - labels drag to reorder, and a session card dragged onto the button opens
//     the menu so it can be dropped on a label.
// While a filter is on, the button names it ("littlebird", "Not littlebird",
// "growth +1") and a × beside it clears it, so a narrowed list never passes
// for the plain inbox.

/** The modifier keys behind the click or Enter that picked a menu item. */
type Mods = { alt: boolean; shift: boolean };

export function LabelChipsRow({
  bucketCounts,
  projectCounts,
  projectPathByName,
  projectActivity,
  dropSessionOnLabel,
}: {
  bucketCounts: Record<string, number>;
  projectCounts: Array<[string, number]>;
  projectPathByName: Record<string, string>;
  projectActivity?: Record<string, FolderActivity>;
  dropSessionOnLabel: (draggedId: string, bucketId: string | null) => void;
}) {
  const s = useTrackedStore([
    st => st.buckets,
    // Titles for project entries (`pj:` keys); the collection changes rarely.
    st => st.projects,
    st => st.activeBucketFilter,
    st => st.activeProjectFilter,
    st => st.chipFilterExclude,
    st => st.extraBucketFilters,
    st => st.activeProjectPath,
    st => st.extraProjectFilters,
  ]);
  const labels = useMemo(() => sortLabels(s.buckets), [s.buckets]);
  const router = useRouter();
  // The project axis holds Codecast projects (`pj:` keys, shown by their
  // title, store/workProjects) and folders (where a session ran).
  const chipLabel = (name: string) => projectChipLabel(name, s.projects);
  const workProjects = useMemo(() => projectCounts.filter(([name]) => workProjectIdOfChipKey(name)), [projectCounts]);
  const folders = useMemo(() => projectCounts.filter(([name]) => !workProjectIdOfChipKey(name)), [projectCounts]);
  const labelFilters = useMemo(
    () => chipBucketFilters(s),
    [s.activeBucketFilter, s.chipFilterExclude, s.extraBucketFilters],
  );
  const projectFilters = useMemo(
    () => chipProjectFilters(s),
    [s.activeProjectFilter, s.activeProjectPath, s.chipFilterExclude, s.extraProjectFilters],
  );

  const [open, setOpen] = useState(false);
  // "main": short folder list + labels. "folders": every folder, searchable.
  const [view, setView] = useState<"main" | "folders">("main");
  const [query, setQuery] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);
  const [creatingLabel, setCreatingLabel] = useState(false);
  const [newLabelName, setNewLabelName] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  // Set when the menu closes to hand the pointer to the right-click menu, so
  // the trigger doesn't take focus back out from under it.
  const handingOff = useRef(false);
  // Whether the last thing done inside the menu was with the pointer. A
  // mouse pick doesn't hand focus back to the button (that would ring it and
  // pop its tooltip after every pick); a keyboard pick does.
  const pointerUsed = useRef(false);
  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      setView("main");
      setQuery("");
      setShowEmpty(false);
      setCreatingLabel(false);
      setNewLabelName("");
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

  // ── Modifier-aware picking ───────────────────────────────────────────────
  // Radix turns Enter into a synthetic click with no modifier keys, so the
  // keys held with Enter are kept here and read by the click that follows.
  const keyMods = useRef<Mods | null>(null);
  const pickProps = (apply: (m: Mods) => void) => {
    let last: Mods = { alt: false, shift: false };
    return {
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") keyMods.current = { alt: e.altKey, shift: e.shiftKey };
      },
      onClick: (e: React.MouseEvent) => {
        last = { alt: e.altKey || !!keyMods.current?.alt, shift: e.shiftKey || !!keyMods.current?.shift };
        keyMods.current = null;
      },
      onSelect: (e: Event) => {
        apply(last);
        // ⇧ builds a list of terms: the menu stays open for the next one.
        if (last.shift) e.preventDefault();
      },
    };
  };
  const pickFolder = (name: string) =>
    pickProps((m) => clickProjectChip(name, projectPathByName[name] || null, m.alt, m.shift));
  const pickLabel = (id: string) => pickProps((m) => clickBucketChip(id, m.alt, m.shift));

  // ── Right-click: one shared menu for both kinds ──────────────────────────
  const ctxMenu = useContextMenu<ChipCtxPayload>();
  const openCtx = (e: React.MouseEvent, payload: ChipCtxPayload) => {
    handingOff.current = true;
    onOpenChange(false);
    ctxMenu.open(e, payload);
  };

  // ── Labels ───────────────────────────────────────────────────────────────
  // Labels created here THIS session stay listed at count 0 — creating one
  // that instantly tucks itself under "empty" is broken feedback.
  const [freshLabelIds, setFreshLabelIds] = useState<Set<string>>(() => new Set());
  const listedLabelIds = useMemo(() => {
    const ids = new Set<string>();
    for (const b of labels) {
      // Non-Convex ids are optimistic create-stubs, listed from the instant
      // Enter is pressed until the server row supersedes them.
      if ((bucketCounts[b._id] || 0) > 0 || labelFilters.some((t) => t.id === b._id) || freshLabelIds.has(b._id) || !isConvexId(b._id)) ids.add(b._id);
    }
    return ids;
  }, [labels, bucketCounts, labelFilters, freshLabelIds]);
  const emptyCount = labels.length - listedLabelIds.size;

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
    // The archive is the newest undo entry; its toast undoes exactly that.
    showUndoToast(`Deleted label "${bucket.name}"`);
  }, []);

  // Drag a label onto another to move it there (inserted before the row the
  // pointer is above the middle of, after it otherwise).
  const [draggingLabelId, setDraggingLabelId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; after: boolean } | null>(null);
  const [dragOverLabelId, setDragOverLabelId] = useState<string | null>(null);
  const clearDrag = useCallback(() => {
    setDraggingLabelId(null);
    setDropHint(null);
    setDragOverLabelId(null);
  }, []);
  const applyReorder = useCallback((draggedId: string, targetId: string, after: boolean) => {
    const ordered = sortLabels(useInboxStore.getState().buckets);
    const fromIndex = ordered.findIndex((b) => b._id === draggedId);
    const targetIndex = ordered.findIndex((b) => b._id === targetId);
    if (fromIndex < 0 || targetIndex < 0) return;
    const insertion = targetIndex + (after ? 1 : 0);
    const finalIndex = fromIndex < insertion ? insertion - 1 : insertion;
    if (finalIndex === fromIndex) return;
    const updates = computeReorderUpdates(ordered, fromIndex, finalIndex);
    const store = useInboxStore.getState();
    const name = ordered[fromIndex]!.name;
    undoAsOne(`Moved label "${name}"`, () => {
      for (const u of updates) store.updateBucket(u.id, { sort_order: u.sort_order });
    });
  }, []);

  // ── Folders ──────────────────────────────────────────────────────────────
  const countByFolder = useMemo(() => new Map(projectCounts), [projectCounts]);
  const shortFolders = useMemo(() => {
    const list = folderShortList(folders, projectActivity);
    // A folder in the filter always shows here, so it can be seen and undone
    // without a trip to "All folders…".
    for (const t of projectFilters) if (!list.includes(t.id) && !workProjectIdOfChipKey(t.id)) list.push(t.id);
    return list;
  }, [folders, projectActivity, projectFilters]);
  const allFolders = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? folders.filter(([name]) => name.toLowerCase().includes(q)) : folders;
  }, [folders, query]);

  // ── The button's face ────────────────────────────────────────────────────
  const activeTerms = labelFilters.length > 0 ? labelFilters : projectFilters;
  const activeKind: "label" | "project" | null = labelFilters.length > 0 ? "label" : projectFilters.length > 0 ? "project" : null;
  const headTerm = activeTerms[0];
  const headName = !headTerm
    ? null
    : activeKind === "label"
      ? s.buckets[headTerm.id]?.name ?? "label"
      : chipLabel(headTerm.id);
  const faceText = headName ? `${headTerm!.exclude ? "Not " : ""}${headName}` : "Filter";
  const extraCount = activeTerms.length - 1;
  const faceTitle = headName
    ? activeTerms
        .map((t) => `${t.exclude ? "Hiding" : "Showing"} ${activeKind === "label" ? "label" : workProjectIdOfChipKey(t.id) ? "project" : "folder"} "${activeKind === "label" ? s.buckets[t.id]?.name ?? t.id : chipLabel(t.id)}"`)
        .join(", ")
    : "Filter by project, folder or label";
  const clearFilter = () => {
    const store = useInboxStore.getState();
    if (labelFilters.length > 0) store.setActiveBucketFilter(null);
    if (projectFilters.length > 0) store.setActiveProjectFilter(null, null);
  };

  // ── Rows ─────────────────────────────────────────────────────────────────
  const stateIcon = (term: { exclude: boolean } | undefined) => (
    <span className="w-3.5 flex-shrink-0 inline-flex items-center justify-center text-sol-text-secondary">
      {term ? (term.exclude ? <EyeOff className="w-3 h-3" /> : <Check className="w-3 h-3" />) : null}
      {term && <span className="sr-only">{term.exclude ? "Hidden: " : "Selected: "}</span>}
    </span>
  );
  const ROW = "text-[13px] gap-2 px-2 py-1.5 cursor-pointer";
  const COUNT = "ml-auto pl-3 text-meta tabular-nums text-sol-text-dim";

  const folderItem = (name: string) => {
    const term = projectFilters.find((t) => t.id === name);
    return (
      <DropdownMenuItem
        key={name}
        data-filter-folder={name}
        data-term={term ? (term.exclude ? "exclude" : "include") : undefined}
        {...pickFolder(name)}
        onContextMenu={(e) => openCtx(e, { kind: "project", name })}
        className={ROW}
        title={term ? (term.exclude ? "Hidden — click to clear" : "In the filter — click to clear") : `Filter to this ${workProjectIdOfChipKey(name) ? "project" : "folder"} — ⇧-click adds, ⌥-click hides`}
      >
        {stateIcon(term)}
        <span className={`truncate ${term ? "text-sol-text" : ""}`}>{chipLabel(name)}</span>
        <span className={COUNT}>{countByFolder.get(name) ?? 0}</span>
      </DropdownMenuItem>
    );
  };

  const labelItem = (bucket: BucketItem) => {
    const term = labelFilters.find((t) => t.id === bucket._id);
    const hint = dropHint?.id === bucket._id ? dropHint : null;
    return (
      <DropdownMenuItem
        key={bucket._id}
        data-filter-label={bucket._id}
        data-term={term ? (term.exclude ? "exclude" : "include") : undefined}
        {...pickLabel(bucket._id)}
        onContextMenu={(e) => openCtx(e, { kind: "label", bucket })}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("codecast/label-id", bucket._id);
          e.dataTransfer.effectAllowed = "move";
          setDraggingLabelId(bucket._id);
        }}
        onDragEnd={clearDrag}
        onDragOver={(e) => {
          const types = e.dataTransfer.types;
          if (types.includes("codecast/session-id")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDragOverLabelId(bucket._id);
          } else if (types.includes("codecast/label-id")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const after = e.clientY > rect.top + rect.height / 2;
            setDropHint((cur) => (cur?.id === bucket._id && cur.after === after ? cur : { id: bucket._id, after }));
          }
        }}
        onDragLeave={() => {
          setDragOverLabelId((cur) => (cur === bucket._id ? null : cur));
          setDropHint((cur) => (cur?.id === bucket._id ? null : cur));
        }}
        onDrop={(e) => {
          const sessionId = e.dataTransfer.getData("codecast/session-id");
          const labelId = e.dataTransfer.getData("codecast/label-id");
          e.preventDefault();
          e.stopPropagation();
          if (sessionId) {
            dropSessionOnLabel(sessionId, bucket._id);
            onOpenChange(false);
          } else if (labelId && labelId !== bucket._id) {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            applyReorder(labelId, bucket._id, e.clientY > rect.top + rect.height / 2);
          }
          clearDrag();
        }}
        style={hint ? { boxShadow: `inset 0 ${hint.after ? "-2px" : "2px"} 0 0 var(--sol-cyan)` } : undefined}
        className={`${ROW} ${draggingLabelId === bucket._id ? "opacity-40" : ""} ${dragOverLabelId === bucket._id ? "ring-1 ring-inset ring-sol-cyan" : ""}`}
        title={term ? (term.exclude ? "Hidden — click to clear" : "In the filter — click to clear") : "Filter to this label — ⇧-click adds, ⌥-click hides, drag to reorder"}
      >
        {stateIcon(term)}
        <span className={`w-2 h-2 flex-shrink-0 rounded-[2px] ${getLabelColor(bucket.name).dot}`} />
        <span className={`truncate ${term ? "text-sol-text" : ""}`}>{bucket.name}</span>
        <span className={COUNT}>{bucketCounts[bucket._id] || 0}</span>
      </DropdownMenuItem>
    );
  };

  const groupLabel = "px-2 pt-2 pb-1 text-meta font-medium text-sol-text-dim";
  const hasHiddenFolders = folders.length > shortFolders.length;

  return (
    <div data-sv-rail-filter {...OWNS_MODIFIER_CLICK} className="flex min-w-0 flex-shrink items-center">
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <ShortcutTooltip label={faceTitle} side="bottom">
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-sv-filter-button
              data-active={headName ? "true" : undefined}
              aria-label={headName ? `Filter: ${faceText}${extraCount > 0 ? ` and ${extraCount} more` : ""}` : "Filter"}
              onDragOver={(e) => {
                // A session card dragged here opens the menu, whose labels
                // take the drop.
                if (e.dataTransfer.types.includes("codecast/session-id")) {
                  e.preventDefault();
                  if (!open) {
                    setOpen(true);
                    if (emptyCount > 0) setShowEmpty(true);
                  }
                }
              }}
              className={`flex min-w-0 items-center gap-1 h-[22px] px-1.5 rounded-[5px] text-meta font-medium transition-colors data-[state=open]:bg-sol-text/[0.06] ${
                headName
                  ? "bg-sol-text/[0.06] text-sol-text hover:bg-sol-text/[0.09]"
                  : "text-sol-text-secondary hover:text-sol-text hover:bg-sol-text/[0.06]"
              } ${headName ? "rounded-r-none" : ""}`}
            >
              {activeKind === "label" && headName ? (
                <span className={`w-2 h-2 flex-shrink-0 rounded-[2px] ${getLabelColor(headName).dot}`} />
              ) : headTerm?.exclude ? (
                <EyeOff className="w-3 h-3 shrink-0" />
              ) : (
                <ListFilter className="w-3 h-3 shrink-0" />
              )}
              <span className="truncate max-w-[10rem]">{faceText}</span>
              {extraCount > 0 && <span className="shrink-0 tabular-nums text-sol-text-dim">+{extraCount}</span>}
            </button>
          </DropdownMenuTrigger>
        </ShortcutTooltip>
        {headName && (
          <button
            type="button"
            data-sv-rail-filter-clear
            onClick={clearFilter}
            aria-label="Clear filter"
            title="Clear filter"
            className="flex flex-shrink-0 items-center justify-center h-[22px] w-[20px] rounded-[5px] rounded-l-none bg-sol-text/[0.06] text-sol-text-dim hover:text-sol-text hover:bg-sol-text/[0.09] transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
        )}
        <DropdownMenuContent
          {...OWNS_MODIFIER_CLICK}
          data-sv-rail-filter-menu
          align="start"
          className="w-64 p-1"
          onCloseAutoFocus={(e) => {
            if (handingOff.current || pointerUsed.current) e.preventDefault();
            handingOff.current = false;
            pointerUsed.current = false;
          }}
          onPointerDown={() => { pointerUsed.current = true; }}
          onKeyDownCapture={() => { pointerUsed.current = false; }}
          onKeyDown={(e) => {
            // In the folder list, typing goes to the search field wherever
            // focus is (Radix would otherwise jump to an item by its letter).
            if (view !== "folders" || e.target === searchRef.current) return;
            if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              setQuery((q) => q + e.key);
              searchRef.current?.focus();
            }
          }}
        >
          {view === "main" ? (
            <>
              {headName && (
                <>
                  <DropdownMenuItem onSelect={clearFilter} className={ROW}>
                    <FilterX className="w-3.5 h-3.5 text-sol-text-dim" />
                    <span>Clear filter</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              {workProjects.length > 0 && (
                <>
                  {/* Codecast projects: the sessions working in them
                      (store/workProjects). Few, so all of them. */}
                  <DropdownMenuLabel className={groupLabel}>Projects</DropdownMenuLabel>
                  {workProjects.map(([name]) => folderItem(name))}
                  <DropdownMenuSeparator />
                </>
              )}
              {folders.length > 0 && (
                <>
                  {/* A folder is where a session ran (its repo root, else its
                      working directory), not a Codecast project. */}
                  <DropdownMenuLabel className={groupLabel}>Folders</DropdownMenuLabel>
                  {shortFolders.map(folderItem)}
                  {hasHiddenFolders && (
                    <DropdownMenuItem
                      data-filter-all-folders
                      onSelect={(e) => {
                        e.preventDefault();
                        setView("folders");
                        requestAnimationFrame(() => searchRef.current?.focus());
                      }}
                      className={`${ROW} text-sol-text-dim`}
                    >
                      <span className="w-3.5 flex-shrink-0" />
                      <span>All folders…</span>
                      <span className={COUNT}>{folders.length}</span>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuLabel className={groupLabel}>Labels</DropdownMenuLabel>
              {labels.map((b) => (listedLabelIds.has(b._id) || showEmpty ? labelItem(b) : null))}
              {emptyCount > 0 && (
                <DropdownMenuItem
                  onSelect={(e) => {
                    e.preventDefault();
                    setShowEmpty((v) => !v);
                  }}
                  onDragOver={(e) => {
                    // A dragged session may be headed for an empty label.
                    if (e.dataTransfer.types.includes("codecast/session-id")) {
                      e.preventDefault();
                      setShowEmpty(true);
                    }
                  }}
                  className={`${ROW} text-sol-text-dim`}
                >
                  <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showEmpty ? "rotate-90" : ""}`} />
                  <span>{showEmpty ? "Hide empty labels" : `${emptyCount} empty`}</span>
                </DropdownMenuItem>
              )}
              {creatingLabel ? (
                <div className="px-1 py-1">
                  <input
                    autoFocus
                    value={newLabelName}
                    onChange={(e) => setNewLabelName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        setCreatingLabel(false);
                        setNewLabelName("");
                        return;
                      }
                      // Keep typing out of the menu's typeahead and arrow keys.
                      e.stopPropagation();
                      if (e.key === "Enter") commitNewLabel();
                    }}
                    placeholder="Label name"
                    aria-label="New label name"
                    className="w-full h-7 px-2 rounded-md text-[13px] bg-sol-bg border border-sol-border/60 text-sol-text placeholder:text-sol-text-dim outline-none focus:border-sol-cyan/60"
                  />
                </div>
              ) : (
                <DropdownMenuItem
                  data-filter-new-label
                  onSelect={(e) => {
                    e.preventDefault();
                    setCreatingLabel(true);
                  }}
                  className={`${ROW} text-sol-text-dim`}
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>New label…</span>
                </DropdownMenuItem>
              )}
            </>
          ) : (
            <>
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  setView("main");
                  setQuery("");
                }}
                className={`${ROW} text-sol-text-dim`}
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                <span>All folders</span>
              </DropdownMenuItem>
              <div className="sticky -top-1 z-10 -mx-1 px-2 pt-1 pb-1.5 bg-popover border-b border-sol-border/40 mb-1">
                <div className="flex items-center gap-1.5 h-7 px-2 rounded-md bg-sol-text/[0.04] focus-within:bg-sol-text/[0.06]">
                  <Search className="w-3.5 h-3.5 text-sol-text-dim shrink-0" />
                  <input
                    ref={searchRef}
                    data-filter-folder-search
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        const first = (e.currentTarget.closest("[data-sv-rail-filter-menu]") as HTMLElement | null)
                          ?.querySelector<HTMLElement>("[data-filter-folder]");
                        first?.focus();
                        return;
                      }
                      if (e.key === "Escape") return; // closes the menu
                      // Keep typing out of the menu's typeahead.
                      e.stopPropagation();
                    }}
                    placeholder="Search folders"
                    aria-label="Search folders"
                    className="flex-1 min-w-0 bg-transparent text-[13px] text-sol-text placeholder:text-sol-text-dim outline-none"
                  />
                </div>
              </div>
              {allFolders.length === 0 ? (
                <div className="px-2 py-1.5 text-[13px] text-sol-text-dim">No folders match</div>
              ) : (
                allFolders.map(([name]) => folderItem(name))
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ContextMenu state={ctxMenu}>
        {(p) => {
          // Both kinds share one menu: the axis decides which filter list and
          // store setters the verbs reach, nothing else. Include and exclude
          // are peers; whichever is currently active swaps for its "clear"
          // counterpart, so exactly one item ever reads as an undo.
          const store = useInboxStore.getState();
          const axis = p.kind === "label"
            ? {
                id: p.bucket._id,
                name: p.bucket.name,
                noun: "label",
                filters: labelFilters,
                set: (id: string | null, exclude?: boolean) => store.setActiveBucketFilter(id, exclude),
                toggle: (exclude: boolean) => store.toggleBucketFilterTerm(p.bucket._id, exclude),
              }
            : {
                id: p.name,
                name: chipLabel(p.name),
                noun: workProjectIdOfChipKey(p.name) ? "project" : "folder",
                filters: projectFilters,
                set: (id: string | null, exclude?: boolean) => store.setActiveProjectFilter(id, id ? projectPathByName[p.name] || null : null, exclude),
                toggle: (exclude: boolean) => store.toggleProjectFilterTerm(p.name, projectPathByName[p.name] || null, exclude),
              };
          const term = axis.filters.find((t) => t.id === axis.id);
          const sole = !!term && axis.filters.length === 1;
          const inOtherFilter = axis.filters.length > 0 && !term;
          return (
            <>
              <CtxHeader title={axis.name} />
              {term && !term.exclude ? (
                sole ? (
                  <CtxItem icon={FilterX} onSelect={() => axis.set(null)}>
                    Clear filter
                  </CtxItem>
                ) : (
                  <CtxItem icon={FilterX} trailing={shiftClickHint} onSelect={() => axis.toggle(false)}>
                    Remove from filter
                  </CtxItem>
                )
              ) : (
                <CtxItem icon={Filter} onSelect={() => axis.set(axis.id)}>
                  Filter by this {axis.noun}
                </CtxItem>
              )}
              {/* Additive verbs, only while some other filter is on — the
                  menu twin of ⇧-click / ⇧⌥-click. */}
              {inOtherFilter && (
                <CtxItem icon={Filter} trailing={shiftClickHint} onSelect={() => axis.toggle(false)}>
                  Add to filter
                </CtxItem>
              )}
              {term?.exclude ? (
                <CtxItem icon={FilterX} onSelect={() => (sole ? axis.set(null) : axis.toggle(true))}>
                  Stop hiding
                </CtxItem>
              ) : (
                <CtxItem icon={EyeOff} trailing={altClickHint} onSelect={() => axis.set(axis.id, true)}>
                  Hide this {axis.noun}
                </CtxItem>
              )}
              {inOtherFilter && (
                <CtxItem icon={EyeOff} trailing={shiftAltClickHint} onSelect={() => axis.toggle(true)}>
                  Also hide this {axis.noun}
                </CtxItem>
              )}
              {p.kind === "project" && workProjectIdOfChipKey(p.name) && (
                <>
                  <CtxSeparator />
                  <CtxItem icon={ChevronRight} onSelect={() => router.push(`/projects/${s.projects[workProjectIdOfChipKey(p.name)!]?.short_id || workProjectIdOfChipKey(p.name)}`)}>
                    Open project
                  </CtxItem>
                </>
              )}
              {p.kind === "label" && (
                <>
                  <CtxSeparator />
                  <CtxItem danger icon={Trash2} onSelect={() => performDeleteLabel(p.bucket)}>
                    Delete label
                  </CtxItem>
                </>
              )}
            </>
          );
        }}
      </ContextMenu>
    </div>
  );
}
