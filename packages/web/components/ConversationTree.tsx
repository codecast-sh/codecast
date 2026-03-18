import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";

type TreeNode = {
  id: string;
  short_id?: string;
  title: string;
  message_count: number;
  parent_message_uuid?: string;
  started_at: number;
  status: string;
  is_current: boolean;
  children: TreeNode[];
};

function TreeNodeRow({ node, depth = 0 }: { node: TreeNode; depth?: number }) {
  const date = new Date(node.started_at);
  const timeStr = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <>
      <Link
        href={`/conversation/${node.id}`}
        className={`flex items-center gap-2 py-1.5 px-2 rounded text-sm transition-colors ${
          node.is_current
            ? "bg-purple-500/20 text-purple-300 border border-purple-500/40"
            : "hover:bg-sol-bg-alt text-sol-text-secondary"
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {depth > 0 && (
          <span className="text-sol-text-dim text-xs">{"+-"}</span>
        )}
        {node.is_current && (
          <span className="text-purple-400 text-xs font-bold">*</span>
        )}
        <span className="truncate flex-1">{node.title}</span>
        <span className="text-[10px] text-sol-text-dim flex-shrink-0">
          {node.message_count} msgs
        </span>
        <span className="text-[10px] text-sol-text-dim flex-shrink-0">
          {timeStr}
        </span>
      </Link>
      {node.children.map((child) => (
        <TreeNodeRow key={child.id} node={child} depth={depth + 1} />
      ))}
    </>
  );
}

export function ConversationTree({ conversationId }: { conversationId: string }) {
  const result = useQuery(api.conversations.getConversationTree, {
    conversation_id: conversationId,
  });

  if (!result || "error" in result) {
    return null;
  }

  const tree = result.tree as TreeNode;
  if (!tree) return null;

  const hasChildren = tree.children.length > 0;
  if (!hasChildren && !tree.is_current) return null;

  return (
    <div className="space-y-0.5 py-2">
      <div className="text-[10px] text-sol-text-dim font-medium px-2 mb-1 uppercase tracking-wider">
        Fork Tree
      </div>
      <TreeNodeRow node={tree} />
    </div>
  );
}
