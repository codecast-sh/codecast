import { useState, useCallback } from "react";
import { useEventListener } from "../hooks/useEventListener";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { MenuKeyCaps } from "./KeyboardShortcutsHelp";
import { matchesAction } from "../shortcuts";
import { SwitchReview } from "./consequential/ConsequentialSwitch";
import { allowAllLedger } from "./consequential/ledgers";
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
  suggestions?: unknown[];
};

/** The fields the view renders. A real row satisfies it, and so does a fixture with a plain string id. */
export type PermissionViewItem<PId extends string = string> = {
  _id: PId;
  tool_name: string;
  arguments_preview?: string;
  status: Permission["status"];
  /** Claude Code's permission_suggestions: what "Always allow" would add. */
  suggestions?: unknown[];
};

/**
 * Claude's suggested permission updates, written the way its settings write
 * them: `Bash(bun test:*)`, a directory, a mode. Empty when none can be named,
 * and then there is nothing for "Always allow" to keep.
 */
export function permissionRuleLabels(suggestions: unknown[] | undefined): string[] {
  const labels: string[] = [];
  for (const s of suggestions ?? []) {
    const u = s as any;
    if (u?.type === "addRules" && u.behavior === "allow" && Array.isArray(u.rules)) {
      for (const r of u.rules) if (r?.toolName) labels.push(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);
    } else if (u?.type === "addDirectories" && Array.isArray(u.directories)) {
      for (const d of u.directories) if (typeof d === "string") labels.push(d);
    } else if (u?.type === "setMode" && typeof u.mode === "string") {
      labels.push(`mode: ${u.mode}`);
    }
  }
  return labels;
}

const DENY_CLASS = "px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap rounded border border-sol-red/30 text-sol-text-dim hover:bg-sol-red hover:text-sol-bg transition-colors disabled:opacity-40 disabled:pointer-events-none";

/** Approves and keeps the rule Claude suggested, named on the button itself. */
function AlwaysAllowButton({ permission, onAlwaysAllow, className = "" }: { permission: PermissionViewItem; onAlwaysAllow?: (id: string) => void; className?: string }) {
  const rules = permissionRuleLabels(permission.suggestions);
  if (!onAlwaysAllow || rules.length === 0) return null;
  const named = rules.join(" ");
  return (
    <button
      onClick={() => onAlwaysAllow(permission._id)}
      title={named}
      data-always-allow
      className={`min-w-0 max-w-[18rem] truncate py-0.5 text-[11px] font-medium whitespace-nowrap rounded border border-sol-green/30 text-sol-green hover:bg-sol-green hover:text-sol-bg transition-colors ${className}`}
    >
      Always allow <span className="font-mono font-normal">{named}</span>
    </button>
  );
}

/** The reason a denial sends the model, typed under the row Deny opened it on.
 *  Enter denies (with or without a reason); Escape puts the buttons back. */
function DenyReason({ onDeny, onCancel }: { onDeny: (message?: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onDeny(reason.trim() || undefined); }}
      className="flex items-center gap-1.5 px-2.5 pb-1.5"
    >
      <input
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }}
        placeholder="Tell the agent why (optional)"
        aria-label="Reason for denying"
        className="flex-1 min-w-0 px-2 py-0.5 text-[11px] font-mono rounded border border-sol-border/40 bg-transparent text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-red/50"
      />
      <button type="submit" className={DENY_CLASS}>Deny</button>
    </form>
  );
}

export function PermissionRow({
  permission,
  onApprove,
  onDeny,
  onAlwaysAllow,
  isExpanded,
  onToggleExpand,
  showToolName,
}: {
  permission: PermissionViewItem;
  onApprove: () => void;
  onDeny: (message?: string) => void;
  onAlwaysAllow?: (id: string) => void;
  isExpanded: boolean;
  onToggleExpand: () => void;
  showToolName: boolean;
}) {
  const [denying, setDenying] = useState(false);
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
          <AlwaysAllowButton permission={permission} onAlwaysAllow={onAlwaysAllow} className="px-2" />
          {!denying && (
            <button
              onClick={() => setDenying(true)}
              className="px-2 py-0.5 text-[11px] font-medium whitespace-nowrap rounded border border-sol-red/30 text-sol-text-dim hover:bg-sol-red hover:text-sol-bg transition-colors"
            >
              Deny
            </button>
          )}
        </div>
      </div>
      {denying && <DenyReason onDeny={onDeny} onCancel={() => setDenying(false)} />}
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

const NO_INFLIGHT: ReadonlySet<string> = new Set();

export function PermissionStack({
  permissions,
  onAllowAll,
}: {
  permissions: Permission[];
  onAllowAll?: () => void;
}) {
  const resolvePermission = useInboxStore((s) => s.resolvePermission);

  const pending = permissions.filter((p) => p.status === "pending");

  // Local-first: the store drops the row in the same commit (and marks the
  // session's question resolved when it was the last one), so the card leaves
  // on the press and nothing here waits on the server.
  const handleApprove = useCallback((id: Id<"pending_permissions">) => resolvePermission(id, "approved"), [resolvePermission]);
  const handleDeny = useCallback(
    (id: Id<"pending_permissions">, message?: string) => resolvePermission(id, "denied", message ? { message } : undefined),
    [resolvePermission],
  );
  const handleAlwaysAllow = useCallback((id: Id<"pending_permissions">) => resolvePermission(id, "approved", { remember: true }), [resolvePermission]);
  const handleApproveAll = useCallback(() => {
    for (const p of pending) resolvePermission(p._id, "approved");
  }, [pending, resolvePermission]);
  const handleDenyAll = useCallback(() => {
    for (const p of pending) resolvePermission(p._id, "denied");
  }, [pending, resolvePermission]);
  const handleAllowAll = useCallback(() => {
    if (!onAllowAll) return;
    for (const p of pending) resolvePermission(p._id, "approved");
    onAllowAll();
  }, [pending, resolvePermission, onAllowAll]);

  useEventListener("keydown", useCallback((e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
    if (pending.length === 0) return;

    if (matchesAction(e, "permission.approve")) {
      e.preventDefault();
      if (pending.length === 1) handleApprove(pending[0]._id);
      else handleApproveAll();
    }
    if (matchesAction(e, "permission.deny")) {
      e.preventDefault();
      if (pending.length === 1) handleDeny(pending[0]._id);
      else handleDenyAll();
    }
  }, [pending, handleApprove, handleDeny, handleApproveAll, handleDenyAll]));

  return (
    <PermissionStackView
      pending={pending}
      inflight={NO_INFLIGHT}
      onApprove={handleApprove}
      onDeny={handleDeny}
      onAlwaysAllow={handleAlwaysAllow}
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
  onAlwaysAllow,
  onApproveAll,
  onDenyAll,
  onAllowAll,
}: {
  /** Pending rows only; the container filters. */
  pending: PermissionViewItem<PId>[];
  inflight: ReadonlySet<string>;
  onApprove: (id: PId) => void;
  /** message: the reason typed under the row, sent to the agent. */
  onDeny: (id: PId, message?: string) => void;
  /** Approve and keep the row's suggested rules. Shown only for rows that have some. */
  onAlwaysAllow?: (id: PId) => void;
  onApproveAll: () => void;
  onDenyAll: () => void;
  /** Present only when the session can bypass future prompts. */
  onAllowAll?: () => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  // Allow all switches the session's prompts off for good, so its button opens the review of that and the review's own button does it.
  const [allowReview, setAllowReview] = useState(false);
  const [denying, setDenying] = useState(false);
  const alwaysAllow = onAlwaysAllow as ((id: string) => void) | undefined;

  if (pending.length === 0) return null;
  const allowAllReview = allowReview && onAllowAll && (
    <SwitchReview ledger={allowAllLedger({ pending: pending.length })} onClose={() => setAllowReview(false)} onConfirm={() => { setAllowReview(false); onAllowAll(); }} />
  );

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
                onClick={() => setAllowReview(true)}
                aria-haspopup="dialog"
                data-allow-all
                title="Approve this and bypass all future permission prompts in this session"
                className="px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap rounded border border-orange-500/40 text-orange-500 hover:bg-orange-500 hover:text-sol-bg transition-colors"
              >
                Allow all
              </button>
            )}
            {allowAllReview}
            <AlwaysAllowButton permission={p} onAlwaysAllow={alwaysAllow} className="px-2.5" />
            {!denying && (
              <button onClick={() => setDenying(true)} disabled={inflight.has(p._id)} className={DENY_CLASS}>
                Deny
              </button>
            )}
          </div>
          <span className="text-[9px] text-sol-text-dim flex-shrink-0 hidden sm:flex items-center gap-1">
            <MenuKeyCaps action="permission.approve" className="contents" />/<MenuKeyCaps action="permission.deny" className="contents" />
          </span>
        </div>
        {preview && isLong && (
          <div className="px-2.5 pb-1.5 -mt-0.5">
            <span className="text-[11px] font-mono text-sol-text-dim block whitespace-pre-wrap break-words">
              {preview}
            </span>
          </div>
        )}
        {denying && <DenyReason onDeny={(message) => onDeny(p._id, message)} onCancel={() => setDenying(false)} />}
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
              onClick={() => setAllowReview(true)}
              aria-haspopup="dialog"
              data-allow-all
              title="Approve all and bypass future permission prompts in this session"
              className="px-2 py-0.5 text-[10px] font-medium whitespace-nowrap rounded border border-orange-500/40 text-orange-500 hover:bg-orange-500 hover:text-sol-bg transition-colors"
            >
              Allow all tool calls
            </button>
          )}
          {allowAllReview}
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
            onDeny={(message) => onDeny(p._id, message)}
            onAlwaysAllow={alwaysAllow}
            isExpanded={expandedId === p._id}
            onToggleExpand={() => setExpandedId(expandedId === p._id ? null : p._id)}
            showToolName={!allSameTool}
          />
        ))}
      </div>

      <div className="flex items-center justify-center gap-3 py-0.5 border-t border-sol-yellow/8">
        <span className="text-[9px] text-sol-text-dim flex items-center gap-1">
          <MenuKeyCaps action="permission.approve" className="contents" />
          approve all
        </span>
        <span className="text-[9px] text-sol-text-dim flex items-center gap-1">
          <MenuKeyCaps action="permission.deny" className="contents" />
          deny all
        </span>
      </div>
    </div>
  );
}

export function PermissionCard({ permission }: { permission: Permission }) {
  return <PermissionStack permissions={[permission]} />;
}
