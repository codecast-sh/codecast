import { AppLoader } from "./AppLoader";
import { useRef, useState, useMemo, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { Split, Search, MessageSquare } from "lucide-react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useInboxStore } from "../store/inboxStore";
import { useShortcutAction } from "../shortcuts/ShortcutProvider";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { relativeTime } from "./BranchSelector";
import {
  useForkTree,
  branchDisplayCount,
  branchDisplayLabel,
  branchUnread,
  type FlatForkNode,
  type BranchLive,
  type ForkConversationLike,
} from "../hooks/useForkTree";

// Branch map: the fork-family navigator. Renders instantly from local store
// data (see useForkTree), with the server tree merging in silently. It anchors
// above the message input like a command palette. Keyboard model: type to
// filter, ↑/↓ move the highlight, Enter (or click) switches to that branch and
// closes, Esc clears the filter then closes. Each row is labeled by the prompt
// that STARTED the branch (first message after the fork) so same-titled
// siblings read apart, with the branch's own message count beside it.

const agentColors: Record<string, string> = {
  claude_code: "text-amber-400",
  codex: "text-emerald-400",
  cursor: "text-purple-400",
  gemini: "text-blue-400",
};

const agentLabels: Record<string, string> = {
  claude_code: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini",
};

function LiveDot({ live }: { live?: BranchLive }) {
  if (live === "working") {
    return (
      <span className="relative flex w-2 h-2 flex-shrink-0" title="Agent working">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sol-green opacity-50" />
        <span className="relative inline-flex rounded-full w-2 h-2 bg-sol-green" />
      </span>
    );
  }
  if (live === "needs_input") {
    return <span className="w-2 h-2 rounded-full bg-sol-yellow flex-shrink-0" title="Needs input" />;
  }
  return <span className="w-2 h-2 rounded-full border border-sol-border flex-shrink-0" title={live ? "Idle" : undefined} />;
}

// Tree rails: one fixed-width column per ancestor level. guides[i] says the
// ancestor at depth i has more siblings below (draw a full vertical line);
// the last column is this node's own elbow (├ or └ plus a horizontal stub).
function Rails({ guides }: { guides: boolean[] }) {
  if (guides.length === 0) return null;
  return (
    <div className="flex self-stretch flex-shrink-0" aria-hidden>
      {guides.slice(0, -1).map((g, i) => (
        <span key={i} className="w-3.5 relative">
          {g && <span className="absolute left-1/2 top-0 bottom-0 w-px bg-sol-border" />}
        </span>
      ))}
      {/* The elbow points at the label line (first of the two row lines),
          not the row's vertical center. */}
      <span className="w-3.5 relative">
        <span
          className={`absolute left-1/2 top-0 w-px bg-sol-border ${guides[guides.length - 1] ? "bottom-0" : "h-[15px]"}`}
        />
        <span className="absolute left-1/2 top-[15px] w-1.5 h-px bg-sol-border" />
      </span>
    </div>
  );
}

function BranchRow({
  node,
  isCurrent,
  isSelected,
  unread,
  flatMode,
  showAgent,
  showAuthor,
  onClick,
  onMouseEnter,
  rowRef,
}: {
  node: FlatForkNode;
  isCurrent: boolean;
  isSelected: boolean;
  unread: number;
  flatMode: boolean;
  showAgent: boolean;
  showAuthor: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  rowRef?: React.Ref<HTMLButtonElement>;
}) {
  const count = branchDisplayCount(node);
  const label = branchDisplayLabel(node);
  const isRoot = node.depth === 0;
  // All-new (never opened): tint the count itself instead of stacking a
  // duplicate "+N" pill next to the same number (mirrors BranchSelector).
  const allUnread = unread > 0 && unread >= count;
  const partialUnread = unread > 0 && unread < count;
  return (
    <button
      ref={rowRef}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={`w-full flex items-stretch gap-1.5 pr-2 rounded text-xs text-left transition-colors relative ${
        isSelected ? "bg-sol-cyan/15" : "hover:bg-sol-bg-alt"
      } ${isCurrent ? "text-sol-cyan" : "text-sol-text-secondary"}`}
    >
      {isSelected && <span className="absolute left-0 top-0.5 bottom-0.5 w-0.5 rounded-full bg-sol-cyan" />}
      {!flatMode && <span className="pl-2 flex self-stretch flex-shrink-0"><Rails guides={node.guides} /></span>}
      <span className={`flex flex-col gap-0.5 py-1.5 flex-1 min-w-0 ${flatMode ? "pl-2" : ""}`}>
        <span className="flex items-center gap-1.5 min-w-0">
          <LiveDot live={node.live} />
          <span className={`truncate ${isCurrent ? "font-medium" : ""}`}>{label}</span>
          {isCurrent && (
            <span className="text-[8px] uppercase tracking-wider px-1 py-px rounded bg-sol-cyan/15 text-sol-cyan flex-shrink-0 font-semibold">
              you
            </span>
          )}
          {isRoot && !isCurrent && (
            <span className="text-[8px] uppercase tracking-wider px-1 py-px rounded bg-sol-bg-alt text-sol-text-dim flex-shrink-0 font-semibold">
              root
            </span>
          )}
        </span>
        <span className="flex items-center gap-1.5 pl-3.5 min-w-0 text-[9px] text-sol-text-dim">
          <span
            className={`tabular-nums inline-flex items-center gap-0.5 flex-shrink-0 ${
              allUnread ? "text-sol-cyan font-semibold" : ""
            }`}
            title={
              isRoot
                ? `${count} message${count === 1 ? "" : "s"}`
                : `${count} message${count === 1 ? "" : "s"} on this branch since the fork${unread > 0 ? `, ${unread} unread` : ""}`
            }
          >
            <MessageSquare className="w-2.5 h-2.5 opacity-60" />
            {count}
          </span>
          {partialUnread && (
            <span className="tabular-nums flex-shrink-0 px-1 rounded-full bg-sol-cyan text-sol-bg font-semibold leading-tight">
              +{unread}
            </span>
          )}
          {showAgent && node.agent_type && (
            <span className={`font-medium flex-shrink-0 ${agentColors[node.agent_type] || ""}`}>
              {agentLabels[node.agent_type] || node.agent_type}
            </span>
          )}
          {showAuthor && node.username && (
            <span className="truncate max-w-[90px]">{node.username}</span>
          )}
          {node.updated_at ? <span className="flex-shrink-0 ml-auto">{relativeTime(node.updated_at)}</span> : null}
        </span>
      </span>
    </button>
  );
}

function ForkTreeContent({
  conversation,
  conversationId,
  open,
  onClose,
  onSwitchToConversation,
}: {
  conversation: ForkConversationLike;
  conversationId: string;
  open: boolean;
  onClose: () => void;
  onSwitchToConversation: (convId: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const flat = useForkTree(conversation, open);
  const seenMessageCount = useInboxStore((s) => s._seenMessageCount);
  const currentUser = useInboxStore((s) => s.currentUser);
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Per-row metadata earns its width only when it discriminates: the agent
  // label only in mixed-agent families, the author only when someone else
  // owns a branch.
  const showAgent = useMemo(
    () => new Set(flat.map((n) => n.agent_type).filter(Boolean)).size > 1,
    [flat],
  );
  const myNames = useMemo(() => {
    const names = new Set<string>();
    if (currentUser?.name) names.add(currentUser.name);
    if (currentUser?.username) names.add(currentUser.username);
    return names;
  }, [currentUser]);

  // Fresh open: clear the filter and select where you are.
  useWatchEffect(() => {
    if (open) {
      setFilter("");
      setSelectedId(conversationId);
    }
  }, [open]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return flat;
    return flat.filter(
      (n) =>
        branchDisplayLabel(n).toLowerCase().includes(q) ||
        n.title?.toLowerCase().includes(q) ||
        n.username?.toLowerCase().includes(q) ||
        n.git_branch?.toLowerCase().includes(q) ||
        n.short_id?.toLowerCase().includes(q),
    );
  }, [flat, filter]);
  const flatMode = filter.trim().length > 0;

  const selIdx = useMemo(() => {
    const i = visible.findIndex((n) => n.id === selectedId);
    return i >= 0 ? i : 0;
  }, [visible, selectedId]);
  const selected: FlatForkNode | undefined = visible[selIdx];

  useWatchEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selIdx, visible.length]);

  const move = useCallback(
    (dir: 1 | -1) => {
      if (visible.length === 0) return;
      const next = visible[Math.min(Math.max(selIdx + dir, 0), visible.length - 1)];
      if (next) setSelectedId(next.id);
    },
    [visible, selIdx],
  );

  // Switch to a branch and close. Highlight (↑/↓) only moves selection; nothing
  // navigates until you commit with Enter or a click — plain command-palette
  // semantics, so there's no separate "peek" gesture to learn.
  const commit = useCallback(
    (node: FlatForkNode | undefined) => {
      if (!node) return;
      if (node.id !== conversationId) onSwitchToConversation(node.id);
      onClose();
    },
    [conversationId, onSwitchToConversation, onClose],
  );

  // The global dispatcher claims Escape (msg.clearSelection has
  // skipInputCheck) before our input ever sees it — register our own handler
  // on the same action while the map is open: first Esc clears the filter,
  // the next closes the map. Returning true stops the dispatch chain.
  const escState = useRef({ filter, open });
  escState.current = { filter, open };
  useShortcutAction(
    "msg.clearSelection",
    useCallback(() => {
      if (!escState.current.open) return false;
      if (escState.current.filter) {
        setFilter("");
        return true;
      }
      onClose();
      return true;
    }, [onClose]),
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        commit(selected);
      } else if (e.key === "Escape") {
        // Fallback if the global dispatcher didn't claim it.
        e.preventDefault();
        e.stopPropagation();
        if (filter) setFilter("");
        else onClose();
      }
    },
    [move, commit, selected, filter, onClose],
  );

  // The map lives inside the always-mounted conversation shell; refocus when
  // reopened so typing filters immediately.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, conversationId]);

  const branchCount = flat.length;

  return (
    <>
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-sol-border shrink-0">
        <Search className="w-3 h-3 text-sol-text-dim flex-shrink-0" />
        <input
          ref={inputRef}
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={branchCount > 1 ? `Filter ${branchCount} branches…` : "Filter branches…"}
          className="flex-1 min-w-0 bg-transparent text-xs text-sol-text placeholder:text-sol-text-dim outline-none"
        />
      </div>
      <div className="flex-1 overflow-y-auto p-1.5 min-h-0">
        {flat.length === 0 ? (
          <AppLoader className="min-h-0 bg-transparent py-8" size={24} />
        ) : visible.length === 0 ? (
          <div className="py-6 text-center text-[11px] text-sol-text-dim">No branches match</div>
        ) : (
          visible.map((node, idx) => (
            <BranchRow
              key={node.id}
              node={node}
              isCurrent={node.id === conversationId}
              isSelected={idx === selIdx}
              unread={branchUnread(node, seenMessageCount[node.id], node.id === conversationId)}
              flatMode={flatMode}
              showAgent={showAgent}
              showAuthor={!!node.username && !myNames.has(node.username)}
              onClick={() => commit(node)}
              onMouseEnter={() => setSelectedId(node.id)}
              rowRef={idx === selIdx ? selectedRef : undefined}
            />
          ))
        )}
      </div>
      <div className="px-3 py-2 border-t border-sol-border text-[9px] text-sol-text-dim shrink-0 flex items-center gap-3 flex-wrap">
        <span className="inline-flex items-center gap-1"><KeyCap size="xs">↑</KeyCap><KeyCap size="xs">↓</KeyCap> move</span>
        <span className="inline-flex items-center gap-1"><KeyCap size="xs">↵</KeyCap> switch</span>
        <span className="inline-flex items-center gap-1"><KeyCap size="xs">[</KeyCap><KeyCap size="xs">]</KeyCap> hop</span>
        <span className="inline-flex items-center gap-1"><KeyCap size="xs">Esc</KeyCap> close</span>
      </div>
    </>
  );
}

type PopPos = {
  left: number;
  width: number;
  maxHeight: number;
  above: boolean;
  top?: number;
  bottom?: number;
};

function computePopoverPos(anchorEl: HTMLElement, preferAbove: boolean): PopPos {
  const GAP = 8;
  const MARGIN = 12;
  const rect = anchorEl.getBoundingClientRect();
  const roomAbove = rect.top - MARGIN;
  const roomBelow = window.innerHeight - rect.bottom - MARGIN;
  let above = preferAbove;
  // Flip toward whichever side has room when the preferred side is cramped.
  if (above && roomAbove < 240 && roomBelow > roomAbove) above = false;
  else if (!above && roomBelow < 240 && roomAbove > roomBelow) above = true;
  const width = Math.min(560, Math.max(360, rect.width));
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const maxHeight = Math.min(560, Math.max(200, above ? roomAbove : roomBelow));
  return above
    ? { left, width, maxHeight, above, bottom: window.innerHeight - rect.top + GAP }
    : { left, width, maxHeight, above, top: rect.bottom + GAP };
}

export function ForkTreePopover({
  conversation,
  conversationId,
  open,
  onClose,
  anchorEl,
  placement = "above",
  onSwitchToConversation,
}: {
  conversation: ForkConversationLike;
  conversationId: string;
  open: boolean;
  onClose: () => void;
  anchorEl: HTMLElement | null;
  placement?: "above" | "below";
  onSwitchToConversation: (convId: string) => void;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PopPos | null>(null);

  useWatchEffect(() => {
    if (!open || !anchorEl) {
      setPos(null);
      return;
    }
    const update = () => setPos(computePopoverPos(anchorEl, placement === "above"));
    update();
    // Keep glued to the input as the window resizes (the conversation column
    // reflows). The popover is short-lived, so a resize listener is enough.
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [open, anchorEl, placement]);

  useWatchEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if (anchorEl?.contains(t)) return;
      onClose();
    };
    const raf = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClick);
    });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [open, onClose, anchorEl]);

  if (!open || !pos) return null;

  return createPortal(
    <div
      ref={popRef}
      style={{
        position: "fixed",
        left: pos.left,
        width: pos.width,
        maxHeight: pos.maxHeight,
        ...(pos.above ? { bottom: pos.bottom } : { top: pos.top }),
      }}
      className={`z-[9999] flex flex-col rounded-lg bg-sol-bg border border-sol-border shadow-2xl ring-1 ring-black/5 animate-in fade-in duration-150 ${
        pos.above ? "slide-in-from-bottom-1" : "slide-in-from-top-1"
      }`}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-sol-border shrink-0">
        <span className="text-[10px] text-sol-text-dim font-medium uppercase tracking-wider inline-flex items-center gap-1.5">
          <Split className="w-3 h-3 text-sol-cyan" />
          Branch map
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
      <ForkTreeContent
        conversation={conversation}
        conversationId={conversationId}
        open={open}
        onClose={onClose}
        onSwitchToConversation={onSwitchToConversation}
      />
    </div>,
    document.body
  );
}

// Transient HUD shown by the [ / ] branch-hop shortcuts: confirms where you
// landed ("3/7 · label") without opening the map. Fades itself out; the parent
// clears state via onDone.
export type BranchHop = {
  id: string;
  title: string;
  index: number;
  total: number;
  live?: BranchLive;
  ts: number;
};

export function BranchHopHud({ hop, onDone }: { hop: BranchHop | null; onDone: () => void }) {
  useEffect(() => {
    if (!hop) return;
    const t = setTimeout(onDone, 1600);
    return () => clearTimeout(t);
  }, [hop, onDone]);

  if (!hop) return null;

  return createPortal(
    <div
      key={hop.ts}
      className="fixed top-12 left-1/2 -translate-x-1/2 z-[9999] pointer-events-none animate-in fade-in slide-in-from-top-2 duration-150"
    >
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-sol-bg border border-sol-border shadow-lg text-xs">
        <Split className="w-3.5 h-3.5 text-sol-cyan flex-shrink-0" />
        <span className="text-sol-text-dim tabular-nums flex-shrink-0">
          {hop.index}/{hop.total}
        </span>
        <LiveDot live={hop.live} />
        <span className="text-sol-text truncate max-w-[280px]">{hop.title}</span>
      </div>
    </div>,
    document.body
  );
}
