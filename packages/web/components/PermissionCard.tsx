import { useState, useCallback } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useEventListener } from "../hooks/useEventListener";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { useInboxStore } from "../store/inboxStore";
import { formatToolName } from "@codecast/shared/render";

/**
 * The tool a permission asks for. Formatted (an MCP id like
 * `mcp__claude-in-chrome__javascript_tool` is ~250px raw) and allowed to
 * truncate, so beside the Approve/Deny buttons in a narrow pane it yields
 * width instead of crushing the preview to one letter per line.
 */
export function ToolName({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span title={name} className={`min-w-0 max-w-[40%] truncate font-mono text-sol-text-muted ${className}`}>
      {formatToolName(name)}
    </span>
  );
}

// Tools whose "permission" row is really a UI affordance, not a request to run
// something: the agent is asking a question or moving a task, and the prompt is
// answered by its own card. Surfacing them as Approve/Deny would double-ask.
// Shared by the conversation footer and the decision queue so the two surfaces
// can never disagree about what counts as a real permission request.
export const PERMISSION_SKIP_TOOLS: ReadonlySet<string> = new Set([
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
]);

type Permission = {
  _id: Id<"pending_permissions">;
  conversation_id?: string;
  tool_name: string;
  arguments_preview?: string;
  status: "pending" | "approved" | "denied" | "cancelled";
  created_at: number;
  responded_at?: number;
};

/** The fields the view renders. A real row satisfies it, and so does a fixture with a plain string id. */
export type PermissionViewItem<PId extends string = string> = {
  _id: PId;
  tool_name: string;
  arguments_preview?: string;
  status: Permission["status"];
};

export function PermissionRow({
  permission,
  onApprove,
  onDeny,
  isExpanded,
  onToggleExpand,
  showToolName,
}: {
  permission: PermissionViewItem;
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
          <ToolName name={permission.tool_name} className="text-[11px] font-semibold" />
        )}
        {/* Collapsed, the preview is one truncated line beside the buttons;
            expanded, it moves to its own full-width line below, since the
            space beside the buttons can be a few characters wide. */}
        {preview && (
          <button
            onClick={onToggleExpand}
            className="flex-1 min-w-0 text-left"
          >
            <span className="text-[11px] font-mono text-sol-text-dim block truncate">
              {isExpanded ? "hide" : preview}
            </span>
          </button>
        )}
        {!preview && <span className="flex-1" />}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={onApprove}
            className="px-2 py-0.5 text-[11px] font-medium whitespace-nowrap rounded border border-sol-green/40 text-sol-green hover:bg-sol-green hover:text-sol-bg transition-colors"
          >
            Approve
          </button>
          <button
            onClick={onDeny}
            className="px-2 py-0.5 text-[11px] font-medium whitespace-nowrap rounded border border-sol-red/30 text-sol-text-dim hover:bg-sol-red hover:text-sol-bg transition-colors"
          >
            Deny
          </button>
        </div>
      </div>
      {preview && isExpanded && (
        <button onClick={onToggleExpand} className="block w-full px-2 pb-1.5 -mt-0.5 text-left">
          <span className="text-[11px] font-mono text-sol-text-dim block whitespace-pre-wrap break-words">
            {preview}
          </span>
        </button>
      )}
    </div>
  );
}

export function PermissionStack({
  permissions,
  onAllowAll,
}: {
  permissions: Permission[];
  onAllowAll?: () => void;
}) {
  const updatePermissionStatus = useMutation(api.permissions.updatePermissionStatus);
  const resolveSessionQuestion = useInboxStore((s) => s.resolveSessionQuestion);
  const [inflight, setInflight] = useState<Set<string>>(new Set());

  const pending = permissions.filter((p) => p.status === "pending");

  // Resolving the LAST pending permission unblocks the session — mark its
  // question resolved in the store so the rail's QUESTIONS section and the
  // queue drop it in the same commit, instead of waiting for the daemon's
  // agent_status heartbeat. Stamped before the mutation: local-first.
  const markUnblockedIfLast = useCallback((resolvedIds: Array<Id<"pending_permissions">>) => {
    const remaining = pending.filter((p) => !resolvedIds.includes(p._id));
    if (remaining.length > 0) return;
    const convId = pending[0]?.conversation_id;
    if (convId) resolveSessionQuestion(convId);
  }, [pending, resolveSessionQuestion]);

  const handleApprove = useCallback(async (id: Id<"pending_permissions">) => {
    if (inflight.has(id)) return;
    setInflight((s) => new Set(s).add(id));
    markUnblockedIfLast([id]);
    await updatePermissionStatus({ permission_id: id, status: "approved" }).catch(() => {});
    setInflight((s) => { const n = new Set(s); n.delete(id); return n; });
  }, [updatePermissionStatus, inflight, markUnblockedIfLast]);

  const handleDeny = useCallback(async (id: Id<"pending_permissions">) => {
    if (inflight.has(id)) return;
    setInflight((s) => new Set(s).add(id));
    markUnblockedIfLast([id]);
    await updatePermissionStatus({ permission_id: id, status: "denied" }).catch(() => {});
    setInflight((s) => { const n = new Set(s); n.delete(id); return n; });
  }, [updatePermissionStatus, inflight, markUnblockedIfLast]);

  const handleApproveAll = useCallback(async () => {
    markUnblockedIfLast(pending.map((p) => p._id));
    await Promise.all(
      pending.map((p) =>
        updatePermissionStatus({ permission_id: p._id, status: "approved" }).catch(() => {})
      )
    );
  }, [pending, updatePermissionStatus, markUnblockedIfLast]);

  const handleDenyAll = useCallback(async () => {
    markUnblockedIfLast(pending.map((p) => p._id));
    await Promise.all(
      pending.map((p) =>
        updatePermissionStatus({ permission_id: p._id, status: "denied" }).catch(() => {})
      )
    );
  }, [pending, updatePermissionStatus, markUnblockedIfLast]);

  const handleAllowAll = useCallback(async () => {
    if (!onAllowAll) return;
    markUnblockedIfLast(pending.map((p) => p._id));
    await Promise.all(
      pending.map((p) =>
        updatePermissionStatus({ permission_id: p._id, status: "approved" }).catch(() => {})
      )
    );
    onAllowAll();
  }, [pending, updatePermissionStatus, onAllowAll, markUnblockedIfLast]);

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

  return (
    <PermissionStackView
      pending={pending}
      inflight={inflight}
      onApprove={handleApprove}
      onDeny={handleDeny}
      onApproveAll={handleApproveAll}
      onDenyAll={handleDenyAll}
      onAllowAll={onAllowAll ? handleAllowAll : undefined}
    />
  );
}

/**
 * The permission stack as pure markup: every write goes through the callbacks,
 * and only presentation state (collapsed, which row is expanded) lives here.
 * PermissionStack wires it to the mutation and the y/n keys; the marketing
 * hero renders it with fixture rows.
 */
export function PermissionStackView<PId extends string>({
  pending,
  inflight,
  onApprove,
  onDeny,
  onApproveAll,
  onDenyAll,
  onAllowAll,
}: {
  /** Pending rows only; the container filters. */
  pending: PermissionViewItem<PId>[];
  inflight: ReadonlySet<string>;
  onApprove: (id: PId) => void;
  onDeny: (id: PId) => void;
  onApproveAll: () => void;
  onDenyAll: () => void;
  /** Present only when the session can bypass future prompts. */
  onAllowAll?: () => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

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
      <div className="whitespace-nowrap rounded border border-sol-yellow/20 bg-sol-yellow/[0.03] overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow animate-pulse flex-shrink-0" />
          <ToolName name={p.tool_name} className="text-[11px] font-semibold" />
          {preview && !isLong && (
            <span className="flex-1 min-w-0 text-[11px] font-mono text-sol-text-dim truncate">
              {preview}
            </span>
          )}
          {(!preview || isLong) && <span className="flex-1" />}
          <div className="ml-auto flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => onApprove(p._id)}
              disabled={inflight.has(p._id)}
              className="px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap rounded border border-sol-green/40 text-sol-green hover:bg-sol-green hover:text-sol-bg transition-colors disabled:opacity-40 disabled:pointer-events-none"
            >
              {inflight.has(p._id) ? "..." : "Approve"}
            </button>
            {onAllowAll && (
              <button
                onClick={onAllowAll}
                title="Approve this and bypass all future permission prompts in this session"
                className="px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap rounded border border-orange-500/40 text-orange-500 hover:bg-orange-500 hover:text-sol-bg transition-colors"
              >
                Allow all
              </button>
            )}
            <button
              onClick={() => onDeny(p._id)}
              disabled={inflight.has(p._id)}
              className="px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap rounded border border-sol-red/30 text-sol-text-dim hover:bg-sol-red hover:text-sol-bg transition-colors disabled:opacity-40 disabled:pointer-events-none"
            >
              Deny
            </button>
          </div>
          <span className="text-[9px] text-sol-text-dim flex-shrink-0 hidden sm:flex items-center gap-1">
            <KeyCap size="xs">y</KeyCap>/<KeyCap size="xs">n</KeyCap>
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
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1 border-b border-sol-yellow/12">
        <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow animate-pulse flex-shrink-0" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-sol-yellow whitespace-nowrap">
          {pending.length} Permissions
        </span>
        {allSameTool && (
          <ToolName name={pending[0].tool_name} className="text-[10px] text-sol-text-dim" />
        )}
        <span className="flex-1" />
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
          <button
            onClick={onApproveAll}
            className="px-2 py-0.5 text-[10px] font-medium whitespace-nowrap rounded border border-sol-green/40 text-sol-green hover:bg-sol-green hover:text-sol-bg transition-colors"
          >
            Approve all
          </button>
          {onAllowAll && (
            <button
              onClick={onAllowAll}
              title="Approve all and bypass future permission prompts in this session"
              className="px-2 py-0.5 text-[10px] font-medium whitespace-nowrap rounded border border-orange-500/40 text-orange-500 hover:bg-orange-500 hover:text-sol-bg transition-colors"
            >
              Allow all tool calls
            </button>
          )}
          <button
            onClick={onDenyAll}
            className="px-2 py-0.5 text-[10px] font-medium whitespace-nowrap rounded border border-sol-border/40 text-sol-text-dim hover:bg-sol-red hover:text-sol-bg transition-colors"
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
            onApprove={() => onApprove(p._id)}
            onDeny={() => onDeny(p._id)}
            isExpanded={expandedId === p._id}
            onToggleExpand={() => setExpandedId(expandedId === p._id ? null : p._id)}
            showToolName={!allSameTool}
          />
        ))}
      </div>

      <div className="flex items-center justify-center gap-3 py-0.5 border-t border-sol-yellow/8">
        <span className="text-[9px] text-sol-text-dim flex items-center gap-1">
          <KeyCap size="xs">y</KeyCap>
          approve all
        </span>
        <span className="text-[9px] text-sol-text-dim flex items-center gap-1">
          <KeyCap size="xs">n</KeyCap>
          deny all
        </span>
      </div>
    </div>
  );
}

export function PermissionCard({ permission }: { permission: Permission }) {
  return <PermissionStack permissions={[permission]} />;
}
