import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useEffect, useRef, useState, useMemo, useCallback } from "react";

type TreeNode = {
  id: string;
  short_id?: string;
  title: string;
  message_count: number;
  parent_message_uuid?: string;
  started_at: number;
  status: string;
  agent_type?: string;
  is_current: boolean;
  children: TreeNode[];
};

const agentColors: Record<string, string> = {
  claude_code: "text-amber-400",
  codex: "text-emerald-400",
  cursor: "text-blue-400",
  gemini: "text-blue-400",
};

const agentLabels: Record<string, string> = {
  claude_code: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini",
};

type FlatNode = { node: TreeNode; depth: number };

function flattenTree(node: TreeNode, depth = 0): FlatNode[] {
  const result: FlatNode[] = [{ node, depth }];
  for (const child of node.children) {
    result.push(...flattenTree(child, depth + 1));
  }
  return result;
}

function TreeRow({
  node,
  depth = 0,
  activeBranchIds,
  onSwitchToConversation,
  isSelected,
  onMouseEnter,
  rowRef,
}: {
  node: TreeNode;
  depth?: number;
  activeBranchIds: Set<string>;
  onSwitchToConversation: (convId: string) => void;
  isSelected: boolean;
  onMouseEnter: () => void;
  rowRef?: React.Ref<HTMLButtonElement>;
}) {
  const isActive = node.is_current || activeBranchIds.has(node.id);
  const timeStr = new Date(node.started_at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

  return (
    <button
      ref={rowRef}
      onClick={() => onSwitchToConversation(node.id)}
      onMouseEnter={onMouseEnter}
      className={`w-full flex items-center gap-2 py-1.5 px-2 rounded text-xs transition-colors text-left ${
        isSelected
          ? "bg-sol-cyan/20 ring-1 ring-inset ring-sol-cyan/40 text-sol-cyan"
          : isActive
            ? "bg-sol-cyan/15 text-sol-cyan border border-sol-cyan/30"
            : "hover:bg-sol-bg-alt text-sol-text-secondary"
      }`}
      style={{ paddingLeft: `${depth * 14 + 8}px` }}
    >
      {depth > 0 && (
        <span className="text-sol-text-dim text-[10px] flex-shrink-0">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
        </span>
      )}
      {node.agent_type && (
        <span className={`text-[9px] font-medium flex-shrink-0 ${agentColors[node.agent_type] || "text-sol-text-dim"}`}>
          {agentLabels[node.agent_type] || node.agent_type}
        </span>
      )}
      <span className="truncate flex-1 min-w-0">{node.title}</span>
      <span className="text-[9px] text-sol-text-dim flex-shrink-0 tabular-nums">
        {node.message_count}
      </span>
      <span className="text-[9px] text-sol-text-dim flex-shrink-0">{timeStr}</span>
    </button>
  );
}

export function ForkTreePanel({
  conversationId,
  open,
  onClose,
  activeBranchIds,
  onSwitchToConversation,
}: {
  conversationId: string;
  open: boolean;
  onClose: () => void;
  activeBranchIds: Set<string>;
  onSwitchToConversation: (convId: string) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const result = useQuery(
    api.conversations.getConversationTree,
    open ? { conversation_id: conversationId } : "skip"
  );

  const tree = result && !("error" in result) ? (result.tree as TreeNode) : null;

  const flatNodes = useMemo(() => (tree ? flattenTree(tree) : []), [tree]);

  const initialIdx = useMemo(() => {
    const currentIdx = flatNodes.findIndex(
      (f) => f.node.is_current || activeBranchIds.has(f.node.id)
    );
    return currentIdx >= 0 ? currentIdx : 0;
  }, [flatNodes, activeBranchIds]);

  const [selectedIdx, setSelectedIdx] = useState(initialIdx);

  useEffect(() => {
    if (open) setSelectedIdx(initialIdx);
  }, [open, initialIdx]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  const handleSelect = useCallback(
    (idx: number) => {
      const flat = flatNodes[idx];
      if (flat) onSwitchToConversation(flat.node.id);
    },
    [flatNodes, onSwitchToConversation]
  );

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "t") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx((i) => Math.min(i + 1, flatNodes.length - 1));
        return;
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        handleSelect(selectedIdx);
        return;
      }
    };
    document.addEventListener("mousedown", handleClick);
    const raf = requestAnimationFrame(() => {
      document.addEventListener("keydown", handleKey, true);
    });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey, true);
    };
  }, [open, onClose, flatNodes.length, selectedIdx, handleSelect]);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-0 bottom-0 w-[280px] bg-sol-bg border-l border-sol-border z-30 flex flex-col shadow-xl animate-in slide-in-from-right duration-200"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-sol-border shrink-0">
        <span className="text-[10px] text-sol-text-dim font-medium uppercase tracking-wider">
          Fork Tree
        </span>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {!tree ? (
          <div className="flex items-center justify-center py-8 text-sol-text-dim text-xs">
            <svg className="w-4 h-4 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            Loading tree...
          </div>
        ) : (
          flatNodes.map((flat, idx) => (
            <TreeRow
              key={flat.node.id}
              node={flat.node}
              depth={flat.depth}
              activeBranchIds={activeBranchIds}
              onSwitchToConversation={onSwitchToConversation}
              isSelected={idx === selectedIdx}
              onMouseEnter={() => setSelectedIdx(idx)}
              rowRef={idx === selectedIdx ? selectedRef : undefined}
            />
          ))
        )}
      </div>
      <div className="px-3 py-2 border-t border-sol-border text-[9px] text-sol-text-dim shrink-0 flex items-center gap-3">
        <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border">j</kbd>/<kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border">k</kbd> navigate</span>
        <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border">Enter</kbd> switch</span>
        <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border">t</kbd> close</span>
      </div>
    </div>
  );
}
