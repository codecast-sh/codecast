import { useState, useCallback } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useEventListener } from "../hooks/useEventListener";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { toast } from "sonner";

type Permission = {
  _id: Id<"pending_permissions">;
  tool_name: string;
  arguments_preview?: string;
  status: "pending" | "approved" | "denied";
  created_at: number;
  responded_at?: number;
};

function PermissionRow({
  permission,
  onApprove,
  onDeny,
  isExpanded,
  onToggleExpand,
  showToolName,
}: {
  permission: Permission;
  onApprove: () => void;
  onDeny: () => void;
  isExpanded: boolean;
  onToggleExpand: () => void;
  showToolName: boolean;
}) {
  if (permission.status !== "pending") return null;

  const preview = permission.arguments_preview;

  return (
    <div className="group hover:bg-sol-yellow/[0.04] transition-colors">
      <div className="flex items-center gap-2 py-1 px-2">
        {showToolName && (
          <span className="text-[11px] font-mono font-semibold text-sol-text-muted flex-shrink-0">
            {permission.tool_name}
          </span>
        )}
        {preview && (
          <button
            onClick={onToggleExpand}
            className="flex-1 min-w-0 text-left"
          >
            <span className={`text-[11px] font-mono text-sol-text-dim block ${isExpanded ? "whitespace-pre-wrap break-words" : "truncate"}`}>
              {preview}
            </span>
          </button>
        )}
        {!preview && <span className="flex-1" />}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={onApprove}
            className="px-2 py-0.5 text-[11px] font-medium rounded border border-sol-green/40 text-sol-green hover:bg-sol-green hover:text-sol-bg transition-colors"
          >
            Approve
          </button>
          <button
            onClick={onDeny}
            className="px-2 py-0.5 text-[11px] font-medium rounded border border-sol-red/30 text-sol-text-dim hover:bg-sol-red hover:text-sol-bg transition-colors"
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}

export function PermissionStack({ permissions }: { permissions: Permission[] }) {
  const updatePermissionStatus = useMutation(api.permissions.updatePermissionStatus);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const pending = permissions.filter((p) => p.status === "pending");

  const handleApprove = useCallback(async (id: Id<"pending_permissions">) => {
    await updatePermissionStatus({ permission_id: id, status: "approved" }).catch((err) => {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, [updatePermissionStatus]);

  const handleDeny = useCallback(async (id: Id<"pending_permissions">) => {
    await updatePermissionStatus({ permission_id: id, status: "denied" }).catch((err) => {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, [updatePermissionStatus]);

  const handleApproveAll = useCallback(async () => {
    await Promise.all(
      pending.map((p) =>
        updatePermissionStatus({ permission_id: p._id, status: "approved" }).catch(() => {})
      )
    );
  }, [pending, updatePermissionStatus]);

  const handleDenyAll = useCallback(async () => {
    await Promise.all(
      pending.map((p) =>
        updatePermissionStatus({ permission_id: p._id, status: "denied" }).catch(() => {})
      )
    );
  }, [pending, updatePermissionStatus]);

  useEventListener("keydown", useCallback((e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
    if (pending.length === 0) return;

    if (e.key === "y" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (pending.length === 1) handleApprove(pending[0]._id);
      else handleApproveAll();
    }
    if (e.key === "n" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (pending.length === 1) handleDeny(pending[0]._id);
      else handleDenyAll();
    }
  }, [pending, handleApprove, handleDeny, handleApproveAll, handleDenyAll]));

  if (pending.length === 0) return null;

  const allSameTool = pending.every((p) => p.tool_name === pending[0].tool_name);

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="w-full flex items-center justify-center gap-2 py-1 text-[11px] text-sol-yellow hover:text-sol-text transition-colors"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow animate-pulse" />
        {pending.length} pending permission{pending.length !== 1 ? "s" : ""}
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
        </svg>
      </button>
    );
  }

  // Single permission: two-row layout — header + preview
  if (pending.length === 1) {
    const p = pending[0];
    const preview = p.arguments_preview;
    const isExpanded = expandedId === p._id;
    const isLong = preview && preview.length > 80;
    return (
      <div className="rounded border border-sol-yellow/20 bg-sol-yellow/[0.03] overflow-hidden">
        <div className="flex items-center gap-2 px-2.5 py-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow animate-pulse flex-shrink-0" />
          <span className="text-[11px] font-mono font-semibold text-sol-text-muted flex-shrink-0">
            {p.tool_name}
          </span>
          {preview && !isLong && (
            <span className="flex-1 min-w-0 text-[11px] font-mono text-sol-text-dim truncate">
              {preview}
            </span>
          )}
          {(!preview || isLong) && <span className="flex-1" />}
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => handleApprove(p._id)}
              className="px-2.5 py-0.5 text-[11px] font-medium rounded border border-sol-green/40 text-sol-green hover:bg-sol-green hover:text-sol-bg transition-colors"
            >
              Approve
            </button>
            <button
              onClick={() => handleDeny(p._id)}
              className="px-2.5 py-0.5 text-[11px] font-medium rounded border border-sol-red/30 text-sol-text-dim hover:bg-sol-red hover:text-sol-bg transition-colors"
            >
              Deny
            </button>
          </div>
          <span className="text-[9px] text-sol-text-dim flex-shrink-0 hidden sm:flex items-center gap-1">
            <kbd className="px-0.5 bg-sol-bg rounded border border-sol-border/50 text-[9px]">y</kbd>/<kbd className="px-0.5 bg-sol-bg rounded border border-sol-border/50 text-[9px]">n</kbd>
          </span>
        </div>
        {preview && isLong && (
          <div className="px-2.5 pb-1.5 -mt-0.5">
            <span className="text-[11px] font-mono text-sol-text-dim block whitespace-pre-wrap break-words">
              {preview}
            </span>
          </div>
        )}
      </div>
    );
  }

  // Multiple permissions: header + rows
  return (
    <div className="rounded-lg border border-sol-yellow/20 bg-sol-yellow/[0.03] overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-1 border-b border-sol-yellow/12">
        <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow animate-pulse flex-shrink-0" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-sol-yellow">
          {pending.length} Permissions
        </span>
        {allSameTool && (
          <span className="text-[10px] font-mono text-sol-text-dim">
            {pending[0].tool_name}
          </span>
        )}
        <span className="flex-1" />
        <div className="flex items-center gap-1">
          <button
            onClick={handleApproveAll}
            className="px-2 py-0.5 text-[10px] font-medium rounded border border-sol-green/40 text-sol-green hover:bg-sol-green hover:text-sol-bg transition-colors"
          >
            Approve all
          </button>
          <button
            onClick={handleDenyAll}
            className="px-2 py-0.5 text-[10px] font-medium rounded border border-sol-border/40 text-sol-text-dim hover:bg-sol-red hover:text-sol-bg transition-colors"
          >
            Deny all
          </button>
        </div>
        <button
          onClick={() => setCollapsed(true)}
          className="p-0.5 text-sol-text-dim hover:text-sol-text transition-colors"
          title="Collapse"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      <div className="divide-y divide-sol-border/10">
        {pending.map((p) => (
          <PermissionRow
            key={p._id}
            permission={p}
            onApprove={() => handleApprove(p._id)}
            onDeny={() => handleDeny(p._id)}
            isExpanded={expandedId === p._id}
            onToggleExpand={() => setExpandedId(expandedId === p._id ? null : p._id)}
            showToolName={!allSameTool}
          />
        ))}
      </div>

      <div className="flex items-center justify-center gap-3 py-0.5 border-t border-sol-yellow/8">
        <span className="text-[9px] text-sol-text-dim flex items-center gap-1">
          <kbd className="px-0.5 bg-sol-bg rounded border border-sol-border/50 text-[9px]">y</kbd>
          approve all
        </span>
        <span className="text-[9px] text-sol-text-dim flex items-center gap-1">
          <kbd className="px-0.5 bg-sol-bg rounded border border-sol-border/50 text-[9px]">n</kbd>
          deny all
        </span>
      </div>
    </div>
  );
}

export function PermissionCard({ permission }: { permission: Permission }) {
  return <PermissionStack permissions={[permission]} />;
}
