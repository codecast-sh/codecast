import { useState, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, DocItem } from "../store/inboxStore";

const api = _api as any;

export type DocTreeNode = {
  doc: DocItem;
  children: DocTreeNode[];
};

/** Build a tree from human-created docs, sorted by sort_order then created_at */
function buildDocTree(docs: Record<string, DocItem>): {
  roots: DocTreeNode[];
  recentHuman: DocItem[];
} {
  // Only show human-created docs in the sidebar tree
  const all = Object.values(docs).filter(
    (d) =>
      d.source === "human" &&
      d.doc_type !== "plan" &&
      !d.source?.includes("plan_mode")
  );

  // Index by id for fast parent lookup
  const byId = new Set(all.map((d) => d._id));

  const byParent = new Map<string | null, DocItem[]>();
  for (const doc of all) {
    // If parent exists but was filtered out (e.g. bot-created), treat as root
    const pid = doc.parent_id && byId.has(doc.parent_id) ? doc.parent_id : null;
    const arr = byParent.get(pid) ?? [];
    arr.push(doc);
    byParent.set(pid, arr);
  }

  // Stable sort: sort_order first, then created_at (never changes)
  const sortDocs = (items: DocItem[]) =>
    items.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.created_at - b.created_at);

  function buildNodes(parentId: string | null): DocTreeNode[] {
    const children = byParent.get(parentId) ?? [];
    return sortDocs(children).map((doc) => ({
      doc,
      children: buildNodes(doc._id),
    }));
  }

  const roots = buildNodes(null);

  // Recent human-created docs (top 5, regardless of hierarchy position)
  const recentHuman = all
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 5);

  return { roots, recentHuman };
}

function DocTreeItem({
  node,
  depth,
  expandedIds,
  toggleExpand,
  onMobileClose,
  onCreateChild,
  activeDocId,
  dragState,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  node: DocTreeNode;
  depth: number;
  expandedIds: Set<string>;
  toggleExpand: (id: string) => void;
  onMobileClose?: () => void;
  onCreateChild: (parentId: string) => void;
  activeDocId?: string;
  dragState: { draggingId: string | null; overId: string | null; overPosition: "above" | "inside" | "below" | null };
  onDragStart: (id: string) => void;
  onDragOver: (id: string, position: "above" | "inside" | "below") => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const hasChildren = node.children.length > 0;
  const isExpanded = expandedIds.has(node.doc._id);
  const isActive = activeDocId === node.doc._id;
  const isDragging = dragState.draggingId === node.doc._id;
  const isDropTarget = dragState.overId === node.doc._id;
  const ref = useRef<HTMLDivElement>(null);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", node.doc._id);
    onDragStart(node.doc._id);
  }, [node.doc._id, onDragStart]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!ref.current || dragState.draggingId === node.doc._id) return;

    const rect = ref.current.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const third = rect.height / 3;
    if (y < third) onDragOver(node.doc._id, "above");
    else if (y > third * 2) onDragOver(node.doc._id, "below");
    else onDragOver(node.doc._id, "inside");
  }, [dragState.draggingId, node.doc._id, onDragOver]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onDrop();
  }, [onDrop]);

  const dropIndicator = isDropTarget && dragState.overPosition;

  return (
    <>
      <div
        ref={ref}
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragEnd={onDragEnd}
        className={`group relative ${isDragging ? "opacity-30" : ""}`}
      >
        {/* Drop indicator lines */}
        {dropIndicator === "above" && (
          <div className="absolute top-0 left-0 right-0 h-0.5 bg-sol-cyan z-10" />
        )}
        {dropIndicator === "below" && (
          <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-sol-cyan z-10" />
        )}

        <div
          className={`flex items-center gap-1 py-1 pr-2 cursor-pointer transition-colors text-[13px] leading-tight ${
            isActive
              ? "bg-sol-bg-highlight text-sol-text"
              : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/40"
          } ${dropIndicator === "inside" ? "ring-1 ring-sol-cyan/60 bg-sol-cyan/10" : ""}`}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
        >
          {/* Expand/collapse toggle */}
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggleExpand(node.doc._id);
            }}
            className={`w-4 h-4 flex items-center justify-center flex-shrink-0 rounded transition-colors ${
              hasChildren
                ? "text-sol-text-dim hover:text-sol-text"
                : "text-transparent"
            }`}
          >
            <svg
              className={`w-3 h-3 transition-transform ${isExpanded ? "rotate-90" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>

          {/* Doc icon */}
          <svg className="w-3.5 h-3.5 flex-shrink-0 text-sol-text-dim" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>

          {/* Title link */}
          <Link
            href={`/docs/${node.doc._id}`}
            onClick={onMobileClose}
            className="truncate flex-1 min-w-0"
            title={node.doc.title || "Untitled"}
          >
            {node.doc.title || "Untitled"}
          </Link>

          {/* Add child button */}
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onCreateChild(node.doc._id);
            }}
            className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5 text-sol-text-dim hover:text-sol-text transition-all flex-shrink-0"
            title="Add sub-page"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" d="M12 5v14m-7-7h14" />
            </svg>
          </button>
        </div>
      </div>

      {/* Children */}
      {isExpanded && node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <DocTreeItem
              key={child.doc._id}
              node={child}
              depth={depth + 1}
              expandedIds={expandedIds}
              toggleExpand={toggleExpand}
              onMobileClose={onMobileClose}
              onCreateChild={onCreateChild}
              activeDocId={activeDocId}
              dragState={dragState}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDrop={onDrop}
              onDragEnd={onDragEnd}
            />
          ))}
        </div>
      )}
    </>
  );
}

export function SidebarDocTree({
  onMobileClose,
}: {
  onMobileClose?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const docs = useInboxStore((s) => s.docs);
  const createDoc = useMutation(api.docs.webCreate);
  const moveDoc = useMutation(api.docs.webMoveDoc);

  // Extract active doc ID from URL
  const activeDocId = pathname?.startsWith("/docs/")
    ? pathname.split("/docs/")[1]?.split("/")[0]
    : undefined;

  // Build tree from flat docs
  const { roots, recentHuman } = useMemo(() => buildDocTree(docs), [docs]);

  // Expand/collapse state (persisted in a Set)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Drag state
  const [dragState, setDragState] = useState<{
    draggingId: string | null;
    overId: string | null;
    overPosition: "above" | "inside" | "below" | null;
  }>({ draggingId: null, overId: null, overPosition: null });

  const onDragStart = useCallback((id: string) => {
    setDragState({ draggingId: id, overId: null, overPosition: null });
  }, []);

  const onDragOver = useCallback((id: string, position: "above" | "inside" | "below") => {
    setDragState((prev) => ({ ...prev, overId: id, overPosition: position }));
  }, []);

  const onDragEnd = useCallback(() => {
    setDragState({ draggingId: null, overId: null, overPosition: null });
  }, []);

  const onDrop = useCallback(async () => {
    const { draggingId, overId, overPosition } = dragState;
    if (!draggingId || !overId || !overPosition || draggingId === overId) {
      onDragEnd();
      return;
    }

    const targetDoc = docs[overId];
    if (!targetDoc) {
      onDragEnd();
      return;
    }

    try {
      if (overPosition === "inside") {
        // Move as child of target
        await moveDoc({ id: draggingId as any, parent_id: overId as any, sort_order: 0 });
        setExpandedIds((prev) => new Set([...prev, overId]));
      } else {
        // Move as sibling (above/below target) — same parent as target
        const newParentId = targetDoc.parent_id || undefined;
        const siblingOrder = targetDoc.sort_order ?? 0;
        const newOrder = overPosition === "above" ? siblingOrder - 0.5 : siblingOrder + 0.5;
        await moveDoc({
          id: draggingId as any,
          parent_id: newParentId as any,
          sort_order: newOrder,
        });
      }
    } catch (err) {
      console.error("Failed to move doc:", err);
    }

    onDragEnd();
  }, [dragState, docs, moveDoc, onDragEnd]);

  const handleCreateChild = useCallback(async (parentId: string) => {
    const result = await createDoc({ title: "", doc_type: "note", parent_id: parentId as any });
    if (result?.id) {
      setExpandedIds((prev) => new Set([...prev, parentId]));
      router.push(`/docs/${result.id}`);
    }
  }, [createDoc, router]);

  const handleCreateRoot = useCallback(async () => {
    const result = await createDoc({ title: "", doc_type: "note" });
    if (result?.id) router.push(`/docs/${result.id}`);
  }, [createDoc, router]);

  const isEmpty = roots.length === 0 && recentHuman.length === 0;

  return (
    <div className="mt-1 mb-2">
      {/* Recent section */}
      {recentHuman.length > 0 && (
        <div className="mb-2">
          <div className="text-[10px] font-medium text-sol-text-dim/70 uppercase tracking-wider px-4 py-1">
            Recent
          </div>
          {recentHuman.map((doc) => (
            <Link
              key={doc._id}
              href={`/docs/${doc._id}`}
              onClick={onMobileClose}
              className={`flex items-center gap-1.5 py-1 px-4 text-[12px] transition-colors truncate ${
                activeDocId === doc._id
                  ? "bg-sol-bg-highlight text-sol-text"
                  : "text-sol-text-dim hover:text-sol-text-muted hover:bg-sol-bg-highlight/30"
              }`}
            >
              <span className="w-1 h-1 rounded-full bg-sol-green/60 flex-shrink-0" />
              <span className="truncate">{doc.title || "Untitled"}</span>
            </Link>
          ))}
        </div>
      )}

      {/* Tree section */}
      <div className="text-[10px] font-medium text-sol-text-dim/70 uppercase tracking-wider px-4 py-1 flex items-center justify-between">
        <span>Pages</span>
        <button
          onClick={handleCreateRoot}
          className="text-sol-text-dim hover:text-sol-text transition-colors p-0.5"
          title="New page"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" d="M12 5v14m-7-7h14" />
          </svg>
        </button>
      </div>

      {isEmpty ? (
        <button
          onClick={handleCreateRoot}
          className="w-full text-left px-4 py-2 text-[12px] text-sol-text-dim/60 hover:text-sol-text-muted transition-colors"
        >
          No pages yet. Click to create one...
        </button>
      ) : (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            // Drop on empty space = move to root
            if (dragState.draggingId && !dragState.overId) {
              e.preventDefault();
              moveDoc({ id: dragState.draggingId as any, sort_order: roots.length });
              onDragEnd();
            }
          }}
        >
          {roots.map((node) => (
            <DocTreeItem
              key={node.doc._id}
              node={node}
              depth={0}
              expandedIds={expandedIds}
              toggleExpand={toggleExpand}
              onMobileClose={onMobileClose}
              onCreateChild={handleCreateChild}
              activeDocId={activeDocId}
              dragState={dragState}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDrop={onDrop}
              onDragEnd={onDragEnd}
            />
          ))}
        </div>
      )}
    </div>
  );
}
