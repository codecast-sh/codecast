import { AppLoader } from "./AppLoader";
import { useRef, useState, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Split, Search, GitFork, ChevronRight } from "lucide-react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useInboxStore, isConvexId } from "../store/inboxStore";
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

// Branch map: the single keyboard hub for the fork family. It anchors above the
// message input like a command palette and has two levels:
//   • branches — the whole fork tree; ↑/↓/j/k move, Enter switches, → / l / f
//     drills into a branch's messages, / filters, Esc closes.
//   • messages — the drilled branch's prompts (fork points); ↑/↓/j/k move,
//     f forks from that point (this is how you "fork higher" — drill into the
//     root or any ancestor and fork from an early message), Enter rewinds the
//     current branch there, ← / h / Esc go back, / filters.
// Keys are captured on `window` (capture phase) so single letters don't leak to
// the global conversation shortcuts, mirroring the message navigator.

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

type NavMsg = { _id: string; message_uuid?: string; content: string; timestamp: number };

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

// Tree rails: one fixed-width column per ancestor level. guides[i] = that
// ancestor has more siblings below (draw a full vertical line); the last column
// is this node's elbow.
function Rails({ guides }: { guides: boolean[] }) {
  if (guides.length === 0) return null;
  return (
    <div className="flex self-stretch flex-shrink-0" aria-hidden>
      {guides.slice(0, -1).map((g, i) => (
        <span key={i} className="w-3.5 relative">
          {g && <span className="absolute left-1/2 top-0 bottom-0 w-px bg-sol-border" />}
        </span>
      ))}
      <span className="w-3.5 relative">
        <span className={`absolute left-1/2 top-0 w-px bg-sol-border ${guides[guides.length - 1] ? "bottom-0" : "h-[15px]"}`} />
        <span className="absolute left-1/2 top-[15px] w-1.5 h-px bg-sol-border" />
      </span>
    </div>
  );
}

function BranchRow({
  node, isCurrent, isSelected, unread, flatMode, showAgent, showAuthor, onClick, onDrill, onMouseEnter, rowRef,
}: {
  node: FlatForkNode;
  isCurrent: boolean;
  isSelected: boolean;
  unread: number;
  flatMode: boolean;
  showAgent: boolean;
  showAuthor: boolean;
  onClick: () => void;
  onDrill: () => void;
  onMouseEnter: () => void;
  rowRef?: React.Ref<HTMLDivElement>;
}) {
  const count = branchDisplayCount(node);
  const label = branchDisplayLabel(node);
  const isRoot = node.depth === 0;
  const allUnread = unread > 0 && unread >= count;
  const partialUnread = unread > 0 && unread < count;
  return (
    <div
      ref={rowRef}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={`group w-full flex items-stretch gap-1.5 pr-1 rounded text-xs text-left transition-colors relative cursor-pointer ${
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
            <span className="text-[8px] uppercase tracking-wider px-1 py-px rounded bg-sol-cyan/15 text-sol-cyan flex-shrink-0 font-semibold">you</span>
          )}
          {isRoot && !isCurrent && (
            <span className="text-[8px] uppercase tracking-wider px-1 py-px rounded bg-sol-bg-alt text-sol-text-dim flex-shrink-0 font-semibold">root</span>
          )}
        </span>
        <span className="flex items-center gap-1.5 pl-3.5 min-w-0 text-[9px] text-sol-text-dim">
          <span
            className={`tabular-nums inline-flex items-center gap-0.5 flex-shrink-0 ${allUnread ? "text-sol-cyan font-semibold" : ""}`}
            title={isRoot ? `${count} messages` : `${count} message${count === 1 ? "" : "s"} on this branch since the fork${unread > 0 ? `, ${unread} unread` : ""}`}
          >
            <Split className="w-2.5 h-2.5 opacity-60" />{count}
          </span>
          {partialUnread && (
            <span className="tabular-nums flex-shrink-0 px-1 rounded-full bg-sol-cyan text-sol-bg font-semibold leading-tight">+{unread}</span>
          )}
          {showAgent && node.agent_type && (
            <span className={`font-medium flex-shrink-0 ${agentColors[node.agent_type] || ""}`}>{agentLabels[node.agent_type] || node.agent_type}</span>
          )}
          {showAuthor && node.username && <span className="truncate max-w-[90px]">{node.username}</span>}
          {node.updated_at ? <span className="flex-shrink-0 ml-auto">{relativeTime(node.updated_at)}</span> : null}
        </span>
      </span>
      {/* Drill affordance: reveals the branch's messages to fork from. */}
      <button
        onClick={(e) => { e.stopPropagation(); onDrill(); }}
        title="Show this branch's messages to fork from"
        className={`self-center flex-shrink-0 p-1 rounded text-sol-text-dim hover:text-sol-cyan hover:bg-sol-cyan/10 transition-colors ${isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
      >
        <ChevronRight className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function MessageRow({
  msg, num, isSelected, isCurrentBranch, onClick, onFork, onMouseEnter, rowRef,
}: {
  msg: NavMsg;
  num: number;
  isSelected: boolean;
  isCurrentBranch: boolean;
  onClick: () => void;
  onFork: () => void;
  onMouseEnter: () => void;
  rowRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={rowRef}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={`group w-full flex items-start gap-2 pl-2 pr-1 py-1.5 rounded text-xs text-left transition-colors relative cursor-pointer ${
        isSelected ? "bg-sol-cyan/15 text-sol-text" : "hover:bg-sol-bg-alt text-sol-text-secondary"
      }`}
    >
      {isSelected && <span className="absolute left-0 top-0.5 bottom-0.5 w-0.5 rounded-full bg-sol-cyan" />}
      <span className={`font-mono text-[9px] mt-0.5 w-5 text-right flex-shrink-0 tabular-nums ${isSelected ? "text-sol-cyan" : "text-sol-text-dim/50"}`}>{num}</span>
      <span className="flex-1 min-w-0 line-clamp-2 leading-snug">{msg.content}</span>
      <button
        onClick={(e) => { e.stopPropagation(); onFork(); }}
        title="Fork from this message"
        className={`self-center flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] text-sol-text-dim hover:text-sol-cyan hover:bg-sol-cyan/10 transition-colors ${isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
      >
        <GitFork className="w-3 h-3" />fork
      </button>
    </div>
  );
}

type Mode = "branches" | "messages";

function ForkTreeContent({
  conversation, conversationId, currentBranchId, open, initialDrillId, onClose, onSwitchToConversation, onForkFromBranch, onRewindCurrent,
}: {
  conversation: ForkConversationLike;
  conversationId: string;
  currentBranchId: string;
  open: boolean;
  // When set, the map opens directly drilled into this branch's messages
  // (double-Esc into the current branch) instead of the branch list.
  initialDrillId?: string | null;
  onClose: () => void;
  onSwitchToConversation: (convId: string) => void;
  onForkFromBranch: (branchId: string, messageUuid: string, content: string) => void;
  onRewindCurrent: (messageUuid: string, indexFromEnd: number) => void;
}) {
  const flat = useForkTree(conversation, open);
  const seenMessageCount = useInboxStore((s) => s._seenMessageCount);
  const currentUser = useInboxStore((s) => s.currentUser);

  const [mode, setMode] = useState<Mode>("branches");
  const [drillId, setDrillId] = useState<string | null>(null);
  const [branchSel, setBranchSel] = useState<string | null>(conversationId);
  const [msgSel, setMsgSel] = useState(0);
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  // Did we reach the message level by drilling from the branch list? Controls
  // where Esc goes: back to branches if you drilled in, close if you opened
  // straight into messages (double-Esc).
  const [drilledFromBranches, setDrilledFromBranches] = useState(false);

  const filterRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);

  // Fresh open: either straight into the current branch's messages (double-Esc)
  // or the branch list (Ctrl+B / icon), selected where you are.
  useWatchEffect(() => {
    if (open) {
      if (initialDrillId) {
        setMode("messages");
        setDrillId(initialDrillId);
        setDrilledFromBranches(false);
      } else {
        setMode("branches");
        setDrillId(null);
      }
      setBranchSel(conversationId);
      setFilter("");
      setFiltering(false);
    }
  }, [open]);

  const showAgent = useMemo(() => new Set(flat.map((n) => n.agent_type).filter(Boolean)).size > 1, [flat]);
  const myNames = useMemo(() => {
    const names = new Set<string>();
    if (currentUser?.name) names.add(currentUser.name);
    if (currentUser?.username) names.add(currentUser.username);
    return names;
  }, [currentUser]);

  // Branch-level list (filtered).
  const visibleBranches = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return flat;
    return flat.filter((n) =>
      branchDisplayLabel(n).toLowerCase().includes(q) ||
      n.username?.toLowerCase().includes(q) ||
      n.git_branch?.toLowerCase().includes(q) ||
      n.short_id?.toLowerCase().includes(q));
  }, [flat, filter]);
  const branchIdx = Math.max(0, visibleBranches.findIndex((n) => n.id === branchSel));
  const selectedBranch: FlatForkNode | undefined = visibleBranches[branchIdx];
  const drillBranch = useMemo(() => flat.find((n) => n.id === drillId), [flat, drillId]);

  // Message-level list for the drilled branch.
  const drillMsgsRaw = useQuery(
    api.conversations.getUserMessages,
    mode === "messages" && drillId && isConvexId(drillId) ? { conversation_id: drillId as any } : "skip",
  );
  const drillMsgs: NavMsg[] = useMemo(() => {
    const arr = Array.isArray(drillMsgsRaw) ? (drillMsgsRaw as NavMsg[]).slice() : [];
    arr.sort((a, b) => a.timestamp - b.timestamp); // oldest → newest
    return arr;
  }, [drillMsgsRaw]);
  const visibleMsgs = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return drillMsgs;
    return drillMsgs.filter((m) => (m.content || "").toLowerCase().includes(q));
  }, [drillMsgs, filter]);
  const selectedMsg: NavMsg | undefined = visibleMsgs[msgSel];

  // Default message selection to the newest (tip) whenever the list (re)loads.
  useWatchEffect(() => {
    if (mode === "messages") setMsgSel(Math.max(0, visibleMsgs.length - 1));
  }, [mode, drillId, visibleMsgs.length]);

  // Keep the selected row in view.
  useWatchEffect(() => {
    rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [branchIdx, msgSel, mode, visibleBranches.length, visibleMsgs.length]);

  const enterFilter = useCallback(() => {
    setFiltering(true);
    requestAnimationFrame(() => filterRef.current?.focus());
  }, []);
  const exitFilter = useCallback(() => {
    setFiltering(false);
    setFilter("");
    filterRef.current?.blur();
  }, []);

  const drillInto = useCallback((id: string) => {
    setDrillId(id);
    setMode("messages");
    setDrilledFromBranches(true);
    setFilter("");
    setFiltering(false);
  }, []);

  const backToBranches = useCallback(() => {
    setMode("branches");
    setFilter("");
    setFiltering(false);
  }, []);

  // Esc from the message level: back to the tree if you drilled in, else close
  // (you opened straight into messages via double-Esc).
  const messagesBack = useCallback(() => {
    if (drilledFromBranches) backToBranches();
    else onClose();
  }, [drilledFromBranches, backToBranches, onClose]);

  const switchToBranch = useCallback((id: string) => {
    if (id !== conversationId) onSwitchToConversation(id);
    onClose();
  }, [conversationId, onSwitchToConversation, onClose]);

  const forkFromMsg = useCallback((branchId: string, m: NavMsg | undefined) => {
    if (!m?.message_uuid) return;
    onForkFromBranch(branchId, m.message_uuid, m.content || "");
    onClose();
  }, [onForkFromBranch, onClose]);

  const rewindToMsg = useCallback((branchId: string, idx: number, list: NavMsg[]) => {
    const m = list[idx];
    if (!m?.message_uuid) return;
    if (branchId === currentBranchId) {
      onRewindCurrent(m.message_uuid, list.length - 1 - idx);
      onClose();
    } else {
      // Can't rewind a branch you're not on — forking is the safe equivalent.
      forkFromMsg(branchId, m);
    }
  }, [currentBranchId, onRewindCurrent, onClose, forkFromMsg]);

  // Command-mode keys, captured on window so they beat the global dispatcher.
  useWatchEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (filtering) return; // the filter input owns keys while active
      const k = e.key;
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      if (k === "/") { stop(); enterFilter(); return; }
      if (k === "Escape") {
        stop();
        if (mode === "messages") messagesBack();
        else onClose();
        return;
      }
      if (k === "j" || k === "ArrowDown") {
        stop();
        if (mode === "branches") {
          const next = visibleBranches[Math.min(branchIdx + 1, visibleBranches.length - 1)];
          if (next) setBranchSel(next.id);
        } else setMsgSel((i) => Math.min(i + 1, visibleMsgs.length - 1));
        return;
      }
      if (k === "k" || k === "ArrowUp") {
        stop();
        if (mode === "branches") {
          const prev = visibleBranches[Math.max(branchIdx - 1, 0)];
          if (prev) setBranchSel(prev.id);
        } else setMsgSel((i) => Math.max(i - 1, 0));
        return;
      }
      if (mode === "branches") {
        if (k === "Enter") { stop(); if (selectedBranch) switchToBranch(selectedBranch.id); return; }
        if (k === "l" || k === "ArrowRight" || k === "f" || k === "F") {
          stop();
          if (selectedBranch) drillInto(selectedBranch.id);
          return;
        }
      } else {
        if (k === "f" || k === "F") { stop(); if (drillId) forkFromMsg(drillId, selectedMsg); return; }
        if (k === "Enter") { stop(); if (drillId) rewindToMsg(drillId, msgSel, visibleMsgs); return; }
        if (k === "h" || k === "ArrowLeft") { stop(); backToBranches(); return; }
      }
      // The map owns the keyboard while open: swallow stray plain keys so they
      // neither type into the still-focused composer nor trigger global
      // conversation shortcuts (d=diff, t=tree…). Modifier combos (Ctrl+B to
      // close, ⌘K palette) still pass through.
      if (!e.metaKey && !e.ctrlKey && !e.altKey && k.length === 1) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, filtering, mode, branchIdx, visibleBranches, selectedBranch, visibleMsgs, msgSel, drillId, selectedMsg,
      enterFilter, backToBranches, messagesBack, onClose, switchToBranch, drillInto, forkFromMsg, rewindToMsg]);

  // Filter input: drives selection while typing.
  const onFilterKey = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); exitFilter(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (mode === "branches") { const n = visibleBranches[Math.min(branchIdx + 1, visibleBranches.length - 1)]; if (n) setBranchSel(n.id); }
      else setMsgSel((i) => Math.min(i + 1, visibleMsgs.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (mode === "branches") { const n = visibleBranches[Math.max(branchIdx - 1, 0)]; if (n) setBranchSel(n.id); }
      else setMsgSel((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (mode === "branches") { if (selectedBranch) switchToBranch(selectedBranch.id); }
      else if (drillId) forkFromMsg(drillId, selectedMsg);
      return;
    }
  }, [mode, visibleBranches, branchIdx, visibleMsgs, selectedBranch, selectedMsg, drillId, exitFilter, switchToBranch, forkFromMsg]);

  const headerLabel = mode === "branches"
    ? `${flat.length} branch${flat.length === 1 ? "" : "es"}`
    : (drillBranch ? branchDisplayLabel(drillBranch) : "messages");

  return (
    <>
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-sol-border shrink-0">
        {mode === "messages" && (
          <button onClick={backToBranches} title="Back to branches" className="p-0.5 rounded text-sol-text-dim hover:text-sol-cyan hover:bg-sol-bg-alt">
            <ChevronRight className="w-3.5 h-3.5 rotate-180" />
          </button>
        )}
        {filtering ? (
          <>
            <Search className="w-3 h-3 text-sol-text-dim flex-shrink-0" />
            <input
              ref={filterRef}
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={onFilterKey}
              placeholder={mode === "branches" ? "Filter branches…" : "Filter messages…"}
              className="flex-1 min-w-0 bg-transparent text-xs text-sol-text placeholder:text-sol-text-dim outline-none"
            />
          </>
        ) : (
          <>
            <span className="text-[10px] text-sol-text-dim font-medium uppercase tracking-wider truncate flex-1 min-w-0">
              {headerLabel}
            </span>
            <button onClick={enterFilter} title="Filter ( / )" className="p-0.5 rounded text-sol-text-dim hover:text-sol-cyan hover:bg-sol-bg-alt flex-shrink-0">
              <Search className="w-3 h-3" />
            </button>
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-1.5 min-h-0">
        {mode === "branches" ? (
          flat.length === 0 ? (
            <AppLoader className="min-h-0 bg-transparent py-8" size={24} />
          ) : visibleBranches.length === 0 ? (
            <div className="py-6 text-center text-[11px] text-sol-text-dim">No branches match</div>
          ) : (
            visibleBranches.map((node, idx) => (
              <BranchRow
                key={node.id}
                node={node}
                isCurrent={node.id === conversationId}
                isSelected={idx === branchIdx}
                unread={branchUnread(node, seenMessageCount[node.id], node.id === conversationId)}
                flatMode={filter.trim().length > 0}
                showAgent={showAgent}
                showAuthor={!!node.username && !myNames.has(node.username)}
                onClick={() => switchToBranch(node.id)}
                onDrill={() => drillInto(node.id)}
                onMouseEnter={() => setBranchSel(node.id)}
                rowRef={idx === branchIdx ? rowRef : undefined}
              />
            ))
          )
        ) : drillMsgsRaw === undefined ? (
          <AppLoader className="min-h-0 bg-transparent py-8" size={24} />
        ) : visibleMsgs.length === 0 ? (
          <div className="py-6 text-center text-[11px] text-sol-text-dim">{filter ? "No messages match" : "No messages on this branch"}</div>
        ) : (
          visibleMsgs.map((m, idx) => (
            <MessageRow
              key={m._id}
              msg={m}
              num={idx + 1}
              isSelected={idx === msgSel}
              isCurrentBranch={drillId === currentBranchId}
              onClick={() => setMsgSel(idx)}
              onFork={() => drillId && forkFromMsg(drillId, m)}
              onMouseEnter={() => setMsgSel(idx)}
              rowRef={idx === msgSel ? rowRef : undefined}
            />
          ))
        )}
      </div>

      <div className="px-3 py-2 border-t border-sol-border text-[9px] text-sol-text-dim shrink-0 flex items-center gap-3 flex-wrap">
        <span className="inline-flex items-center gap-1"><KeyCap size="xs">↑</KeyCap><KeyCap size="xs">↓</KeyCap> move</span>
        {mode === "branches" ? (
          <>
            <span className="inline-flex items-center gap-1"><KeyCap size="xs">↵</KeyCap> switch</span>
            <span className="inline-flex items-center gap-1"><KeyCap size="xs">→</KeyCap> drill</span>
            <span className="inline-flex items-center gap-1"><KeyCap size="xs">f</KeyCap> fork from…</span>
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-1"><KeyCap size="xs">f</KeyCap> fork here</span>
            {drillId === currentBranchId && <span className="inline-flex items-center gap-1"><KeyCap size="xs">↵</KeyCap> rewind</span>}
            <span className="inline-flex items-center gap-1"><KeyCap size="xs">←</KeyCap> back</span>
          </>
        )}
        <span className="inline-flex items-center gap-1"><KeyCap size="xs">/</KeyCap> filter</span>
        <span className="inline-flex items-center gap-1"><KeyCap size="xs">Esc</KeyCap> close</span>
      </div>
    </>
  );
}

type PopPos = { left: number; width: number; maxHeight: number; above: boolean; top?: number; bottom?: number };

function computePopoverPos(anchorEl: HTMLElement, preferAbove: boolean): PopPos {
  const GAP = 8;
  const MARGIN = 12;
  const rect = anchorEl.getBoundingClientRect();
  const roomAbove = rect.top - MARGIN;
  const roomBelow = window.innerHeight - rect.bottom - MARGIN;
  let above = preferAbove;
  if (above && roomAbove < 240 && roomBelow > roomAbove) above = false;
  else if (!above && roomBelow < 240 && roomAbove > roomBelow) above = true;
  const width = Math.min(560, Math.max(380, rect.width));
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const maxHeight = Math.min(560, Math.max(220, above ? roomAbove : roomBelow));
  return above
    ? { left, width, maxHeight, above, bottom: window.innerHeight - rect.top + GAP }
    : { left, width, maxHeight, above, top: rect.bottom + GAP };
}

export function ForkTreePopover({
  conversation, conversationId, currentBranchId, open, initialDrillId, onClose, anchorEl, placement = "above", onSwitchToConversation, onForkFromBranch, onRewindCurrent,
}: {
  conversation: ForkConversationLike;
  conversationId: string;
  currentBranchId: string;
  open: boolean;
  initialDrillId?: string | null;
  onClose: () => void;
  anchorEl: HTMLElement | null;
  placement?: "above" | "below";
  onSwitchToConversation: (convId: string) => void;
  onForkFromBranch: (branchId: string, messageUuid: string, content: string) => void;
  onRewindCurrent: (messageUuid: string, indexFromEnd: number) => void;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PopPos | null>(null);

  useWatchEffect(() => {
    if (!open || !anchorEl) { setPos(null); return; }
    const update = () => setPos(computePopoverPos(anchorEl, placement === "above"));
    update();
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
    const raf = requestAnimationFrame(() => document.addEventListener("mousedown", handleClick));
    return () => { cancelAnimationFrame(raf); document.removeEventListener("mousedown", handleClick); };
  }, [open, onClose, anchorEl]);

  if (!open || !pos) return null;

  return createPortal(
    <div
      ref={popRef}
      style={{ position: "fixed", left: pos.left, width: pos.width, maxHeight: pos.maxHeight, ...(pos.above ? { bottom: pos.bottom } : { top: pos.top }) }}
      className={`z-[9999] flex flex-col rounded-lg bg-sol-bg border border-sol-border shadow-2xl ring-1 ring-black/5 animate-in fade-in duration-150 ${pos.above ? "slide-in-from-bottom-1" : "slide-in-from-top-1"}`}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-sol-border shrink-0">
        <span className="text-[10px] text-sol-text-dim font-medium uppercase tracking-wider inline-flex items-center gap-1.5">
          <Split className="w-3 h-3 text-sol-cyan" />Branch map
        </span>
        <button onClick={onClose} className="p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <ForkTreeContent
        conversation={conversation}
        conversationId={conversationId}
        currentBranchId={currentBranchId}
        open={open}
        initialDrillId={initialDrillId}
        onClose={onClose}
        onSwitchToConversation={onSwitchToConversation}
        onForkFromBranch={onForkFromBranch}
        onRewindCurrent={onRewindCurrent}
      />
    </div>,
    document.body,
  );
}
