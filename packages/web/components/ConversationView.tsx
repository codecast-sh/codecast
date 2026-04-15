import Link from "next/link";
import { LogoIcon } from "./Logo";
import { useRouter } from "next/navigation";
import { useLayoutEffect, useRef, useState, useMemo, useImperativeHandle, forwardRef, useCallback, memo, createContext, useContext, ComponentProps } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useEventListener } from "../hooks/useEventListener";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useShortcutContext, useShortcutAction, formatShortcutLabel } from "../shortcuts";
import { useConvexSync } from "../hooks/useConvexSync";
import { createPortal } from "react-dom";
import ReactMarkdownBase from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { rehypeSearchHighlight } from "../lib/rehypeSearchHighlight";
import { useVirtualizer } from "@tanstack/react-virtual";
import { isCommandMessage, getCommandType, cleanContent, cleanTitle, isSkillExpansion, extractSkillInfo, extractSkillsFromMessages, extractFilePaths, isSystemMessage } from "../lib/conversationProcessor";
import { getBuiltinCommands } from "../lib/builtinCommands";
import type { SkillItem } from "../lib/conversationProcessor";
import { createReducer, reducer } from "../lib/messageReducer";
import { UsageDisplay } from "./UsageDisplay";
import { ErrorBoundary } from "./ErrorBoundary";
import { KeyCap, MenuKeyCaps } from "./KeyboardShortcutsHelp";
import { toast } from "sonner";
import { CodeBlock } from "./CodeBlock";
import { useDiffViewerStore } from "../store/diffViewerStore";

function copyMessageLink(conversationId: string | undefined, messageId: string) {
  const url = `${shareOrigin()}/conversation/${conversationId}#msg-${messageId}`;
  setTimeout(() => { copyToClipboard(url).then(() => toast.success("Link copied!")).catch(() => toast.error("Failed to copy link")); });
}

function extractTextFromHast(node: any): string {
  if (!node) return '';
  if (node.type === 'text') return node.value || '';
  if (node.children) return node.children.map(extractTextFromHast).join('');
  return '';
}
import { extractFileChanges } from "../lib/fileChangeExtractor";
import { CommitCard } from "./CommitCard";
import { PRCard } from "./PRCard";
import { DiffView } from "./DiffView";
import { AgentTypeIcon, formatAgentType } from "./AgentTypeIcon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./ui/tooltip";
import { useMutation, useQuery, useConvex, useConvexAuth } from "convex/react";
import { api as _typedApi } from "@codecast/convex/convex/_generated/api";
const api = _typedApi as any;
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { CommentPanel } from "./CommentPanel";
import { PermissionStack } from "./PermissionCard";
import { copyToClipboard, shareOrigin } from "../lib/utils";
import { MarkdownRenderer, isMarkdownFile, isPlanFile, CollapsibleImage } from "./tools/MarkdownRenderer";
import { useImageGallery, ImageGalleryProvider } from "./ImageGallery";
import { MessageSharePopover } from "./MessageSharePopover";
import { PlanBadge, TaskBadge } from "./PlanTaskHoverCard";
import { EntityIdPill, EntityAwareCode, EntityAwareLink, renderWithMentions } from "./EntityIdPill";
import { remarkEntityIds } from "../lib/remarkEntityIds";
import { ConversationTree } from "./ConversationTree";
import { useInboxStore, isConvexId, type ForkChild } from "../store/inboxStore";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { soundSend } from "../lib/sounds";
import { useForkNavigationStore } from "../store/forkNavigationStore";
import { buildCompositeTimeline } from "../lib/compositeTimeline";
import { useMessageSelection } from "../hooks/useMessageSelection";
import { useForkMessages } from "../hooks/useForkMessages";
import { BranchSelector } from "./BranchSelector";
import { ForkTreePanel } from "./ForkTreePanel";
import { getApplyPatchInput, parseApplyPatchSections } from "../lib/applyPatchParser";
import { parseFileChangeSummary, parseUnifiedDiffSections } from "../lib/unifiedDiffParser";
import { setupDesktopDrag, desktopHeaderClass } from "../lib/desktop";
import { MessageNavButton } from "./MessageBrowserPopover";
import type { MentionItem } from "./editor/MentionList";
import { CheckSquare, FileText, MessageSquare, Map as MapIcon, User, Hash, FolderOpen, Keyboard, ListChecks, Target, Maximize2, Minimize2, Circle, CircleDot, CheckCircle2, ChevronDown, ChevronRight, Clock } from "lucide-react";
import { ComposeEditor, type ComposeEditorHandle } from "./editor/ComposeEditor";
import { useMentionQuery } from "../hooks/useMentionQuery";

const sacredInputs = new Map<string, { text: string; images?: any[] }>();
const EMPTY_PENDING: any[] = [];
const EMPTY_MATCH_IDS: string[] = [];
const EMPTY_MATCH_INSTANCES: { messageId: string; localIndex: number; timestamp: number }[] = [];

/** Ensure a value is a string before rendering as a React child.
 *  Guards against intermittent race conditions where content fields
 *  are briefly non-string during store hydration or subscription updates. */
function safeString(value: any): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function renderMarkdownPre(node: any, children: any, props: any) {
  const codeElement = node?.children?.[0];
  if (codeElement && codeElement.type === "element" && codeElement.tagName === "code") {
    const className = codeElement.properties?.className as string[] | undefined;
    const language = className?.find((cls) => cls.startsWith("language-"))?.replace("language-", "");
    const code = extractTextFromHast(codeElement);
    if (code) return <CodeBlock code={code} language={language} />;
  }
  return <pre {...(props as any)}>{children as any}</pre>;
}

const entityRemarkPlugins = [remarkGfm, remarkEntityIds];

function parseSearchTerms(query: string): string[] {
  const terms: string[] = [];
  const regex = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = regex.exec(query)) !== null) {
    const term = match[1] || match[2];
    if (term) terms.push(term.toLowerCase());
  }
  return terms;
}

const HighlightContext = createContext<string | undefined>(undefined);

type ReactMarkdownProps = ComponentProps<typeof ReactMarkdownBase>;

/**
 * ReactMarkdown wrapper that appends `rehypeSearchHighlight` to the plugin list
 * whenever a `highlightQuery` is active in the HighlightContext. Because the plugin
 * transforms the HAST before React renders, highlights are part of the VDOM and
 * survive re-renders — avoiding the MutationObserver/TreeWalker race we used before.
 */
function ReactMarkdown(props: ReactMarkdownProps) {
  const query = useContext(HighlightContext);
  const userPlugins = props.rehypePlugins;
  const plugins = useMemo(() => {
    const base = userPlugins ? [...userPlugins] : [];
    if (!query) return base;
    const terms = parseSearchTerms(query);
    if (terms.length === 0) return base;
    base.push([rehypeSearchHighlight, { terms }]);
    return base;
  }, [query, userPlugins]);
  return <ReactMarkdownBase {...props} rehypePlugins={plugins} />;
}

type ToolCall = {
  id: string;
  name: string;
  input: string;
};

type ToolResult = {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

type ImageData = {
  media_type: string;
  data?: string;
  storage_id?: string;
  tool_use_id?: string;
};

function formatMessagePartsForCopy(
  content: string | undefined,
  toolCalls: ToolCall[] | undefined,
  toolResults: ToolResult[] | undefined,
): string {
  const parts: string[] = [];
  if (content?.trim()) {
    parts.push(content);
  }
  if (toolCalls?.length) {
    for (const tc of toolCalls) {
      let input = tc.input;
      try { input = JSON.stringify(JSON.parse(tc.input), null, 2); } catch {}
      parts.push(`[Tool: ${tc.name}]\n${input}`);
    }
  }
  if (toolResults?.length) {
    for (const tr of toolResults) {
      const errPrefix = tr.is_error ? " (error)" : "";
      parts.push(`[Result${errPrefix}]\n${tr.content}`);
    }
  }
  return parts.join("\n\n");
}

type Message = {
  _id: string;
  message_uuid?: string;
  role: string;
  content?: string;
  timestamp: number;
  thinking?: string;
  tool_calls?: ToolCall[];
  tool_results?: ToolResult[];
  images?: ImageData[];
  subtype?: string;
  _isOptimistic?: true;
  _isQueued?: true;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

export type ConversationData = {
  _id: Id<"conversations">;
  user_id?: string;
  is_own?: boolean;
  title?: string;
  session_id?: string;
  agent_type?: string;
  model?: string;
  started_at?: number;
  updated_at?: number;
  share_token?: string;
  message_count?: number;
  messages: Message[];
  user?: { name?: string; email?: string; avatar_url?: string | null } | null;
  parent_conversation_id?: string | null;
  child_conversations?: Array<{ _id: string; title: string; is_subagent?: boolean; first_message_preview?: string }>;
  child_conversation_map?: Record<string, string>;
  git_branch?: string | null;
  git_status?: string | null;
  git_remote_url?: string | null;
  project_path?: string | null;
  git_root?: string | null;
  short_id?: string;
  status?: "active" | "completed";
  fork_count?: number;
  forked_from?: string;
  forked_from_details?: {
    conversation_id: string;
    share_token?: string;
    username: string;
  } | null;
  is_favorite?: boolean;
  workflow_run_id?: string | null;
  is_workflow_primary?: boolean;
  draft_message?: string;
  subtitle?: string | null;
  compaction_count?: number;
  loaded_start_index?: number;
  agent_name_map?: Record<string, string>;
  fork_children?: Array<{
    _id: string;
    title: string;
    short_id?: string;
    started_at: number;
    username: string;
    parent_message_uuid?: string;
    message_count?: number;
    agent_type?: string;
  }>;
  main_message_counts_by_fork?: Record<string, number>;
};

type CommitFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

type Commit = {
  _id: string;
  sha: string;
  message: string;
  timestamp: number;
  files_changed: number;
  insertions: number;
  deletions: number;
  author_name: string;
  author_email: string;
  repository?: string;
  files?: CommitFile[];
};

type PRFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

type PullRequest = {
  _id: Id<"pull_requests">;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  repository: string;
  author_github_username: string;
  head_ref?: string;
  base_ref?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits_count?: number;
  files?: PRFile[];
  created_at: number;
  updated_at: number;
  merged_at?: number;
};

type ConversationViewProps = {
  conversation: ConversationData | null | undefined;
  commits?: Commit[];
  pullRequests?: PullRequest[];
  backHref: string;
  backLabel?: string;
  headerExtra?: React.ReactNode;
  hasMoreAbove?: boolean;
  hasMoreBelow?: boolean;
  isLoadingOlder?: boolean;
  isLoadingNewer?: boolean;
  onLoadOlder?: () => void;
  onLoadNewer?: () => void;
  onJumpToStart?: () => void;
  onJumpToEnd?: () => void;
  onJumpToTimestamp?: (ts: number) => void;
  highlightQuery?: string;
  onClearHighlight?: () => void;
  embedded?: boolean;
  showMessageInput?: boolean;
  targetMessageId?: string;
  isOwner?: boolean;
  onSendAndAdvance?: () => void;
  onSendAndDismiss?: () => void;
  autoFocusInput?: boolean;
  fallbackStickyContent?: string | null;
  onBack?: () => void;
  subHeaderContent?: React.ReactNode;
  headerLeft?: React.ReactNode;
  headerEnd?: React.ReactNode;
  hideHeader?: boolean;
};

export interface ConversationViewHandle {
  scrollToMessage: (messageId: string) => void;
}

function ProjectSwitcher({ conversation }: { conversation: ConversationData }) {
  const freshProjects = useQuery(api.users.getRecentProjectPaths, { limit: 8 });
  const cachedProjects = useInboxStore((s) => s.recentProjects);
  const setRecentProjects = useInboxStore((s) => s.setRecentProjects);
  const storeSession = useInboxStore((s) =>
    s.sessions[conversation._id]
  );
  const openNewSession = useInboxStore((s) => s.openNewSession);
  const isolated = useInboxStore((s) => s.isolatedWorktreeMode);
  const reconfigureSession = useMutation(api.conversations.reconfigureSession);

  const recentProjects = freshProjects ?? cachedProjects;

  useConvexSync(freshProjects, setRecentProjects);

  const currentConvContext = useInboxStore((s) => s.currentConversation);
  const derivedPath = storeSession?.project_path || storeSession?.git_root || conversation.git_root || conversation.project_path || currentConvContext?.projectPath || currentConvContext?.gitRoot;
  // Local override immune to server sync — prevents snap-back on click
  const [localPath, setLocalPath] = useState<string | null>(null);
  const currentPath = localPath ?? derivedPath;
  const currentName = currentPath?.split("/").filter(Boolean).pop() || "unknown";

  const otherProjects = useMemo(() => {
    return recentProjects.filter((p: { path: string }) => p.path !== currentPath);
  }, [recentProjects, currentPath]);

  const visibleProjects = otherProjects.slice(0, 6);

  const handleSwitch = useCallback(async (projectPath: string, forceIsolated?: boolean) => {
    const trimmed = projectPath.trim();
    if (!trimmed) return;
    if (trimmed === currentPath && !forceIsolated) return;
    setLocalPath(trimmed);
    const id = storeSession?._id || conversation._id;
    useInboxStore.getState().updateSessionProject(id, trimmed);
    if (isConvexId(id)) {
      reconfigureSession({
        conversation_id: id as Id<"conversations">,
        project_path: trimmed,
        git_root: trimmed,
        isolated: (forceIsolated ?? isolated) || undefined,
      }).catch((err) => toast.error(err instanceof Error ? err.message : "Failed to switch project"));
    }
  }, [storeSession, conversation._id, reconfigureSession, currentPath, isolated]);

  return (
    <div className="flex flex-col items-center gap-3">
        {currentPath ? (
          <div className="flex items-center gap-2 text-sol-text-muted text-xs cursor-default" title={currentPath}>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
            </svg>
            <span className="font-medium text-sol-text">{currentName}</span>
          </div>
        ) : recentProjects.length > 0 ? (
          <div className="text-sol-text-dim text-xs">select a project</div>
        ) : null}

      <div className="flex flex-wrap justify-center gap-1.5">
        {currentPath && (
          <button
            onClick={() => handleSwitch(currentPath)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-sol-cyan/40 bg-sol-cyan/5 text-sol-cyan transition-all"
            title={currentPath}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
            </svg>
            <span>{currentName}</span>
          </button>
        )}
        {visibleProjects.map((p: { path: string }) => {
          const name = p.path.split("/").filter(Boolean).pop();
          return (
            <button
              key={p.path}
              onClick={() => handleSwitch(p.path)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-cyan/40 hover:bg-sol-cyan/5 transition-all"
              title={p.path}
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
              </svg>
              <span>{name}</span>
            </button>
          );
        })}
        <button
          onClick={() => openNewSession({ projectPath: currentPath || undefined })}
          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-dashed border-sol-border/50 text-sol-text-dim hover:text-sol-cyan hover:border-sol-cyan/40 hover:bg-sol-cyan/5 transition-all"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM12.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM18.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
          </svg>
          <span>other</span>
        </button>
      </div>

      <button
        onClick={() => {
          const turningOn = !isolated;
          useInboxStore.getState().setIsolatedWorktreeMode(turningOn);
          if (turningOn && currentPath) {
            handleSwitch(currentPath, true);
          }
        }}
        className="flex items-center gap-2 text-[11px] text-sol-text-dim hover:text-sol-text transition-colors"
        title="Create session in an isolated git worktree"
      >
        <span className={`w-7 h-4 rounded-full transition-colors relative flex-shrink-0 ${isolated ? "bg-sol-cyan/30" : "bg-sol-bg-alt"}`}>
          <span className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${isolated ? "left-3.5 bg-sol-cyan" : "left-0.5 bg-sol-text-dim"}`} />
        </span>
        <span className={isolated ? "text-sol-cyan" : ""}>isolated worktree</span>
      </button>

    </div>
  );
}

function AgentSwitcher({ conversation, showWorkflow, onToggleWorkflow, selectedWorkflowId, onSelectWorkflow, workflows }: {
  conversation: ConversationData;
  showWorkflow: boolean;
  onToggleWorkflow: () => void;
  selectedWorkflowId: string;
  onSelectWorkflow: (id: string) => void;
  workflows: Array<{ _id: string; name: string }> | undefined;
}) {
  const reconfigureSession = useMutation(api.conversations.reconfigureSession);
  const storeSession = useInboxStore((s) => s.sessions[conversation._id]);
  const currentAgent = storeSession?.agent_type || conversation.agent_type || "claude_code";

  const handleAgentSwitch = useCallback(async (agentType: "claude_code" | "codex" | "cursor" | "gemini") => {
    if (agentType === currentAgent) return;
    try {
      const id = storeSession?._id || conversation._id;
      useInboxStore.getState().setConversationAgent(id, agentType);

      if (isConvexId(id)) {
        reconfigureSession({
          conversation_id: id as Id<"conversations">,
          agent_type: agentType,
        }).catch(() => {});
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to switch agent");
    }
  }, [storeSession, conversation._id, reconfigureSession, currentAgent]);

  const agents = [
    { type: "claude_code" as const, label: "Claude" },
    { type: "codex" as const, label: "Codex" },
    { type: "cursor" as const, label: "Cursor" },
    { type: "gemini" as const, label: "Gemini" },
  ];

  return (
    <div className="flex flex-col items-center gap-2 px-4 pb-7">
      <div className="flex items-center gap-1.5">
        {agents.map((a) => {
          const isActive = currentAgent === a.type && !showWorkflow;
          return (
            <button
              key={a.type}
              onClick={() => { handleAgentSwitch(a.type); if (showWorkflow) onToggleWorkflow(); }}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border transition-all ${
                isActive
                  ? a.type === "claude_code"
                    ? "bg-sol-yellow/15 text-sol-yellow border-sol-yellow/40"
                    : a.type === "codex"
                      ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/40"
                      : a.type === "cursor"
                        ? "bg-purple-500/15 text-purple-400 border-purple-500/40"
                        : "bg-blue-500/15 text-blue-400 border-blue-500/40"
                  : "border-sol-border/30 text-sol-text-dim hover:text-sol-text hover:border-sol-border/60"
              }`}
            >
              <AgentTypeIcon agentType={a.type} />
              {a.label}
            </button>
          );
        })}
        <span className="text-sol-border/50 text-xs">|</span>
        <button
          onClick={onToggleWorkflow}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border transition-all ${
            showWorkflow
              ? "bg-sol-violet/15 text-sol-violet border-sol-violet/40"
              : "border-sol-border/30 text-sol-text-dim hover:text-sol-text hover:border-sol-border/60"
          }`}
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          Workflow
        </button>
      </div>

      {showWorkflow && (
        <select
          value={selectedWorkflowId}
          onChange={(e) => onSelectWorkflow(e.target.value)}
          className="w-full max-w-sm px-3 py-1.5 text-xs bg-sol-bg-alt border border-sol-violet/40 rounded-lg text-sol-text focus:outline-none focus:border-sol-violet/70"
        >
          <option value="">Select a workflow...</option>
          {(workflows || []).map((wf) => (
            <option key={wf._id} value={wf._id}>{wf.name}</option>
          ))}
        </select>
      )}
    </div>
  );
}

function ConversationSkeleton() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-4 space-y-6 animate-pulse motion-reduce:animate-none">
      <div className="bg-sol-blue/10 border border-sol-blue/30 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded bg-sol-blue/30" />
          <div className="h-3 w-12 bg-sol-blue/30 rounded" />
          <div className="h-3 w-16 bg-sol-blue/20 rounded" />
        </div>
        <div className="pl-8 space-y-2">
          <div className="h-3 bg-sol-blue/20 rounded w-3/4" />
          <div className="h-3 bg-sol-blue/20 rounded w-1/2" />
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded bg-sol-orange/60" />
          <div className="h-3 w-14 bg-sol-bg-alt rounded" />
          <div className="h-3 w-16 bg-sol-bg-alt rounded" />
        </div>
        <div className="pl-8 space-y-2">
          <div className="h-3 bg-sol-bg-alt rounded w-full" />
          <div className="h-3 bg-sol-bg-alt rounded w-5/6" />
          <div className="h-3 bg-sol-bg-alt rounded w-4/5" />
        </div>
      </div>

      <div className="bg-sol-blue/10 border border-sol-blue/30 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded bg-sol-blue/30" />
          <div className="h-3 w-12 bg-sol-blue/30 rounded" />
          <div className="h-3 w-16 bg-sol-blue/20 rounded" />
        </div>
        <div className="pl-8">
          <div className="h-3 bg-sol-blue/20 rounded w-2/3" />
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded bg-sol-orange/60" />
          <div className="h-3 w-14 bg-sol-bg-alt rounded" />
          <div className="h-3 w-16 bg-sol-bg-alt rounded" />
        </div>
        <div className="pl-8 space-y-2">
          <div className="h-3 bg-sol-bg-alt rounded w-full" />
          <div className="h-3 bg-sol-bg-alt rounded w-11/12" />
          <div className="h-3 bg-sol-bg-alt rounded w-3/4" />
          <div className="h-3 bg-sol-bg-alt rounded w-5/6" />
        </div>
      </div>
    </div>
  );
}

function formatTimestamp(ts: number) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(startTs: number): string {
  const diff = Date.now() - startTs;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) return remainMin ? `${hours}h ${remainMin}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function stripAnsiCodes(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

const ANSI_COLORS: Record<number, string> = {
  30: '#073642', 31: '#dc322f', 32: '#859900', 33: '#b58900',
  34: '#268bd2', 35: '#d33682', 36: '#2aa198', 37: '#eee8d5',
  90: '#586e75', 91: '#cb4b16', 92: '#859900', 93: '#b58900',
  94: '#268bd2', 95: '#6c71c4', 96: '#2aa198', 97: '#fdf6e3',
};

function renderAnsi(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /\x1b\[([0-9;]*)m/g;
  let lastIndex = 0;
  let currentColor: string | null = null;
  let bold = false;

  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const segment = text.slice(lastIndex, match.index);
      if (currentColor || bold) {
        parts.push(<span key={parts.length} style={{ color: currentColor || undefined, fontWeight: bold ? 700 : undefined }}>{segment}</span>);
      } else {
        parts.push(segment);
      }
    }
    lastIndex = regex.lastIndex;

    const codes = match[1].split(';').map(Number);
    for (const code of codes) {
      if (code === 0) { currentColor = null; bold = false; }
      else if (code === 1) { bold = true; }
      else if (ANSI_COLORS[code]) { currentColor = ANSI_COLORS[code]; }
    }
  }

  if (lastIndex < text.length) {
    const segment = text.slice(lastIndex);
    if (currentColor || bold) {
      parts.push(<span key={parts.length} style={{ color: currentColor || undefined, fontWeight: bold ? 700 : undefined }}>{segment}</span>);
    } else {
      parts.push(segment);
    }
  }

  return parts.length > 0 ? parts : text;
}

function stripSystemTags(content: string): string {
  return content
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<\/?(?:command-(?:name|message|args)|antml:[a-z_]+)[^>]*>/g, '')
    .replace(/^\s*Caveat:.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

type ParsedApiError = {
  statusCode: number;
  message: string;
  errorType?: string;
  requestId?: string;
};

function parseApiErrorContent(content?: string | null): ParsedApiError | null {
  if (!content) return null;
  const trimmed = content.trim();
  const match = trimmed.match(/^API Error:\s*(\d{3})\s*([\s\S]*)$/i);
  if (!match) return null;

  const statusCode = Number(match[1]);
  const payloadText = (match[2] || "").trim();
  let message = "";
  let errorType: string | undefined;
  let requestId: string | undefined;

  if (payloadText.startsWith("{")) {
    try {
      const parsed = JSON.parse(payloadText) as Record<string, unknown>;
      if (typeof parsed.request_id === "string") {
        requestId = parsed.request_id;
      }

      const parsedError = parsed.error;
      if (parsedError && typeof parsedError === "object" && !Array.isArray(parsedError)) {
        const errorRecord = parsedError as Record<string, unknown>;
        if (typeof errorRecord.type === "string") {
          errorType = errorRecord.type;
        }
        if (typeof errorRecord.message === "string") {
          message = errorRecord.message;
        }
      }
    } catch {
      // Keep fallback values for non-JSON payloads.
    }
  }

  if (!requestId) {
    requestId = trimmed.match(/\b(req_[A-Za-z0-9]+)\b/)?.[1];
  }
  if (!message) {
    message = statusCode === 500 ? "Internal server error" : "API request failed";
  }

  return { statusCode, message, errorType, requestId };
}

function ApiErrorCard({ error, compact = false }: { error: ParsedApiError; compact?: boolean }) {
  const isServerError = error.statusCode >= 500;

  return (
    <div className={`rounded-lg border ${isServerError ? "border-sol-red/40 bg-sol-red/10" : "border-amber-500/30 bg-amber-500/10"} ${compact ? "px-2.5 py-2" : "px-3 py-2.5"}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-semibold ${isServerError ? "bg-sol-red/20 text-sol-red" : "bg-amber-500/20 text-amber-500"}`}>
          !
        </span>
        <span className={`text-xs font-semibold uppercase tracking-wide ${isServerError ? "text-sol-red" : "text-amber-500"}`}>
          API Error
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${isServerError ? "border-sol-red/40 bg-sol-red/10 text-sol-red" : "border-amber-500/40 bg-amber-500/10 text-amber-500"}`}>
          {error.statusCode}
        </span>
        {error.errorType && (
          <span className="text-[10px] px-1.5 py-0.5 rounded border border-sol-border/40 bg-sol-bg-alt/50 text-sol-text-dim font-mono">
            {error.errorType}
          </span>
        )}
      </div>
      <p className={`mt-1 text-sm ${isServerError ? "text-sol-red" : "text-amber-500"}`}>
        {error.message}
      </p>
      {error.requestId && (
        <p className="mt-1 text-[11px] text-sol-text-muted font-mono">
          request_id: <span className="text-sol-text-secondary">{error.requestId}</span>
        </p>
      )}
      {!compact && (
        <p className="mt-1 text-xs text-sol-text-dim">
          Provider-side failure. Retry the request; if it repeats, include the request ID.
        </p>
      )}
    </div>
  );
}

function truncateStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function summarizeBashCommand(cmd: string): string {
  let c = cmd.replace(/^cd\s+\S+\s*[;&]+\s*/, '');
  c = c.replace(/\/Users\/\w+\//g, '~/');
  c = c.replace(/\/home\/\w+\//g, '~/');
  const rgMatch = c.match(/^(rg|grep|ripgrep)\s+([\s\S]*)$/);
  if (rgMatch) {
    const args = rgMatch[2];
    const patternMatch = args.match(/(?:^|\s)(?:-e\s+)?['"]([^'"]+)['"]/);
    const bareMatch = patternMatch ? null : args.match(/(?:^|\s)(?:-[a-zA-Z]+\s+)*([^\s-]\S*)/);
    const pattern = patternMatch?.[1] || bareMatch?.[1] || "";
    if (pattern) return `rg "${pattern.length > 40 ? pattern.slice(0, 40) + "..." : pattern}"`;
  }
  const sedMatch = c.match(/^sed\s+.*?\s+(\S+)\s*$/);
  if (sedMatch) {
    const file = sedMatch[1].split('/').pop() || sedMatch[1];
    return `sed ${file}`;
  }
  if (c.startsWith('git ')) {
    const parts = c.split(/\s+/);
    const meaningful = parts.filter(p => !p.startsWith('-') || p === '--staged' || p === '--cached' || p === '--stat' || p === '--short').slice(0, 4);
    return meaningful.join(' ');
  }
  return c.length > 80 ? c.slice(0, 80) + '...' : c;
}

function unwrapShellCommand(cmd: string): string {
  const m = cmd.match(/^(?:\/bin\/)?(?:ba)?sh\s+-\S+\s+'([^']*)'\s*$/) ||
            cmd.match(/^(?:\/bin\/)?(?:ba)?sh\s+-\S+\s+"([^"]*)"\s*$/) ||
            cmd.match(/^(?:\/bin\/)?(?:ba)?sh\s+-\S+\s+(\S+)\s*$/);
  return m ? m[1] : cmd;
}

function parseCastCommand(tool: ToolCall): { category: string; subcommand: string; args: string; fullCmd: string } | null {
  const isBash = tool.name === "Bash" || tool.name === "shell_command" || tool.name === "shell" || tool.name === "exec_command" || tool.name === "container.exec" || tool.name === "commandExecution";
  if (!isBash) return null;
  try {
    const input = JSON.parse(tool.input);
    const cmd = unwrapShellCommand(String(input.command || input.cmd || "").trim());
    const match = cmd.match(/^cast\s+(\w[\w-]*)(?:\s+(\w[\w-]*))?(?:\s+([\s\S]*))?$/);
    if (!match) return null;
    return { category: match[1], subcommand: match[2] || "", args: (match[3] || "").trim(), fullCmd: cmd };
  } catch { return null; }
}

function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname;
    if (path === "/" || path === "") return host;
    return host + (path.length > 25 ? path.slice(0, 22) + "..." : path);
  } catch {
    return truncateStr(url, 40);
  }
}

function hasRichMarkdown(text: string): boolean {
  if (/\b(ct|pl)-[a-z0-9]+\b/i.test(text)) return true;
  const markers = [
    /^#{1,3}\s+\S/m,           // headers
    /\|.+\|.+\|/,              // tables
    /^```\w*/m,                 // fenced code blocks
    /^\d+\.\s+\*\*[^*]+\*\*/m, // numbered list with bold
    /^-\s+\[[ x]\]/im,         // task lists
  ];
  let hits = 0;
  for (const m of markers) {
    if (m.test(text)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

const PLAN_PREFIXES = [
  /^implement\s+the\s+following\s+plan\s*:\s*/i,
  /^implement\s+this\s+plan\s*:\s*/i,
  /^here(?:'s| is)\s+the\s+plan\s*:\s*/i,
  /^plan\s*:\s*\n/i,
];

function extractPlanContent(text: string): string | null {
  const trimmed = text.trim();
  for (const prefix of PLAN_PREFIXES) {
    const match = trimmed.match(prefix);
    if (match) {
      const rest = trimmed.slice(match[0].length).trim();
      if (rest.length > 200 && hasRichMarkdown(rest)) {
        return rest;
      }
    }
  }
  return null;
}

type UserMessageKind =
  | { kind: 'normal' }
  | { kind: 'command' }
  | { kind: 'interrupt'; tone: 'sky' | 'amber' }
  | { kind: 'skill_expansion'; cmdName?: string }
  | { kind: 'task_notification' }
  | { kind: 'task_prompt' }
  | { kind: 'compaction_prompt' }
  | { kind: 'compaction_summary' }
  | { kind: 'plan'; planContent: string }
  | { kind: 'noise' }
  | { kind: 'tool_results_only' }
  | { kind: 'empty' }
  | { kind: 'teammate_events' }
  | { kind: 'continuation' }
  | { kind: 'poll_response' }
  | { kind: 'scheduled_task' };

const STICKY_NOISE_PREFIXES = ["[Request interrupted", "<task-notification>", "Your task is to create a detailed summary", "Full transcript available at:"];

function classifyUserMessage(
  msg: Message,
  agentType?: string,
  immediatePrev?: Message | null,
  contextPrev?: Message | null,
): UserMessageKind {
  const hasUserImages = msg.images?.some(img => !img.tool_use_id);
  if (msg.tool_results && msg.tool_results.length > 0 && (!msg.content || !msg.content.trim()) && !hasUserImages) {
    return { kind: 'tool_results_only' };
  }
  const content = msg.content;
  if (!content || !content.trim()) {
    return hasUserImages ? { kind: 'normal' } : { kind: 'empty' };
  }
  const t = content.trim();
  if (t.startsWith('<scheduled-task')) return { kind: 'scheduled_task' };
  if (t.startsWith('{') && t.includes('__cc_poll')) {
    try { if (JSON.parse(t).__cc_poll) return { kind: 'poll_response' }; } catch {}
  }
  if (immediatePrev?.role === 'assistant' && immediatePrev?.tool_calls?.some(tc => tc.name === 'AskUserQuestion')) {
    return { kind: 'poll_response' };
  }
  if (!stripSystemTags(t).trim()) return { kind: 'noise' };
  if (isCommandMessage(t)) {
    if (isSkillExpansion(t)) {
      const cmdMatch = t.match(/<command-(?:name|message)>([^<]*)<\/command-(?:name|message)>/);
      return { kind: 'skill_expansion', cmdName: cmdMatch?.[1]?.replace(/^\//, "") };
    }
    if (immediatePrev?.role === 'user' && immediatePrev?.content && isCommandMessage(immediatePrev.content)) {
      const cmdMatch = t.match(/<command-(?:name|message)>([^<]*)<\/command-(?:name|message)>/) ||
                       immediatePrev.content.match(/<command-(?:name|message)>([^<]*)<\/command-(?:name|message)>/);
      return { kind: 'skill_expansion', cmdName: cmdMatch?.[1]?.replace(/^\//, "") };
    }
    // Hide /compact commands — the compact_boundary system message handles the visual separator
    const cmdName = t.match(/<command-(?:name|message)>\/?compact<\/command-(?:name|message)>/);
    if (cmdName || t === '/compact') return { kind: 'compaction_prompt' };
    return { kind: 'command' };
  }
  if (agentType === "codex" && isCodexTurnAbortedMessage(t)) return { kind: 'interrupt', tone: 'amber' };
  if (isInterruptMessage(t)) return { kind: 'interrupt', tone: 'sky' };
  if (isSkillExpansion(t)) return { kind: 'skill_expansion' };
  if (isTaskNotification(t)) {
    const stripped = t.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '').trim();
    if (!stripped || stripped.length < 4 || stripped.startsWith('Read the output file to retrieve the result:') || stripped.startsWith('Full transcript available at:')) return { kind: 'task_notification' };
  }
  if (immediatePrev?.role === 'assistant' && immediatePrev?.tool_calls?.some(tc => tc.name === 'Task' || tc.name === 'Agent')) {
    // Only hide if the message is auto-generated (no human-visible text after stripping system tags).
    // Genuine user messages typed while an agent is running must render normally.
    const stripped = stripSystemTags(t).trim();
    if (!stripped) return { kind: 'task_prompt' };
  }
  if (isCompactionPromptMessage(t)) return { kind: 'compaction_prompt' };
  if (t.startsWith('Read the output file to retrieve the result:') || t.startsWith('Full transcript available at:')) return { kind: 'noise' };
  if (immediatePrev?.role === 'user' && immediatePrev?.content && isCommandMessage(immediatePrev.content) && t.length > 200) {
    const cmdMatch = immediatePrev.content.match(/<command-(?:name|message)>([^<]*)<\/command-(?:name|message)>/);
    return { kind: 'skill_expansion', cmdName: cmdMatch?.[1]?.replace(/^\//, "") };
  }
  if (contextPrev?.role === 'system' && contextPrev?.subtype === 'compact_boundary') {
    const stripped = stripSystemTags(t).trim();
    if (!stripped) return { kind: 'noise' };
    return { kind: 'compaction_summary' };
  }
  if (t.includes('<teammate-message') && !t.replace(/<teammate-message\s+[^>]*>[\s\S]*?<\/teammate-message>/g, '').replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '').trim()) {
    return { kind: 'teammate_events' };
  }
  const planContent = extractPlanContent(t);
  if (planContent) return { kind: 'plan', planContent };
  const displayable = t
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/<teammate-message\s+[^>]*>[\s\S]*?<\/teammate-message>/g, '')
    .replace(/\[Image[:\s][^\]]*\]/gi, '')
    .replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, '')
    .trim();
  if (!displayable) {
    if (!immediatePrev && !contextPrev) return { kind: 'normal' };
    return hasUserImages ? { kind: 'normal' } : { kind: 'noise' };
  }
  if (displayable.startsWith("This session is being continued") || displayable.startsWith("Please continue the conversation")) {
    return { kind: 'continuation' };
  }
  if (STICKY_NOISE_PREFIXES.some(p => displayable.startsWith(p))) {
    return { kind: 'noise' };
  }
  return { kind: 'normal' };
}

function isStickyWorthy(kind: UserMessageKind): boolean {
  return kind.kind === 'normal' || kind.kind === 'plan';
}

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatFullTimestamp(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function stripLineNumbers(content: string): string {
  // Strip Claude Code's line number format: "   42→content" or "42→content"
  return content
    .split("\n")
    .map((line) => line.replace(/^\s*\d+→/, ""))
    .join("\n");
}

function ClaudeIcon() {
  return (
    <span className="w-6 h-6 rounded bg-sol-orange flex items-center justify-center shrink-0">
      <svg className="w-3.5 h-3.5 text-sol-bg" viewBox="0 0 24 24" fill="currentColor">
        <path d="M17.3041 3.541h-3.6718l6.696 16.918H24L17.3041 3.541Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409H6.696Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456H6.3247Z" />
      </svg>
    </span>
  );
}

function CodexIcon() {
  return (
    <div className="w-6 h-6 rounded bg-[#0f0f0f] flex items-center justify-center shrink-0">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729z" fill="white"/>
      </svg>
    </div>
  );
}

function CursorIcon() {
  return (
    <div className="w-6 h-6 rounded bg-[#1a1a2e] flex items-center justify-center shrink-0">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" xmlns="http://www.w3.org/2000/svg">
        <path d="M4 4l16 6-8 2-2 8z"/>
      </svg>
    </div>
  );
}

function GeminiIcon() {
  return (
    <div className="w-6 h-6 rounded bg-[#1a73e8] flex items-center justify-center shrink-0">
      <svg width="14" height="14" viewBox="0 0 28 28" fill="white" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 0C12 0 12 6.268 8.134 10.134C4.268 14 0 14 0 14C0 14 6.268 14 10.134 17.866C14 21.732 14 28 14 28C14 28 14 21.732 17.866 17.866C21.732 14 28 14 28 14C28 14 21.732 14 17.866 10.134C14 6.268 14 0 14 0" />
      </svg>
    </div>
  );
}

function AssistantIcon({ agentType }: { agentType?: string }) {
  if (agentType === "codex") return <CodexIcon />;
  if (agentType === "cursor") return <CursorIcon />;
  if (agentType === "gemini") return <GeminiIcon />;
  return <ClaudeIcon />;
}

function assistantLabel(agentType?: string): string {
  if (agentType === "codex") return "Codex";
  if (agentType === "cursor") return "Cursor";
  if (agentType === "gemini") return "Gemini";
  return "Claude";
}


function formatModel(model?: string): string {
  if (!model) return "";
  // Shorten long model names
  if (model.includes("claude-sonnet")) {
    return model.replace("claude-sonnet-", "sonnet-").replace("-20", "-'");
  }
  if (model.includes("claude-opus")) {
    return model.replace("claude-opus-", "opus-").replace("-20", "-'");
  }
  if (model.includes("claude-haiku")) {
    return model.replace("claude-haiku-", "haiku-").replace("-20", "-'");
  }
  return model;
}

function ConversationMetadata({
  agentType,
  model,
  startedAt,
  messageCount,
  shortId,
  conversationId,
}: {
  agentType?: string;
  model?: string;
  startedAt?: number;
  messageCount?: number;
  shortId?: string;
  conversationId?: string;
}) {
  if (!agentType && !model && !startedAt && !messageCount) return null;

  return (
    <div className="flex items-center gap-1 text-[10px] sm:text-xs text-sol-text-dim min-w-0 overflow-hidden">
      {agentType && (
        <div
          className="flex items-center flex-shrink-0 cursor-default"
          title={formatAgentType(agentType)}
        >
          <AgentTypeIcon agentType={agentType} />
        </div>
      )}
      {model && (
        <div className="hidden sm:flex items-center gap-1.5 flex-shrink-0">
          <span className="text-sol-text-dim">&middot;</span>
          <span className="font-mono truncate max-w-none" title={model}>{formatModel(model)}</span>
        </div>
      )}
      {startedAt && (
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="text-sol-text-dim">&middot;</span>
          <span title={formatFullTimestamp(startedAt)}>{formatRelativeTime(startedAt)}</span>
        </div>
      )}
      {messageCount !== undefined && messageCount > 0 && (
        <button
          className="hidden sm:flex items-center gap-1.5 flex-shrink-0 hover:text-sol-text-muted transition-colors cursor-pointer"
          title="Copy conversation ID"
          onClick={() => { if (conversationId) setTimeout(() => { copyToClipboard(conversationId).then(() => toast.success("ID copied")); }); }}
        >
          <span className="text-sol-text-dim">&middot;</span>
          <span>{messageCount} {messageCount === 1 ? "msg" : "msgs"}</span>
        </button>
      )}
      {startedAt && (
        <div className="hidden sm:flex items-center gap-1.5 flex-shrink-0">
          <span className="text-sol-text-dim">&middot;</span>
          <span>{formatDuration(startedAt)}</span>
        </div>
      )}
    </div>
  );
}

const INLINE_TASK_STATUS: Record<string, { icon: typeof Circle; color: string }> = {
  open: { icon: Circle, color: "text-sol-blue" },
  in_progress: { icon: CircleDot, color: "text-sol-yellow" },
  done: { icon: CheckCircle2, color: "text-sol-green" },
};

function TaskProgressRow({ taskStats }: { taskStats: { total: number; done: number; in_progress: number; open: number; items: { id: string; content: string; status: string }[] } }) {
  const [expanded, setExpanded] = useState(false);
  const { total, done, in_progress } = taskStats;
  const donePct = (done / total) * 100;
  const ipPct = (in_progress / total) * 100;
  const isComplete = done === total;

  return (
    <div className="mt-0.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-1 py-0.5 rounded hover:bg-sol-bg-alt/60 transition-colors group cursor-pointer"
      >
        {expanded ? <ChevronDown className="w-3 h-3 text-sol-text-dim flex-shrink-0" /> : <ChevronRight className="w-3 h-3 text-sol-text-dim flex-shrink-0" />}
        {isComplete ? (
          <CheckCircle2 className="w-3 h-3 text-sol-green flex-shrink-0" />
        ) : in_progress > 0 ? (
          <CircleDot className="w-3 h-3 text-sol-yellow animate-pulse flex-shrink-0" />
        ) : (
          <Circle className="w-3 h-3 text-sol-text-dim flex-shrink-0" />
        )}
        <div className="flex-1 h-1.5 bg-sol-border/30 rounded-full overflow-hidden min-w-[60px] max-w-[120px]">
          <div className="h-full flex">
            <div
              className={`h-full ${isComplete ? "bg-sol-green" : "bg-sol-green/80"}`}
              style={{ width: `${donePct}%` }}
            />
            {ipPct > 0 && (
              <div className="h-full bg-sol-yellow/60" style={{ width: `${ipPct}%` }} />
            )}
          </div>
        </div>
        <span className={`text-[10px] tabular-nums flex-shrink-0 ${isComplete ? "text-sol-green" : "text-sol-text-dim"}`}>
          {done}/{total} tasks
        </span>
      </button>
      {expanded && (
        <div className="ml-4 mt-0.5 border-l border-sol-border/20 pl-2">
          {taskStats.items.map((item) => {
            const cfg = INLINE_TASK_STATUS[item.status] || INLINE_TASK_STATUS.open;
            const Icon = cfg.icon;
            return (
              <div key={item.id} className="flex items-center gap-1.5 py-0.5">
                <Icon className={`w-3 h-3 flex-shrink-0 ${cfg.color}`} />
                <span className={`text-[11px] truncate ${item.status === "done" ? "text-sol-text-dim line-through" : "text-sol-text-muted"}`}>
                  {item.content}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function truncateLines(text: string, maxLines: number): { text: string; truncated: boolean; totalLines: number } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return { text, truncated: false, totalLines: lines.length };
  }
  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true,
    totalLines: lines.length,
  };
}


function findMatchingChild(
  prompt: string,
  childConversations?: Array<{ _id: string; title: string; is_subagent?: boolean; first_message_preview?: string }>,
): string | undefined {
  if (!childConversations || !prompt) return undefined;
  const subagents = childConversations.filter(c => c.is_subagent && c.first_message_preview);
  if (subagents.length === 0) return undefined;

  const promptStart = prompt.slice(0, 100).toLowerCase().trim();

  for (const child of subagents) {
    const preview = child.first_message_preview!.slice(0, 100).toLowerCase().trim();
    if (promptStart === preview || promptStart.startsWith(preview) || preview.startsWith(promptStart)) {
      return child._id;
    }
  }
  return undefined;
}

function parseSpawnResult(content: string): { agentName?: string; teamName?: string; agentId?: string } | null {
  if (!content.startsWith("Spawned successfully")) return null;
  const lines = content.split("\n");
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) fields[m[1]] = m[2].trim();
  }
  return { agentName: fields.name, teamName: fields.team_name, agentId: fields.agent_id };
}

function TaskToolBlock({ tool, result, childConversationId, childConversations }: { tool: ToolCall; result?: ToolResult; childConversationId?: string; childConversations?: Array<{ _id: string; title: string; is_subagent?: boolean; first_message_preview?: string }> }) {
  const isCompleted = !!result;
  const [expanded, setExpanded] = useState(false);

  let parsedInput: Record<string, unknown> = {};
  try {
    parsedInput = JSON.parse(tool.input);
  } catch {}

  const subagentType = String(parsedInput.subagent_type || "unknown");
  const description = String(parsedInput.description || "");
  const prompt = String(parsedInput.prompt || "");
  const model = parsedInput.model ? String(parsedInput.model) : null;
  const name = parsedInput.name ? String(parsedInput.name) : null;
  const runInBackground = Boolean(parsedInput.run_in_background);

  const resolvedChildId = childConversationId || findMatchingChild(prompt, childConversations);
  const router = useRouter();

  const subagentColors: Record<string, { bg: string; border: string; text: string }> = {
    Explore: { bg: "bg-sol-green/20", border: "border-sol-green/50", text: "text-sol-green" },
    Plan: { bg: "bg-sol-cyan/20", border: "border-sol-cyan/50", text: "text-sol-cyan" },
    implementor: { bg: "bg-sol-yellow/20", border: "border-sol-yellow/50", text: "text-sol-yellow" },
    "general-purpose": { bg: "bg-sol-bg-alt/60", border: "border-sol-border/50", text: "text-sol-text-secondary" },
    "claude-code-guide": { bg: "bg-sol-violet/20", border: "border-sol-violet/50", text: "text-sol-violet" },
    "code-reviewer": { bg: "bg-sol-red/20", border: "border-sol-red/50", text: "text-sol-red" },
    "code-explorer": { bg: "bg-sol-cyan/20", border: "border-sol-cyan/50", text: "text-sol-cyan" },
    "code-architect": { bg: "bg-sol-magenta/20", border: "border-sol-magenta/50", text: "text-sol-magenta" },
    "code-simplifier": { bg: "bg-sol-cyan/20", border: "border-sol-cyan/50", text: "text-sol-cyan" },
  };

  const colors = subagentColors[subagentType] || { bg: "bg-sol-bg-alt/60", border: "border-sol-border/50", text: "text-sol-text-muted" };

  const spawnInfo = result?.content ? parseSpawnResult(result.content) : null;

  const resultSummary = result?.content && !spawnInfo
    ? result.content.length > 200 ? result.content.slice(0, 200) + "..." : result.content
    : null;

  if (isCompleted && spawnInfo) {
    return (
      <div className="my-0.5">
        <div
          className={`flex items-center gap-1.5 text-xs${resolvedChildId ? " cursor-pointer rounded px-1.5 py-1 -mx-1 hover:bg-sol-bg-highlight/50 transition-colors" : ""}`}
          onClick={resolvedChildId ? () => router.push(`/conversation/${resolvedChildId}`) : undefined}
        >
          <span className="text-emerald-400 text-[10px]">{"\u2713"}</span>
          <span className={`font-mono text-xs ${colors.text}`}>Task</span>
          <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${colors.bg} border ${colors.border} ${colors.text}`}>
            {subagentType}
          </span>
          {(spawnInfo.agentName || name) && (
            <span className="text-[10px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 font-mono">
              @{spawnInfo.agentName || name}
            </span>
          )}
          {description && <span className="text-sol-text-dim truncate flex-1">{description}</span>}
        </div>
      </div>
    );
  }

  if (isCompleted) {
    return (
      <div className={`my-3 rounded-lg ${result?.is_error ? "bg-sol-red/10 border-sol-red/30" : `${colors.bg} ${colors.border}`} border`}>
        <div
          className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-sol-bg-highlight/50 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <span className={`text-[10px] ${result?.is_error ? "text-sol-red" : "text-emerald-400"}`}>
            {result?.is_error ? "\u2717" : "\u2713"}
          </span>
          <span className={`font-mono text-xs font-medium ${result?.is_error ? "text-sol-red" : colors.text}`}>
            Task
          </span>
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${colors.bg} border ${colors.border} ${colors.text}`}>
            {subagentType}
          </span>
          {description && (
            <span className="text-sol-text-muted text-xs truncate flex-1">
              {description}
            </span>
          )}
          <span className="text-sol-text-dim text-[10px] ml-auto">
            {expanded ? "collapse" : "expand"}
          </span>
        </div>

        {expanded && (
          <>
            {prompt && (
              <div className="border-t border-sol-border/30 px-3 py-2">
                <div className="text-[10px] text-sol-text-dim mb-1">Prompt</div>
                <div className="text-sol-text-dim text-xs font-mono whitespace-pre-wrap break-words leading-relaxed max-h-40 overflow-y-auto">
                  {prompt}
                </div>
              </div>
            )}
            {result && (
              <div className="border-t border-sol-border/30 px-3 py-2">
                <div className="text-[10px] text-sol-text-dim mb-1">Result</div>
                <div className={`text-xs max-h-96 overflow-y-auto ${
                  result.is_error ? "text-sol-red font-mono whitespace-pre-wrap" : "text-sol-text-secondary prose prose-sm prose-invert max-w-none [&_pre]:bg-sol-bg/50 [&_pre]:border [&_pre]:border-sol-border/30 [&_pre]:rounded [&_pre]:text-[11px] [&_code]:text-[11px] [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_h1]:mt-2 [&_h2]:mt-2 [&_h3]:mt-1"
                }`}>
                  {result.is_error ? safeString(result.content) : (
                    <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={[rehypeHighlight]} components={{ code: EntityAwareCode, a: EntityAwareLink }}>
                      {safeString(result.content)}
                    </ReactMarkdown>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {resolvedChildId && (
          <div className="border-t border-sol-border/30 px-2 py-1.5 flex justify-end">
            <span
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium cursor-pointer hover:brightness-125 transition ${colors.text} ${colors.bg} border ${colors.border}`}
              onClick={(e) => { e.stopPropagation(); router.push(`/conversation/${resolvedChildId}`); }}
            >
              open
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </span>
          </div>
        )}
      </div>
    );
  }

  const truncatedPrompt = prompt.length > 300 && !expanded ? prompt.slice(0, 300) + "..." : prompt;

  return (
    <div className={`my-3 rounded-lg ${colors.bg} border ${colors.border}`}>
      <div
        className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-sol-bg-highlight/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`w-2.5 h-2.5 rounded-full border border-current border-t-transparent animate-spin ${colors.text} opacity-60`} />
        <span className={`font-mono text-xs font-semibold ${colors.text}`}>
          Task
        </span>
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${colors.bg} border ${colors.border} ${colors.text}`}>
          {subagentType}
        </span>
        {description && (
          <span className="text-sol-text-muted text-xs truncate flex-1">
            {description}
          </span>
        )}
        {model && (
          <span className="text-sol-text-dim text-[10px] font-mono">
            {formatModel(model)}
          </span>
        )}
        {name && (
          <span className="text-sol-text-dim text-[10px] font-mono">
            {name}
          </span>
        )}
        {runInBackground && (
          <span className="text-sol-text-dim text-[10px]">background</span>
        )}
        <span className="text-sol-text-dim text-[10px] ml-auto">
          {expanded ? "collapse" : "expand"}
        </span>
      </div>

      <div className="px-3 pb-2">
        <div className="text-sol-text-secondary text-xs font-mono whitespace-pre-wrap break-words leading-relaxed">
          {truncatedPrompt}
        </div>
        {prompt.length > 300 && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="text-[10px] text-sol-text-dim hover:text-sol-text-muted mt-1"
          >
            show more
          </button>
        )}
      </div>

      {resolvedChildId && (
        <div className="border-t border-sol-border/30 px-2 py-1.5 flex justify-end">
          <span
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium cursor-pointer hover:brightness-125 transition ${colors.text} ${colors.bg} border ${colors.border}`}
            onClick={(e) => { e.stopPropagation(); router.push(`/conversation/${resolvedChildId}`); }}
          >
            open
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </span>
        </div>
      )}
    </div>
  );
}

function getFileExtension(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    cpp: "cpp", c: "c", h: "c", hpp: "cpp", cs: "csharp",
    json: "json", yaml: "yaml", yml: "yaml", md: "markdown",
    html: "html", css: "css", scss: "scss", sql: "sql",
    sh: "bash", bash: "bash", zsh: "bash", swift: "swift", kt: "kotlin",
  };
  return ext ? langMap[ext] : undefined;
}

function getRelativePath(fullPath: string): string {
  // Try to extract relative path from common patterns
  // /Users/*/src/project/path -> project/path
  // /home/*/projects/project/path -> project/path
  const patterns = [
    /\/Users\/[^/]+\/src\/(.+)$/,
    /\/Users\/[^/]+\/(.+)$/,
    /\/home\/[^/]+\/(?:src|projects|code)\/(.+)$/,
    /\/home\/[^/]+\/(.+)$/,
  ];
  for (const pattern of patterns) {
    const match = fullPath.match(pattern);
    if (match) return match[1];
  }
  // Fallback: show last 3 path components
  const parts = fullPath.split("/").filter(Boolean);
  return parts.slice(-3).join("/");
}

const mcpToolNames: Record<string, string> = {
  "mcp__claude-in-chrome__computer": "Browser",
  "mcp__claude-in-chrome__navigate": "Navigate",
  "mcp__claude-in-chrome__read_page": "Read Page",
  "mcp__claude-in-chrome__find": "Find",
  "mcp__claude-in-chrome__form_input": "Form",
  "mcp__claude-in-chrome__javascript_tool": "JS",
  "mcp__claude-in-chrome__tabs_context_mcp": "Tabs",
  "mcp__claude-in-chrome__tabs_create_mcp": "New Tab",
  "mcp__claude-in-chrome__update_plan": "Plan",
  "mcp__claude-in-chrome__gif_creator": "GIF",
  "mcp__claude-in-chrome__read_console_messages": "Console",
  "mcp__claude-in-chrome__read_network_requests": "Network",
  "mcp__claude-in-chrome__get_page_text": "Page Text",
  "mcp__claude-in-chrome__upload_image": "Upload",
  "mcp__claude-in-chrome__resize_window": "Resize",
  "mcp__claude-in-chrome__shortcuts_list": "Shortcuts",
  "mcp__claude-in-chrome__shortcuts_execute": "Shortcut",
};

const codexToolNames: Record<string, string> = {
  shell_command: "Terminal",
  shell: "Terminal",
  exec_command: "Terminal",
  "container.exec": "Terminal",
  commandExecution: "Terminal",
  apply_patch: "Patch",
  file_read: "Read",
  file_write: "Write",
  file_edit: "Edit",
  fileChange: "Patch",
  web_search: "Search",
  web_fetch: "Fetch",
  code_search: "Search",
  code_analysis: "Analyze",
};

function formatToolName(name: string): string {
  if (mcpToolNames[name]) return mcpToolNames[name];
  if (codexToolNames[name]) return codexToolNames[name];
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const method = parts[2] || parts[1] || "MCP";
    return method.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }
  return name.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function isPlanWriteToolCall(tc: ToolCall): boolean {
  if (tc.name !== "Write") return false;
  try {
    const parsed = JSON.parse(tc.input);
    return String(parsed.file_path || "").includes('.claude/plans/');
  } catch {
    return false;
  }
}

interface ToolChangeRange {
  start: number;
  end: number;
}

interface ToolCallChangeSelection {
  index: number;
  range: ToolChangeRange;
}

function ToolBlock({ tool, result, changeIndex, changeRange, shareSelectionMode, messageId, conversationId, onStartShareSelection, onOpenComments, collapsed, timestamp, images, globalImageMap }: { tool: ToolCall; result?: ToolResult; changeIndex?: number; changeRange?: ToolChangeRange; shareSelectionMode?: boolean; messageId?: string; conversationId?: Id<"conversations">; onStartShareSelection?: (messageId: string) => void; onOpenComments?: () => void; collapsed?: boolean; timestamp?: number; images?: ImageData[]; globalImageMap?: Record<string, ImageData> }) {
  const isApplyPatch = tool.name === "apply_patch";
  const isStandardEdit = tool.name === "Edit" || tool.name === "Write" || tool.name === "file_edit" || tool.name === "file_write";
  const isFileChange = tool.name === "fileChange";
  const isEdit = isStandardEdit || isApplyPatch || isFileChange;
  const [expanded, setExpanded] = useState(isEdit);
  const isRead = tool.name === "Read" || tool.name === "file_read";
  const isCodexShell = tool.name === "shell_command" || tool.name === "shell" || tool.name === "exec_command" || tool.name === "container.exec" || tool.name === "commandExecution";
  const isBash = tool.name === "Bash" || isCodexShell;
  const isGlob = tool.name === "Glob";
  const isGrep = tool.name === "Grep";
  const isCodeSearch = tool.name === "code_search" || tool.name === "code_analysis";

  const { selectedChangeIndex, rangeStart, rangeEnd, selectChange, selectRange } = useDiffViewerStore();

  let parsedInput: Record<string, unknown> = {};
  try {
    parsedInput = JSON.parse(tool.input);
  } catch {}
  const rawToolInput = tool.input || "";

  const filePath = String(parsedInput.file_path || "");
  const relativePath = getRelativePath(filePath);
  const language = getFileExtension(filePath);
  const applyPatchInput = tool.name === "apply_patch" ? getApplyPatchInput(rawToolInput) : "";
  const applyPatchDiffs = useMemo(
    () => (tool.name === "apply_patch" ? parseApplyPatchSections(applyPatchInput) : []),
    [tool.name, applyPatchInput],
  );
  const fileChangePaths = useMemo(
    () => (tool.name === "fileChange" ? parseFileChangeSummary(String(parsedInput.changes || "")) : []),
    [tool.name, parsedInput.changes],
  );
  const fileChangeDiffs = useMemo(
    () => (tool.name === "fileChange" ? parseUnifiedDiffSections(result?.content || "", fileChangePaths) : []),
    [tool.name, result?.content, fileChangePaths],
  );

  // Markdown file detection
  const isMarkdown = isMarkdownFile(filePath);
  const content = isRead ? (result?.content || "") : String(parsedInput.content || "");
  const isPlan = isMarkdown && isPlanFile(filePath, content);
  const isPlanWrite = tool.name === "Write" && filePath.includes('.claude/plans/');
  const [viewMode, setViewMode] = useState<'raw' | 'rendered'>(isMarkdown ? 'rendered' : 'raw');
  const [mdExpanded, setMdExpanded] = useState(false);
  const [mdFullscreen, setMdFullscreen] = useState(false);
  const [codeFullscreen, setCodeFullscreen] = useState(false);
  const mdContainerRef = useRef<HTMLDivElement>(null);
  const [mdOverflowing, setMdOverflowing] = useState(false);
  const MD_COLLAPSED_HEIGHT = 600;

  useWatchEffect(() => {
    if (mdContainerRef.current && !mdExpanded && viewMode === 'rendered') {
      requestAnimationFrame(() => {
        if (mdContainerRef.current) {
          setMdOverflowing(mdContainerRef.current.scrollHeight > MD_COLLAPSED_HEIGHT);
        }
      });
    }
  }, [content, mdExpanded, viewMode, expanded]);

  useWatchEffect(() => {
    if (!mdFullscreen) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMdFullscreen(false); };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = ''; };
  }, [mdFullscreen]);

  useWatchEffect(() => {
    if (!codeFullscreen) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCodeFullscreen(false); };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = ''; };
  }, [codeFullscreen]);

  const getToolSummary = () => {
    if (isStandardEdit || isRead) return relativePath;
    if (isBash) {
      const cmd = unwrapShellCommand(String(parsedInput.command || parsedInput.cmd || ""));
      if (cmd) return summarizeBashCommand(cmd);
    }
    if (isGlob && parsedInput.pattern) return String(parsedInput.pattern);
    if (isGrep && parsedInput.pattern) return String(parsedInput.pattern);
    if (isCodeSearch && parsedInput.query) return truncateStr(String(parsedInput.query), 40);

    if (tool.name === "apply_patch") {
      if (applyPatchDiffs.length > 0) {
        const firstPath = getRelativePath(applyPatchDiffs[0].filePath);
        return applyPatchDiffs.length > 1 ? `${firstPath} (+${applyPatchDiffs.length - 1})` : firstPath;
      }
      const fileMatch = applyPatchInput.match(/\*\*\* (?:Update|Add|Delete) File:\s+(.+)/);
      if (fileMatch) return getRelativePath(fileMatch[1].trim());
      return "Apply patch";
    }
    if (tool.name === "file_read" || tool.name === "file_write" || tool.name === "file_edit") {
      return getRelativePath(String(parsedInput.file_path || parsedInput.path || ""));
    }
    if (tool.name === "fileChange") {
      if (fileChangeDiffs.length > 0) {
        const firstPath = getRelativePath(fileChangeDiffs[0].filePath);
        return fileChangeDiffs.length > 1 ? `${firstPath} (+${fileChangeDiffs.length - 1})` : firstPath;
      }
      if (fileChangePaths.length > 0) {
        const rel = getRelativePath(fileChangePaths[0]);
        return fileChangePaths.length > 1 ? `${rel} (+${fileChangePaths.length - 1})` : rel;
      }
      return "File changes";
    }

    if (tool.name === "mcp__claude-in-chrome__computer") {
      const action = String(parsedInput.action || "");
      if (action === "screenshot") return "Screenshot";
      if (action === "left_click") {
        const coord = parsedInput.coordinate as number[] | undefined;
        return coord ? `Click (${coord[0]}, ${coord[1]})` : "Click";
      }
      if (action === "type") return `Type "${truncateStr(String(parsedInput.text || ""), 20)}"`;
      if (action === "key") return `Key: ${String(parsedInput.text || "")}`;
      if (action === "scroll") return `Scroll ${String(parsedInput.scroll_direction || "")}`;
      if (action === "wait") return `Wait ${String(parsedInput.duration || "")}s`;
      return action || "Browser";
    }
    if (tool.name === "mcp__claude-in-chrome__navigate") {
      const url = String(parsedInput.url || "");
      if (url === "back") return "Back";
      if (url === "forward") return "Forward";
      return url ? shortenUrl(url) : "Navigate";
    }
    if (tool.name === "mcp__claude-in-chrome__read_page") {
      if (parsedInput.ref_id) return `Element ${String(parsedInput.ref_id)}`;
      if (parsedInput.filter === "interactive") return "Interactive elements";
      return "Page content";
    }
    if (tool.name === "mcp__claude-in-chrome__find") {
      return parsedInput.query ? `"${truncateStr(String(parsedInput.query), 30)}"` : "Find";
    }
    if (tool.name === "mcp__claude-in-chrome__form_input") {
      const ref = parsedInput.ref ? String(parsedInput.ref) : "";
      const val = parsedInput.value;
      if (ref && val !== undefined) return `${ref} = "${truncateStr(String(val), 20)}"`;
      return "Set form";
    }
    if (tool.name === "mcp__claude-in-chrome__javascript_tool") {
      return parsedInput.text ? truncateStr(String(parsedInput.text), 40) : "Execute JS";
    }
    if (tool.name === "mcp__claude-in-chrome__tabs_context_mcp") return "Get tabs";
    if (tool.name === "mcp__claude-in-chrome__tabs_create_mcp") return "Create tab";
    if (tool.name === "mcp__claude-in-chrome__update_plan") {
      const domains = parsedInput.domains as string[] | undefined;
      if (Array.isArray(domains) && domains.length) {
        return domains.slice(0, 2).join(", ") + (domains.length > 2 ? "..." : "");
      }
      return "Plan";
    }
    if (tool.name === "mcp__claude-in-chrome__gif_creator") return String(parsedInput.action || "Record");
    if (tool.name === "mcp__claude-in-chrome__read_console_messages") {
      return parsedInput.pattern ? `Filter: ${String(parsedInput.pattern)}` : "Console";
    }
    if (tool.name === "mcp__claude-in-chrome__read_network_requests") {
      return parsedInput.urlPattern ? `Filter: ${String(parsedInput.urlPattern)}` : "Network";
    }
    if (tool.name === "mcp__claude-in-chrome__get_page_text") return "Extract text";
    if (tool.name === "mcp__claude-in-chrome__upload_image") return parsedInput.filename ? String(parsedInput.filename) : "Upload";
    if (tool.name === "mcp__claude-in-chrome__resize_window") return parsedInput.width && parsedInput.height ? `${parsedInput.width}x${parsedInput.height}` : "Resize";
    if (tool.name === "mcp__claude-in-chrome__shortcuts_list") return "List shortcuts";
    if (tool.name === "mcp__claude-in-chrome__shortcuts_execute") return parsedInput.command ? `/${String(parsedInput.command)}` : "Shortcut";

    if (tool.name === "TaskCreate") return parsedInput.subject ? truncateStr(String(parsedInput.subject), 50) : "New task";
    if (tool.name === "TaskUpdate") {
      const id = parsedInput.taskId ? `#${parsedInput.taskId}` : "";
      const status = parsedInput.status ? String(parsedInput.status) : "";
      if (id && status) return `${id} \u2192 ${status}`;
      return id || "Update task";
    }
    if (tool.name === "TaskList") {
      if (result) {
        const lines = result.content.split("\n").filter((l: string) => l.match(/#\d+\s+\[/));
        if (lines.length > 0) return `${lines.length} tasks`;
      }
      return "Tasks";
    }
    if (tool.name === "TaskGet") return parsedInput.taskId ? `#${parsedInput.taskId}` : "Get task";
    if (tool.name === "TeamCreate") return parsedInput.team_name ? String(parsedInput.team_name) : "New team";
    if (tool.name === "TeamDelete") return "Cleanup";
    if (tool.name === "SendMessage") {
      if (parsedInput.summary) return truncateStr(String(parsedInput.summary), 40);
      if (parsedInput.recipient) return `to ${String(parsedInput.recipient)}`;
      if (parsedInput.type === "broadcast") return "broadcast";
      return "Message";
    }

    if (tool.name === "WebSearch" || tool.name === "web_search") return parsedInput.query ? truncateStr(String(parsedInput.query), 40) : "Search";
    if (tool.name === "WebFetch" || tool.name === "web_fetch") return parsedInput.url ? shortenUrl(String(parsedInput.url)) : "Fetch";
    if (tool.name === "NotebookEdit") return parsedInput.notebook_path ? getRelativePath(String(parsedInput.notebook_path)) : "Notebook";
    if (tool.name === "Skill") return parsedInput.skill ? `/${String(parsedInput.skill)}` : "Skill";
    if (tool.name === "EnterPlanMode") return "Plan mode";
    if (tool.name === "ExitPlanMode") return "Exit plan";
    if (tool.name === "TaskOutput") return parsedInput.task_id ? `task ${String(parsedInput.task_id).slice(0, 8)}` : "Output";
    if (tool.name === "TaskStop") return parsedInput.task_id ? `stop ${String(parsedInput.task_id).slice(0, 8)}` : "Stop";
    if (tool.name === "TodoWrite") {
      const todos = parsedInput.todos as any[];
      return `${todos?.length || 0} tasks`;
    }
    if (tool.name === "AskUserQuestion") {
      const questions = parsedInput.questions as any[];
      return questions?.[0]?.question ? truncateStr(String(questions[0].question), 50) : "Question";
    }

    if (tool.name.startsWith("mcp__")) {
      const parts = tool.name.split("__");
      const method = parts[2] || "";
      const displayMethod = method.replace(/_/g, " ");
      if (parsedInput.url) return shortenUrl(String(parsedInput.url));
      if (parsedInput.query) return truncateStr(String(parsedInput.query), 30);
      return displayMethod || parts[1] || "MCP";
    }

    return null;
  };

  const getResultSummary = () => {
    if (!result) return null;
    if (result.is_error) return "(error)";
    if (isEdit) {
      const match = result.content.match(/with (\d+) additions? and (\d+) removals?/);
      if (match) return `(+${match[1]} -${match[2]})`;
      return result.content.includes("has been updated") ? "(ok)" : "";
    }
    if (isRead) {
      const lines = result.content.split("\n").length;
      return `(${lines} lines)`;
    }
    if (isGlob || isGrep || isCodeSearch) {
      const lines = result.content.trim().split("\n").filter(l => l.trim()).length;
      return `(${lines} matches)`;
    }
    if (isBash && result.content) {
      const lines = result.content.trim().split("\n").length;
      if (lines > 1) return `(${lines} lines)`;
    }
    if (tool.name === "TaskList") {
      const taskLines = result.content.split("\n").filter((l: string) => l.match(/#\d+\s+\[/));
      if (taskLines.length > 0) return `(${taskLines.length} tasks)`;
    }
    return null;
  };

  const summary = getToolSummary();
  const resultSummary = getResultSummary();

  const executedTabId = useMemo(() => {
    if (!tool.name.startsWith("mcp__claude-in-chrome__")) return null;
    const tabId = parsedInput.tabId;
    if (tabId != null) return String(tabId);
    if (result?.content) {
      const tabIdMatch = result.content.match(/Executed on tabId:\s*(\d+)/);
      if (tabIdMatch) return tabIdMatch[1];
    }
    return null;
  }, [parsedInput.tabId, result?.content, tool.name]);

  // Process result content - strip line numbers for Read tool, strip Tab Context from MCP chrome results
  const rawResultContent = result ? safeString(result.content) : "";
  const processedContent = result ? (isRead ? stripLineNumbers(rawResultContent) : tool.name.startsWith("mcp__claude-in-chrome__") ? rawResultContent.replace(/\n?\n?Tab Context:[\s\S]*$/, "").trim() : rawResultContent) : "";

  const isCodeTool = isBash || isEdit || isRead || isGlob || isGrep || isCodeSearch;
  const isMarkdownResult = result && !isCodeTool && typeof processedContent === 'string' && (
    processedContent.includes('###') || processedContent.includes('**') || processedContent.includes('```')
  );

  // Extract starting line number from Edit result (format: "   42→content")
  const getStartLine = () => {
    if (isRead) {
      const offset = parsedInput.offset;
      if (offset && typeof offset === 'number') return offset;
      if (result?.content) {
        const match = result.content.match(/^\s*(\d+)\t/m);
        if (match) return parseInt(match[1], 10);
      }
      return 1;
    }
    if (!isStandardEdit || !result) return 1;
    const match = result.content.match(/^\s*(\d+)→/m);
    return match ? parseInt(match[1], 10) : 1;
  };
  const startLine = getStartLine();

  const toolColors: Record<string, string> = {
    Edit: "text-sol-orange/80",
    Write: "text-sol-orange/80",
    Read: "text-sol-blue/80",
    Bash: "text-sol-green/80",
    Glob: "text-sol-violet/80",
    Grep: "text-sol-violet/80",
    Task: "text-sol-cyan/80",
    TaskCreate: "text-emerald-500/80",
    TaskUpdate: "text-emerald-500/80",
    TaskList: "text-emerald-500/80",
    TaskGet: "text-emerald-500/80",
    TaskOutput: "text-emerald-500/80",
    TaskStop: "text-emerald-500/80",
    AskUserQuestion: "text-sol-blue/80",
    TeamCreate: "text-sol-cyan/80",
    TeamDelete: "text-sol-cyan/80",
    SendMessage: "text-amber-500/80",
    TodoWrite: "text-sol-magenta/80",
    WebSearch: "text-sol-violet/80",
    WebFetch: "text-sol-cyan/80",
    NotebookEdit: "text-sol-orange/80",
    Skill: "text-sol-cyan/80",
    EnterPlanMode: "text-sol-violet/80",
    ExitPlanMode: "text-sol-violet/80",
    "mcp__claude-in-chrome__computer": "text-sol-orange/80",
    "mcp__claude-in-chrome__navigate": "text-sol-blue/80",
    "mcp__claude-in-chrome__read_page": "text-sol-blue/80",
    "mcp__claude-in-chrome__find": "text-sol-violet/80",
    "mcp__claude-in-chrome__form_input": "text-sol-orange/80",
    "mcp__claude-in-chrome__javascript_tool": "text-sol-orange/80",
    "mcp__claude-in-chrome__tabs_context_mcp": "text-sol-text-dim",
    "mcp__claude-in-chrome__tabs_create_mcp": "text-sol-text-dim",
    "mcp__claude-in-chrome__update_plan": "text-sol-cyan/80",
    "mcp__claude-in-chrome__gif_creator": "text-sol-magenta/80",
    "mcp__claude-in-chrome__read_console_messages": "text-sol-green/80",
    "mcp__claude-in-chrome__read_network_requests": "text-sol-green/80",
    "mcp__claude-in-chrome__get_page_text": "text-sol-blue/80",
    "mcp__claude-in-chrome__upload_image": "text-sol-blue/80",
    "mcp__claude-in-chrome__resize_window": "text-sol-text-dim",
    "mcp__claude-in-chrome__shortcuts_list": "text-sol-violet/80",
    "mcp__claude-in-chrome__shortcuts_execute": "text-sol-violet/80",
  };

  const codexToolColors: Record<string, string> = {
    shell_command: "text-sol-green/80",
    shell: "text-sol-green/80",
    exec_command: "text-sol-green/80",
    "container.exec": "text-sol-green/80",
    commandExecution: "text-sol-green/80",
    apply_patch: "text-sol-orange/80",
    file_read: "text-sol-blue/80",
    file_write: "text-sol-orange/80",
    file_edit: "text-sol-orange/80",
    fileChange: "text-sol-orange/80",
    web_search: "text-sol-violet/80",
    web_fetch: "text-sol-cyan/80",
    code_search: "text-sol-violet/80",
    code_analysis: "text-sol-violet/80",
  };

  const getMcpColor = (name: string) => {
    if (codexToolColors[name]) return codexToolColors[name];
    if (name.startsWith("mcp__")) return "text-sol-cyan/80";
    return "text-sol-text-dim";
  };

  const toolColor = toolColors[tool.name] || getMcpColor(tool.name);

  const targetStart = changeRange?.start ?? changeIndex;
  const targetEnd = changeRange?.end ?? changeIndex;
  const hasTargetRange = targetStart !== undefined && targetEnd !== undefined;
  const isClickable = isEdit && hasTargetRange;
  const isSelected = isClickable && (
    (selectedChangeIndex !== null &&
      targetStart !== undefined &&
      targetEnd !== undefined &&
      selectedChangeIndex >= targetStart &&
      selectedChangeIndex <= targetEnd) ||
    (rangeStart !== null &&
      rangeEnd !== null &&
      targetStart !== undefined &&
      targetEnd !== undefined &&
      Math.max(rangeStart, targetStart) <= Math.min(rangeEnd, targetEnd))
  );

  const handleClick = (e: React.MouseEvent) => {
    if (shareSelectionMode) {
      return;
    }
    if (isClickable && targetStart !== undefined && targetEnd !== undefined) {
      e.stopPropagation();
      if (e.metaKey || e.ctrlKey) {
        if (selectedChangeIndex !== null) {
          selectRange(selectedChangeIndex, targetEnd);
        } else {
          selectRange(targetStart, targetEnd);
        }
      } else {
        if (targetStart !== targetEnd) {
          selectRange(targetStart, targetEnd);
        } else {
          selectChange(targetStart);
        }
      }
    } else {
      setExpanded(!expanded);
    }
  };

  if (isPlanWrite && content) {
    return <PlanBlock content={content} timestamp={timestamp || Date.now()} collapsed={collapsed} messageId={messageId} conversationId={conversationId} onOpenComments={onOpenComments} onStartShareSelection={onStartShareSelection} />;
  }

  const isCodecastImageRead = isRead && /codecast\/images\//.test(filePath);
  if (isCodecastImageRead) {
    return (
      <div className="my-0.5 flex items-center gap-1.5 text-xs">
        <svg className="w-3.5 h-3.5 text-sol-blue/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.64 0 8.577 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.64 0-8.577-3.007-9.963-7.178z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <span className="text-sol-text-dim italic">Viewing your image</span>
      </div>
    );
  }

  return (
    <div className="my-0.5">
      <div
        className={`flex items-center gap-1.5 group text-xs ${
          isClickable
            ? 'cursor-pointer hover:bg-sol-bg-highlight/30 rounded px-1 -mx-1 transition-colors'
            : 'cursor-pointer'
        } ${
          isSelected
            ? 'bg-sol-blue/10 border border-sol-blue/30 rounded px-1 -mx-1'
            : ''
        }`}
        onClick={handleClick}
      >
        <span className={`font-mono flex-shrink-0 group-hover:underline ${toolColor}`}>{formatToolName(tool.name)}</span>
        {summary && (
          <span className="text-sol-text-muted font-mono truncate min-w-0">{summary}</span>
        )}
        {executedTabId && (
          <a
            href={`https://clau.de/chrome/tab/${executedTabId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sol-cyan/70 hover:text-sol-cyan transition-colors flex-shrink-0 font-mono flex items-center gap-0.5"
            onClick={(e) => e.stopPropagation()}
            title={`View tab ${executedTabId}`}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            <span>open tab</span>
          </a>
        )}
        {resultSummary && (
          <span className={`font-mono flex-shrink-0 whitespace-nowrap ${result?.is_error ? "text-sol-red/80" : "text-sol-text-dim"}`}>
            {resultSummary}
          </span>
        )}
      </div>

      {(() => {
        const toolImage = images?.find(img => img.tool_use_id === tool.id) || globalImageMap?.[tool.id];
        return toolImage ? <ImageBlock image={toolImage} /> : null;
      })()}

      {expanded && (
        <div className="mt-1 rounded border border-sol-border/30 bg-sol-bg-alt">
          {/* Markdown toggle header */}
          {isMarkdown && (isRead || (tool.name === "Write" && Boolean(parsedInput.content))) && (
            <div className="flex items-center justify-between px-2 py-1 border-b border-sol-border/20 bg-sol-bg-highlight/30">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-sol-text-dim">{language}</span>
                {isPlan && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-sol-bg-highlight text-sol-text-muted font-medium">
                    PLAN
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 text-[10px]">
                <button
                  onClick={(e) => { e.stopPropagation(); setViewMode('raw'); }}
                  className={`px-1.5 py-0.5 rounded transition-colors ${
                    viewMode === 'raw'
                      ? 'bg-sol-bg-highlight text-sol-text'
                      : 'text-sol-text-dim hover:text-sol-text-muted'
                  }`}
                >
                  Raw
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setViewMode('rendered'); }}
                  className={`px-1.5 py-0.5 rounded transition-colors ${
                    viewMode === 'rendered'
                      ? 'bg-sol-bg-highlight text-sol-text'
                      : 'text-sol-text-dim hover:text-sol-text-muted'
                  }`}
                >
                  Rendered
                </button>
              </div>
            </div>
          )}
          {isEdit && !!parsedInput.old_string && !!parsedInput.new_string ? (
            <DiffView
              oldStr={String(parsedInput.old_string)}
              newStr={String(parsedInput.new_string)}
              startLine={startLine}
              language={language}
            />
          ) : tool.name === "Write" && !!parsedInput.content ? (
            isMarkdown && viewMode === 'rendered' ? (
              <>
                <div
                  ref={mdContainerRef}
                  className="relative p-3"
                  style={!mdExpanded && mdOverflowing ? { maxHeight: MD_COLLAPSED_HEIGHT, overflowY: 'hidden' } : undefined}
                >
                  <MarkdownRenderer content={String(parsedInput.content)} filePath={filePath} />
                  {!mdExpanded && mdOverflowing && (
                    <div className="absolute bottom-0 left-0 right-0 h-20 pointer-events-none bg-gradient-to-b from-transparent to-[var(--sol-bg)]" />
                  )}
                </div>
                <div className="flex items-center gap-3 px-3 pb-2">
                  {(mdOverflowing || mdExpanded) && (
                    <>
                      <button
                        onClick={(e) => { e.stopPropagation(); setMdExpanded(v => !v); }}
                        className="text-sm font-medium text-sol-cyan hover:text-sol-cyan/80 transition-colors"
                      >
                        {mdExpanded ? "Collapse" : "Expand"}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setMdFullscreen(true); }}
                        className="text-sm font-medium text-sol-cyan hover:text-sol-cyan/80 transition-colors"
                      >
                        Fullscreen
                      </button>
                    </>
                  )}
                  {onStartShareSelection && messageId && !shareSelectionMode && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onStartShareSelection(messageId); }}
                      className="text-xs font-medium text-sol-cyan hover:text-sol-cyan/80 transition-colors flex items-center gap-1"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                      </svg>
                      Share
                    </button>
                  )}
                </div>
                {mdFullscreen && createPortal(
                  <div className="fixed inset-0 z-[10001] bg-sol-bg overflow-auto" onClick={() => setMdFullscreen(false)}>
                    <div className="max-w-7xl mx-auto px-8 py-12" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-between mb-6">
                        <span className="text-sol-text-secondary text-sm font-medium">{filePath.split('/').pop()}</span>
                        <button
                          onClick={() => setMdFullscreen(false)}
                          className="text-sol-text-dim hover:text-sol-text-muted transition-colors p-1"
                          title="Close (Esc)"
                        >
                          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                      <MarkdownRenderer content={String(parsedInput.content)} filePath={filePath} />
                    </div>
                  </div>,
                  document.body
                )}
              </>
            ) : (
              <DiffView
                oldStr=""
                newStr={String(parsedInput.content)}
                startLine={1}
                language={language}
              />
            )
          ) : tool.name === "apply_patch" || tool.name === "fileChange" ? (
            (tool.name === "apply_patch" ? applyPatchDiffs : fileChangeDiffs).length > 0 ? (
              <div className="max-h-80 overflow-auto">
                {(tool.name === "apply_patch" ? applyPatchDiffs : fileChangeDiffs).map((diff, idx) => {
                  const diffLanguage = getFileExtension(diff.filePath);
                  const diffStartLine = diff.hunks[0]?.oldStart || diff.hunks[0]?.newStart || 1;
                  return (
                    <div key={`${diff.filePath}-${idx}`} className={idx > 0 ? "border-t border-sol-border/20" : ""}>
                      <div className="px-2 py-1 border-b border-sol-border/20 bg-sol-bg-highlight/20">
                        <span className="text-xs font-mono text-sol-text-dim truncate">{getRelativePath(diff.filePath)}</span>
                      </div>
                      <DiffView
                        oldStr={diff.oldContent}
                        newStr={diff.newContent}
                        startLine={diffStartLine}
                        language={diffLanguage}
                      />
                    </div>
                  );
                })}
              </div>
            ) : tool.name === "apply_patch" && applyPatchInput.trim() ? (
              <div className="max-h-80 overflow-auto">
                <pre className="p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap text-sol-text-secondary">
                  {applyPatchInput}
                </pre>
              </div>
            ) : tool.name === "fileChange" && processedContent && processedContent.trim() ? (
              <div className="max-h-80 overflow-auto">
                <pre className="p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap text-sol-text-secondary">
                  {processedContent}
                </pre>
              </div>
            ) : (
              <div className="p-2 text-xs text-sol-text-dim">
                {tool.name === "fileChange" ? "Patch diff unavailable" : "Patch input unavailable"}
              </div>
            )
          ) : isBash && (parsedInput.command || parsedInput.cmd) ? (
            <div className="max-h-80 overflow-auto">
              <div className="px-1.5 sm:px-2 py-1 sm:py-1.5 border-b border-sol-border/20 bg-sol-bg-highlight/30">
                <pre className="text-[11px] sm:text-xs font-mono text-sol-green whitespace-pre-wrap break-all">
                  $ {unwrapShellCommand(String(parsedInput.command || parsedInput.cmd || ""))}
                </pre>
              </div>
              {processedContent && processedContent.trim() ? (
                <pre className={`p-1.5 sm:p-2 text-[11px] sm:text-xs font-mono overflow-x-auto whitespace-pre-wrap ${result?.is_error ? "text-sol-red" : "text-sol-text-secondary"}`}>
                  {renderAnsi(processedContent)}
                </pre>
              ) : (
                <div className="p-2 text-xs text-sol-text-dim">No output</div>
              )}
            </div>
          ) : isRead && language && processedContent && processedContent.trim() ? (
            <>
              <DiffView
                oldStr={processedContent}
                newStr={processedContent}
                startLine={startLine}
                language={language}
              />
              <div className="flex items-center gap-3 px-3 py-1.5 border-t border-sol-border/20">
                <button
                  onClick={(e) => { e.stopPropagation(); setCodeFullscreen(true); }}
                  className="text-[11px] font-medium text-sol-cyan hover:text-sol-cyan/80 transition-colors"
                >
                  Fullscreen
                </button>
              </div>
              {codeFullscreen && createPortal(
                <div className="fixed inset-0 z-[10001] bg-sol-bg overflow-auto" onClick={() => setCodeFullscreen(false)}>
                  <div className="max-w-6xl mx-auto px-8 py-12" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center justify-between mb-4">
                      <span className="text-sol-text-secondary text-sm font-mono">{relativePath}</span>
                      <button
                        onClick={() => setCodeFullscreen(false)}
                        className="text-sol-text-dim hover:text-sol-text-muted transition-colors p-1"
                        title="Close (Esc)"
                      >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                    <div className="rounded border border-sol-border/30 bg-sol-bg-alt">
                      <DiffView
                        oldStr={processedContent}
                        newStr={processedContent}
                        startLine={startLine}
                        maxLines={99999}
                        language={language}
                      />
                    </div>
                  </div>
                </div>,
                document.body
              )}
            </>
          ) : processedContent && processedContent.trim() ? (
            <div className="max-h-80 overflow-auto">
              {isMarkdown && viewMode === 'rendered' ? (
                <div className="p-3">
                  <MarkdownRenderer content={processedContent} filePath={filePath} />
                </div>
              ) : isMarkdownResult ? (
                <div className="p-2 prose prose-invert prose-sm max-w-none text-xs">
                  <ReactMarkdown remarkPlugins={entityRemarkPlugins} components={{ code: EntityAwareCode, a: EntityAwareLink, img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} /> }}>{processedContent}</ReactMarkdown>
                </div>
              ) : (
                <>
                  {!isMarkdown && language && (
                    <div className="text-[10px] px-2 py-1 border-b border-sol-border/20 text-sol-text-dim">
                      {language}
                    </div>
                  )}
                  <pre className={`p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap ${result?.is_error ? "text-sol-red" : "text-sol-text-secondary"}`}>
                    {renderAnsi(processedContent)}
                  </pre>
                </>
              )}
            </div>
          ) : (
            <div className="p-2 text-xs text-sol-text-dim">No output</div>
          )}
        </div>
      )}
    </div>
  );
}

function TodoWriteBlock({ tool }: { tool: ToolCall }) {
  let parsedInput: { todos?: Array<{ content: string; status: string; activeForm?: string }> } = {};
  try {
    parsedInput = JSON.parse(tool.input);
  } catch {}

  const todos = parsedInput.todos || [];
  if (todos.length === 0) return null;

  const completed = todos.filter(t => t.status === 'completed').length;
  const inProgress = todos.filter(t => t.status === 'in_progress').length;

  return (
    <div className="my-2">
      <div className="flex items-center gap-2 py-0.5">
        <span className="w-1.5 h-1.5 rounded-full bg-pink-500 flex-shrink-0" />
        <span className="font-mono text-sm font-medium text-pink-600 dark:text-sol-magenta">
          TodoWrite
        </span>
        <span className="text-sol-text-dim text-sm font-mono">
          {completed}/{todos.length} done
          {inProgress > 0 && `, ${inProgress} in progress`}
        </span>
      </div>
      <div className="ml-3.5 mt-1 space-y-0.5">
        {todos.map((todo, i) => (
          <div key={i} className="flex items-start gap-2 text-sm">
            {todo.status === 'completed' ? (
              <svg className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : todo.status === 'in_progress' ? (
              <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            ) : (
              <svg className="w-4 h-4 text-sol-text-dim flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <circle cx="12" cy="12" r="9" strokeWidth={2} />
              </svg>
            )}
            <span className={`${
              todo.status === 'completed' ? 'text-sol-text-dim line-through' :
              todo.status === 'in_progress' ? 'text-sol-text-secondary' :
              'text-sol-text-muted'
            }`}>
              {todo.status === 'in_progress' ? (todo.activeForm || todo.content) : todo.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TaskListBlock({ tool, result, taskRecordMap }: { tool: ToolCall; result?: ToolResult; taskRecordMap?: TaskRecordMaps }) {
  const router = useRouter();
  if (!result) return null;
  const lines = result.content.split("\n");
  const items: Array<{ id: string; status: string; subject: string; owner?: string; blockedBy?: string[] }> = [];
  for (const line of lines) {
    const match = line.match(/#(\d+)\s+\[(\w+)]\s+(.+?)(?:\s+\(([^)]+)\))?(?:\s+\[blocked by ([^\]]+)])?$/);
    if (match) {
      items.push({
        id: match[1], status: match[2], subject: match[3].trim(),
        owner: match[4]?.trim(),
        blockedBy: match[5]?.split(",").map(s => s.trim().replace("#", "")),
      });
    }
  }
  if (items.length === 0) return null;

  const completed = items.filter(t => t.status === "completed").length;
  const inProgress = items.filter(t => t.status === "in_progress").length;

  return (
    <div className="my-2">
      <div className="flex items-center gap-2 py-0.5">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
        <span className="font-mono text-sm font-medium text-emerald-600 dark:text-emerald-400">TaskList</span>
        <span className="text-sol-text-dim text-sm font-mono">
          {completed}/{items.length} done{inProgress > 0 && `, ${inProgress} active`}
        </span>
      </div>
      <div className="ml-3.5 mt-1 space-y-0.5">
        {items.map(task => {
          const isBlocked = task.blockedBy && task.blockedBy.length > 0;
          const matched = taskRecordMap?.byTitle[task.subject] || taskRecordMap?.byLocalId[task.id];
          const clickable = !!matched;
          return (
            <div
              key={task.id}
              className={`flex items-start gap-2 text-sm ${isBlocked ? "opacity-50" : ""}${clickable ? " cursor-pointer rounded px-1.5 py-0.5 -mx-1 hover:bg-sol-bg-highlight/50 transition-colors" : ""}`}
              onClick={clickable ? () => router.push(`/tasks/${matched._id}`) : undefined}
            >
              {task.status === "completed" ? (
                <svg className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : task.status === "in_progress" ? (
                <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ) : isBlocked ? (
                <svg className="w-4 h-4 text-sol-text-dim flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              ) : (
                <svg className="w-4 h-4 text-sol-text-dim flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <circle cx="12" cy="12" r="9" strokeWidth={2} />
                </svg>
              )}
              <span className="text-sol-text-dim text-xs font-mono mt-0.5">#{task.id}</span>
              <span className={
                task.status === "completed" ? "text-sol-text-dim line-through" :
                task.status === "in_progress" ? "text-sol-text-secondary" :
                "text-sol-text-muted"
              }>
                {task.subject}
              </span>
              {task.owner && (
                <span className="text-[10px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/20 font-mono">
                  @{task.owner}
                </span>
              )}
              {isBlocked && (
                <span className="text-[10px] text-sol-text-dim mt-0.5">
                  blocked by {task.blockedBy!.map(id => `#${id}`).join(", ")}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type TaskRecord = { _id: string; short_id: string; title: string; status: string };
type TaskRecordMaps = { byTitle: Record<string, TaskRecord>; byLocalId: Record<string, TaskRecord> };

function TaskCreateUpdateBlock({ tool, result, taskSubjectMap, taskRecordMap }: { tool: ToolCall; result?: ToolResult; taskSubjectMap?: Record<string, string>; taskRecordMap?: TaskRecordMaps }) {
  let parsedInput: Record<string, any> = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}
  const router = useRouter();

  const isCreate = tool.name === "TaskCreate";
  const subject = parsedInput.subject;
  const taskId = parsedInput.taskId;
  const status = parsedInput.status;
  const owner = parsedInput.owner;
  const activeForm = parsedInput.activeForm;

  let resultId = "";
  if (result) {
    const idMatch = result.content.match(/Task #(\d+)/);
    if (idMatch) resultId = idMatch[1];
  }

  const resolvedSubject = subject || (taskId && taskSubjectMap?.[taskId]);
  const matchedTask = resolvedSubject
    ? taskRecordMap?.byTitle[String(resolvedSubject)]
    : taskId
    ? taskRecordMap?.byLocalId[String(taskId)]
    : undefined;
  const isClickable = !!matchedTask;

  const handleClick = () => {
    if (matchedTask) router.push(`/tasks/${matchedTask._id}`);
  };

  const displaySubject = resolvedSubject || matchedTask?.title;

  if (!isCreate && displaySubject) {
    return (
      <div className="my-0.5">
        <div
          className={`flex items-center gap-1.5 text-xs${isClickable ? " cursor-pointer rounded px-1.5 py-0.5 -mx-1 hover:bg-sol-bg-highlight/50 transition-colors" : ""}`}
          onClick={isClickable ? handleClick : undefined}
        >
          <span className="text-sol-text-muted">{String(displaySubject).slice(0, 60)}</span>
          {status && (
            <span className={`px-1 py-0.5 rounded text-[10px] font-mono ${
              status === "completed" ? "bg-emerald-500/15 text-emerald-400" :
              status === "in_progress" ? "bg-amber-500/15 text-amber-400" :
              status === "deleted" ? "bg-red-500/15 text-red-400" :
              "bg-gray-500/15 text-gray-400"
            }`}>
              {status}
            </span>
          )}
          {owner && <span className="text-[10px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/20 font-mono">@{owner}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="my-0.5">
      <div
        className={`flex items-center gap-1.5 text-xs${isClickable ? " cursor-pointer rounded px-1.5 py-0.5 -mx-1 hover:bg-sol-bg-highlight/50 transition-colors" : ""}`}
        onClick={isClickable ? handleClick : undefined}
      >
        <span className="font-mono text-emerald-500/80">{tool.name}</span>
        {isCreate ? (
          <>
            {resultId && <span className="text-sol-text-dim font-mono">#{resultId}</span>}
            {subject && <span className="text-sol-text-muted">{String(subject).slice(0, 60)}</span>}
            {activeForm && <span className="text-sol-text-dim italic">({activeForm})</span>}
          </>
        ) : (
          <>
            {taskId && <span className="text-sol-text-dim font-mono">#{taskId}</span>}
            {status && (
              <span className={`px-1 py-0.5 rounded text-[10px] font-mono ${
                status === "completed" ? "bg-emerald-500/15 text-emerald-400" :
                status === "in_progress" ? "bg-amber-500/15 text-amber-400" :
                status === "deleted" ? "bg-red-500/15 text-red-400" :
                "bg-gray-500/15 text-gray-400"
              }`}>
                {status}
              </span>
            )}
            {owner && <span className="text-[10px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/20 font-mono">@{owner}</span>}
          </>
        )}
      </div>
    </div>
  );
}

const CAST_STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  draft: { bg: "bg-gray-500/10", text: "text-gray-400" },
  open: { bg: "bg-sol-blue/10", text: "text-sol-blue" },
  backlog: { bg: "bg-gray-500/10", text: "text-gray-400" },
  in_progress: { bg: "bg-sol-yellow/10", text: "text-sol-yellow" },
  in_review: { bg: "bg-sol-violet/10", text: "text-sol-violet" },
  done: { bg: "bg-emerald-500/10", text: "text-emerald-400" },
  dropped: { bg: "bg-gray-500/10", text: "text-gray-400" },
  active: { bg: "bg-emerald-500/10", text: "text-emerald-400" },
  paused: { bg: "bg-gray-500/10", text: "text-gray-400" },
  abandoned: { bg: "bg-red-500/10", text: "text-red-400" },
};

function DocTitleLink({ convexId }: { convexId: string }) {
  const router = useRouter();
  const doc = useQuery(api.docs.webGet, { id: convexId });
  if (!doc) return <span className="text-sol-text-dim font-mono">{convexId.slice(0, 12)}...</span>;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); router.push(`/docs/${doc._id}`); }}
      className="text-sol-blue hover:underline truncate max-w-[250px] text-left"
    >
      {(doc as any).display_title || doc.title}
    </button>
  );
}

function CastEntityCard({ type, shortId, convexId }: { type: "task" | "plan" | "doc"; shortId?: string; convexId?: string }) {
  const router = useRouter();
  const task = useQuery(api.tasks.webGet, type === "task" && shortId ? { short_id: shortId } : "skip");
  const plan = useQuery(api.plans.webGet, type === "plan" && shortId ? { short_id: shortId } : "skip");
  const doc = useQuery(api.docs.webGet, type === "doc" && convexId ? { id: convexId } : "skip");
  const entity = type === "task" ? task : type === "plan" ? plan : doc;

  if (!entity) {
    if (shortId) return <EntityIdPill shortId={shortId} />;
    return null;
  }

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const route = type === "doc" ? `/docs/${entity._id}` : type === "plan" ? `/plans/${entity._id}` : `/tasks/${entity._id}`;
    router.push(route);
  };

  const status = entity.status || (type === "doc" ? null : "open");
  const sc = status ? (CAST_STATUS_COLORS[status] || CAST_STATUS_COLORS.open) : null;
  const age = Date.now() - (entity.updated_at || (entity as any)._creationTime || Date.now());
  const ageStr = age < 3600000 ? `${Math.max(1, Math.round(age / 60000))}m`
    : age < 86400000 ? `${Math.round(age / 3600000)}h`
    : `${Math.round(age / 86400000)}d`;

  const borderColor = type === "plan" ? "border-sol-cyan/20 bg-sol-cyan/5 hover:bg-sol-cyan/10"
    : type === "task" ? "border-sol-yellow/20 bg-sol-yellow/5 hover:bg-sol-yellow/10"
    : "border-sol-blue/20 bg-sol-blue/5 hover:bg-sol-blue/10";

  const DOC_TYPE_LABELS: Record<string, { label: string; color: string }> = {
    plan: { label: "Plan", color: "text-sol-cyan" },
    design: { label: "Design", color: "text-sol-violet" },
    spec: { label: "Spec", color: "text-sol-blue" },
    investigation: { label: "Investigation", color: "text-sol-orange" },
    handoff: { label: "Handoff", color: "text-sol-magenta" },
    note: { label: "Note", color: "text-sol-text-dim" },
  };

  const docPreview = type === "doc" && (entity as any).content
    ? (entity as any).content.replace(/^#[^\n]*\n*/m, "").replace(/\\n/g, " ").replace(/[#*_`>\[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 120)
    : "";

  return (
    <button onClick={handleClick} className={`mt-1 w-full max-w-md text-left rounded-lg border transition-colors cursor-pointer ${borderColor}`}>
      <div className="px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          {sc && (
            <span className={`px-1.5 py-0 rounded text-[10px] font-mono ${sc.bg} ${sc.text}`}>
              {status!.replace(/_/g, " ")}
            </span>
          )}
          {type === "doc" && (entity as any).doc_type && (
            <span className={`text-[10px] font-medium ${DOC_TYPE_LABELS[(entity as any).doc_type]?.color || "text-sol-text-dim"}`}>
              {DOC_TYPE_LABELS[(entity as any).doc_type]?.label || (entity as any).doc_type}
            </span>
          )}
          {shortId && <span className="text-[10px] font-mono text-sol-text-dim">{shortId}</span>}
          <span className="flex-1 text-sm text-sol-text truncate">
            {(entity as any).display_title || entity.title}
          </span>
          <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{ageStr}</span>
        </div>
        {type === "plan" && (entity as any).progress && (
          <div className="flex items-center gap-2 mt-1.5">
            <div className="flex-1 h-1 rounded-full bg-sol-bg-highlight overflow-hidden max-w-[200px]">
              <div
                className="h-full rounded-full bg-emerald-500/70 transition-all"
                style={{ width: `${(entity as any).progress.total > 0 ? Math.round(((entity as any).progress.done / (entity as any).progress.total) * 100) : 0}%` }}
              />
            </div>
            <span className="text-[10px] text-sol-text-dim font-mono">
              {(entity as any).progress.done}/{(entity as any).progress.total}
            </span>
          </div>
        )}
        {type === "task" && (
          <div className="flex items-center gap-1.5 mt-1">
            {(entity as any).priority && (entity as any).priority !== "medium" && (
              <span className={`text-[10px] px-1 py-0 rounded font-mono ${
                (entity as any).priority === "high" || (entity as any).priority === "critical"
                  ? "bg-red-500/10 text-red-400"
                  : "bg-gray-500/10 text-gray-400"
              }`}>{(entity as any).priority}</span>
            )}
            {(entity as any).labels?.map((l: string) => (
              <span key={l} className="text-[10px] px-1.5 py-0 rounded-full bg-sol-bg-highlight text-sol-text-dim">{l}</span>
            ))}
          </div>
        )}
        {type === "doc" && docPreview && (
          <p className="text-[11px] text-sol-text-muted/70 mt-1 truncate">{docPreview}</p>
        )}
      </div>
    </button>
  );
}

function CastCommandBlock({ tool, result }: { tool: ToolCall; result?: ToolResult }) {
  const [expanded, setExpanded] = useState(false);
  const cast = parseCastCommand(tool)!;
  const { category, subcommand, args } = cast;
  const output = result?.content || "";
  const isError = result?.is_error;

  const cat = category === "t" ? "task" : category === "p" ? "plan" : category === "d" ? "doc" : category === "sched" ? "schedule" : category;
  const isCreate = subcommand === "create" || subcommand === "add";

  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const entityIds = useMemo(() => {
    const ids: string[] = [];
    const patterns = [/\b(ct-[a-z0-9]+)\b/gi, /\b(pl-[a-z0-9]+)\b/gi];
    const sources = [args, stripAnsi(output)];
    for (const src of sources) {
      for (const pattern of patterns) {
        let m;
        while ((m = pattern.exec(src)) !== null) {
          if (!ids.includes(m[1].toLowerCase())) ids.push(m[1].toLowerCase());
        }
      }
    }
    return ids;
  }, [args, output]);

  const docConvexId = useMemo(() => {
    if (cat !== "doc") return null;
    const fa = args?.match(/^"([^"]*)"/) || args?.match(/^'([^']*)'/) || args?.match(/^(\S+)/);
    const firstA = fa ? fa[1] : "";
    if (!isCreate && firstA && /^[a-z0-9]{20,}$/i.test(firstA)) return firstA;
    if (isCreate && output) {
      const clean = stripAnsi(output);
      const m = clean.match(/Created\s+\w+\s+([a-z0-9]{20,})/i) || clean.match(/\b([a-z0-9]{20,})\b/i);
      return m ? m[1] : null;
    }
    return null;
  }, [cat, isCreate, output, args]);

  const isEntityCommand = ((cat === "task" || cat === "plan") && isCreate && entityIds.length > 0) || (cat === "doc" && !!docConvexId);

  const getCategoryConfig = () => {
    switch (cat) {
      case "task": return {
        color: "text-sol-yellow/80",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
      };
      case "plan": return {
        color: "text-sol-cyan/80",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></svg>
      };
      case "doc": return {
        color: "text-sol-blue/80",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
      };
      case "search": return {
        color: "text-sol-violet/80",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
      };
      case "feed": return {
        color: "text-sol-green/80",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
      };
      case "schedule": return {
        color: "text-sol-orange/80",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="10" /><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2" /></svg>
      };
      case "diff": case "summary": case "handoff": case "context": case "ask": return {
        color: "text-sol-magenta/80",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
      };
      default: return {
        color: "text-sol-text-dim",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
      };
    }
  };

  const config = getCategoryConfig();

  const firstArg = useMemo(() => {
    if (!args) return "";
    const m = args.match(/^"([^"]*)"/) || args.match(/^'([^']*)'/) || args.match(/^(\S+)/);
    return m ? m[1] : "";
  }, [args]);

  const renderSummary = () => {
    const isShow = subcommand === "show" || subcommand === "status" || subcommand === "context";
    const isGet = subcommand === "get";
    const isList = subcommand === "ls" || subcommand === "list";
    const isSearch = subcommand === "search" || cat === "search";
    const isStatusChange = ["start", "done", "drop", "pause", "activate", "bind", "unbind"].includes(subcommand);
    const isIdCommand = ["edit", "get", "show", "status", "context", "comment", "start", "done", "drop", "pause", "activate", "bind", "unbind", "update", "decide", "discover", "pointer", "decompose", "orchestrate", "autopilot", "wave", "progress", "agents", "kill", "retry"].includes(subcommand);

    const statusColors: Record<string, string> = {
      start: "bg-amber-500/15 text-amber-400",
      done: "bg-emerald-500/15 text-emerald-400",
      drop: "bg-red-500/15 text-red-400",
      pause: "bg-gray-500/15 text-gray-400",
      activate: "bg-emerald-500/15 text-emerald-400",
      bind: "bg-sol-cyan/15 text-sol-cyan",
      unbind: "bg-gray-500/15 text-gray-400",
    };

    const outputLines = output.trim().split("\n").filter(l => l.trim()).length;

    if (isEntityCommand && entityIds.length > 0 && cat !== "doc") return null;

    if (cat === "doc" && docConvexId) {
      return (
        <>
          <DocTitleLink convexId={docConvexId} />
          {isError && <span className="text-sol-red/80 text-[10px]">(error)</span>}
        </>
      );
    }

    return (
      <>
        {entityIds.length > 0 && entityIds.map(id => (
          <EntityIdPill key={id} shortId={id} />
        ))}

        {isCreate && !entityIds.length && firstArg && (
          <span className="text-sol-text-muted truncate">{truncateStr(firstArg, 50)}</span>
        )}

        {(isShow || isGet) && !entityIds.length && firstArg && (
          <span className="text-sol-text-dim font-mono">{firstArg}</span>
        )}

        {isIdCommand && !isShow && !isGet && !isStatusChange && !entityIds.length && firstArg && (
          <span className="text-sol-text-dim font-mono">{firstArg}</span>
        )}

        {isStatusChange && (
          <span className={`px-1 py-0.5 rounded text-[10px] font-mono ${statusColors[subcommand] || "bg-gray-500/15 text-gray-400"}`}>
            {subcommand}
          </span>
        )}

        {isList && output && (
          <span className="text-sol-text-dim font-mono">({outputLines} items)</span>
        )}

        {isSearch && firstArg && (
          <span className="text-sol-text-muted italic truncate">"{truncateStr(firstArg, 40)}"</span>
        )}

        {isError && <span className="text-sol-red/80 text-[10px]">(error)</span>}

        {!isList && !isError && !isEntityCommand && output && outputLines > 1 && (
          <span className="text-sol-text-dim font-mono">({outputLines} lines)</span>
        )}
      </>
    );
  };

  const subLabel = subcommand ? subcommand.replace(/-/g, " ") : "";

  return (
    <div className="my-0.5">
      <div
        className="flex items-baseline gap-1.5 text-xs cursor-pointer group flex-wrap"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`flex items-center gap-1 font-mono flex-shrink-0 ${config.color}`}>
          {config.icon}
          <span className="group-hover:underline">{cat}{subLabel ? ` ${subLabel}` : ""}</span>
        </span>
        {renderSummary()}
      </div>

      {isEntityCommand && entityIds.length > 0 && cat !== "doc" && entityIds.map(id => (
        <CastEntityCard
          key={id}
          type={id.startsWith("pl-") ? "plan" : "task"}
          shortId={id}
        />
      ))}

      {cat === "doc" && docConvexId && (
        <CastEntityCard type="doc" convexId={docConvexId} />
      )}

      {expanded && (
        <div className="mt-1 rounded border border-sol-border/30 bg-sol-bg-alt max-h-80 overflow-auto">
          <div className="px-1.5 sm:px-2 py-1 sm:py-1.5 border-b border-sol-border/20 bg-sol-bg-highlight/30">
            <pre className="text-[11px] sm:text-xs font-mono text-sol-green whitespace-pre-wrap break-all">
              $ {cast.fullCmd}
            </pre>
          </div>
          {output && output.trim() ? (
            <pre className={`p-1.5 sm:p-2 text-[11px] sm:text-xs font-mono overflow-x-auto whitespace-pre-wrap ${isError ? "text-sol-red" : "text-sol-text-secondary"}`}>
              {renderAnsi(output)}
            </pre>
          ) : (
            <div className="p-2 text-xs text-sol-text-dim">No output</div>
          )}
        </div>
      )}
    </div>
  );
}

function SendMessageBlock({ tool, agentNameToChildMap }: { tool: ToolCall; agentNameToChildMap?: Record<string, string> }) {
  let parsedInput: Record<string, any> = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}

  const type = parsedInput.type || "message";
  const recipient = parsedInput.recipient;
  const summary = parsedInput.summary;
  const content = parsedInput.content;
  const childId = recipient && agentNameToChildMap?.[recipient];

  const isShutdown = type === "shutdown_request";
  const isBroadcast = type === "broadcast";

  const typeConfig = isShutdown
    ? { icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5.636 5.636a9 9 0 1012.728 0M12 3v9" /></svg>, color: "text-red-400/80", bg: "bg-red-500/8 border-red-500/15", label: "shutdown" }
    : isBroadcast
    ? { icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" /></svg>, color: "text-orange-400/80", bg: "bg-orange-500/8 border-orange-500/15", label: "broadcast" }
    : { icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>, color: "text-amber-400/80", bg: "bg-amber-500/8 border-amber-500/15", label: "message" };

  const displayText = summary || (content && String(content).slice(0, 80)) || "";

  return (
    <div className="my-0.5">
      <div className={`flex items-center gap-1.5 text-xs py-1.5 px-2.5 rounded-md border ${typeConfig.bg}`}>
        <span className={typeConfig.color}>{typeConfig.icon}</span>
        {isShutdown ? (
          <>
            {recipient && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/20 font-mono">@{recipient}</span>}
            <span className="text-red-400/80 font-medium text-xs">shutdown request</span>
          </>
        ) : (
          <>
            {recipient && (
              childId ? (
                <Link href={`/conversation/${childId}`} className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20 font-mono hover:bg-amber-500/25 hover:text-amber-300 transition-colors" onClick={e => e.stopPropagation()}>@{recipient}</Link>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20 font-mono">@{recipient}</span>
              )
            )}
            {isBroadcast && <span className="text-[10px] px-1 py-0.5 rounded bg-orange-500/15 text-orange-400 font-mono">all</span>}
            {displayText && <span className="text-sol-text-muted truncate">{displayText}</span>}
          </>
        )}
      </div>
    </div>
  );
}

function TeamCreateBlock({ tool }: { tool: ToolCall }) {
  let parsedInput: Record<string, any> = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}

  const isDelete = tool.name === "TeamDelete";

  return (
    <div className="my-0.5">
      <div className={`flex items-center gap-1.5 text-xs py-1.5 px-2.5 rounded-md border ${isDelete ? "bg-red-500/5 border-red-500/15" : "bg-cyan-500/8 border-cyan-500/15"}`}>
        <svg className={`w-3 h-3 shrink-0 ${isDelete ? "text-red-400/70" : "text-cyan-400/70"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
        <span className={`font-mono text-xs font-medium ${isDelete ? "text-red-400/80" : "text-cyan-400/80"}`}>
          {isDelete ? "Team dissolved" : "Team created"}
        </span>
        {parsedInput.team_name && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-cyan-500/15 text-cyan-400 border border-cyan-500/20">
            {parsedInput.team_name}
          </span>
        )}
        {parsedInput.description && <span className="text-sol-text-dim truncate">{String(parsedInput.description).slice(0, 60)}</span>}
      </div>
    </div>
  );
}

function SkillBlock({ tool }: { tool: ToolCall }) {
  let parsedInput: { skill?: string; args?: string } = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}
  const skillName = parsedInput.skill || "skill";
  return (
    <div className="my-0.5">
      <div className="flex items-center gap-1.5 text-xs">
        <span className="font-mono text-sol-cyan/80">/{skillName}</span>
        {parsedInput.args && <span className="text-sol-text-dim">{parsedInput.args}</span>}
      </div>
    </div>
  );
}

function PlanModeBlock({ tool, result, onSendMessage }: { tool: ToolCall; result?: ToolResult; onSendMessage?: (content: string) => void }) {
  const isEnter = tool.name === "EnterPlanMode";
  const isExit = tool.name === "ExitPlanMode";
  const isWaitingForApproval = isExit && !result && !!onSendMessage;
  const [sent, setSent] = useState(false);

  return (
    <div className="my-0.5">
      <div className="flex items-center gap-1.5 text-xs">
        <svg className="w-3 h-3 text-sol-violet/80" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
        </svg>
        <span className="font-mono text-sol-violet font-semibold text-[11px]">Plan Mode</span>
        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-sol-violet/15 text-sol-violet border border-sol-violet/30">
          {isEnter ? "enter" : "exit"}
        </span>
      </div>
      {isWaitingForApproval && !sent && (
        <div className="flex items-center gap-1.5 mt-1.5 ml-0.5 flex-wrap">
          <button
            onClick={() => { setSent(true); onSendMessage(JSON.stringify({ __cc_poll: true, keys: ["1"], display: "Start (clear context)" })); }}
            className="text-[11px] px-2.5 py-1 rounded border border-sol-border/40 bg-sol-bg-alt text-sol-text hover:border-sol-green/40 hover:bg-sol-green/10 hover:text-sol-green transition-colors cursor-pointer"
          >
            Start (clear context)
          </button>
          <button
            onClick={() => { setSent(true); onSendMessage(JSON.stringify({ __cc_poll: true, keys: ["3"], display: "Start (keep context)" })); }}
            className="text-[11px] px-2.5 py-1 rounded border border-sol-border/40 bg-sol-bg-alt text-sol-text hover:border-sol-green/40 hover:bg-sol-green/10 hover:text-sol-green transition-colors cursor-pointer"
          >
            Start (keep context)
          </button>
          <button
            onClick={() => { setSent(true); onSendMessage(JSON.stringify({ __cc_poll: true, keys: ["4"], text: "adjust the plan", display: "Adjust plan" })); }}
            className="text-[11px] px-2.5 py-1 rounded border border-sol-border/40 bg-sol-bg-alt text-sol-text-muted hover:bg-sol-bg-alt/80 transition-colors cursor-pointer"
          >
            Adjust plan
          </button>
        </div>
      )}
      {sent && (
        <div className="text-[10px] text-sol-text-dim mt-1 ml-0.5 italic">Message sent</div>
      )}
    </div>
  );
}

const _askUserSentState = new Map<string, Record<number, { key: string; label: string; text?: string }>>();

function AskUserQuestionBlock({ tool, result, onSendMessage }: { tool: ToolCall; result?: ToolResult; onSendMessage?: (content: string) => void }) {
  let parsedInput: { questions?: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean; isConfirmation?: boolean }>; answers?: Record<string, string> } = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}
  const [sent, setSent] = useState(() => _askUserSentState.has(tool.id));
  const [selections, setSelections] = useState<Record<number, { key: string; label: string; text?: string }>>(() => _askUserSentState.get(tool.id) ?? {});
  const [otherOpen, setOtherOpen] = useState<Record<number, boolean>>({});
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});

  const questions = parsedInput.questions || [];
  if (questions.length === 0) return null;

  const isMultiQuestion = questions.length > 1;
  const isConfirmation = questions[0]?.isConfirmation;

  let answers: Record<string, string> = {};
  if (parsedInput.answers && typeof parsedInput.answers === "object") {
    answers = parsedInput.answers;
  } else if (result?.content) {
    const regex = /"([^"]+)"="([^"]+)"/g;
    let match;
    while ((match = regex.exec(result.content)) !== null) {
      answers[match[1]] = match[2];
    }
  }

  const isInteractive = !result && !!onSendMessage && !sent;
  const allAnswered = isMultiQuestion && questions.every((_, i) => selections[i] !== undefined);

  const buildPayload = (sels: typeof selections) => {
    const sorted = Object.keys(sels).sort((a, b) => Number(a) - Number(b));
    const hasText = sorted.some(k => sels[Number(k)].text);
    const display = sorted.map(k => sels[Number(k)].label).join(", ");
    if (hasText) {
      const steps = sorted.map(k => {
        const s = sels[Number(k)];
        return s.text ? { key: s.key, text: s.text } : { key: s.key };
      });
      return JSON.stringify({ __cc_poll: true, steps, display });
    }
    return JSON.stringify({ __cc_poll: true, keys: sorted.map(k => sels[Number(k)].key), display });
  };

  const handleSubmitAll = () => {
    if (!onSendMessage || !allAnswered) return;
    _askUserSentState.set(tool.id, selections);
    setSent(true);
    onSendMessage(buildPayload(selections));
  };

  const commitOther = (qIdx: number, text: string, optionsCount: number) => {
    const otherKey = String(optionsCount + 1);
    const sel = { key: otherKey, label: text, text };
    if (isMultiQuestion) {
      setSelections(prev => ({ ...prev, [qIdx]: sel }));
    } else {
      const newSels = { ...selections, [qIdx]: sel };
      _askUserSentState.set(tool.id, newSels);
      setSelections(newSels);
      setSent(true);
      onSendMessage!(buildPayload({ 0: sel }));
    }
  };

  return (
    <div className="my-1.5 ml-1 border-l-2 border-sol-violet/30 pl-3 space-y-2.5">
      {questions.map((q, i) => {
        const answer = answers[q.question];
        const isCustom = answer !== undefined && !q.options.some(
          o => o.label === answer || o.label.replace(" (Recommended)", "") === answer
        );
        const sel = selections[i];
        const isOtherSelected = sel?.text !== undefined;
        return (
          <div key={i} className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              {q.header && (
                <span className="text-[9px] uppercase tracking-wider font-semibold px-1 py-px rounded bg-sol-violet/15 text-sol-violet/80 border border-sol-violet/20">
                  {q.header}
                </span>
              )}
            </div>
            <div className="text-xs text-sol-text-muted">{q.question}</div>
            <div className={q.options.some(o => o.description) ? "flex flex-col gap-1" : "flex flex-wrap gap-1"}>
              {q.options.map((opt, j) => {
                const cleanLabel = opt.label.replace(" (Recommended)", "");
                const isSelected = answer !== undefined && (opt.label === answer || cleanLabel === answer);
                const isLocalSelected = !isOtherSelected && sel?.label === cleanLabel;
                return isInteractive ? (
                  <button
                    key={j}
                    onClick={() => {
                      setOtherOpen(prev => ({ ...prev, [i]: false }));
                      const pollKey = isConfirmation ? (j === 0 ? "Enter" : "Escape") : String(j + 1);
                      if (isMultiQuestion) {
                        setSelections(prev => ({ ...prev, [i]: { key: pollKey, label: cleanLabel } }));
                      } else {
                        const newSels = { ...selections, [i]: { key: pollKey, label: cleanLabel } };
                        _askUserSentState.set(tool.id, newSels);
                        setSelections(newSels);
                        setSent(true);
                        onSendMessage!(JSON.stringify({ __cc_poll: true, keys: [pollKey], display: cleanLabel }));
                      }
                    }}
                    className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border transition-colors cursor-pointer ${
                      isLocalSelected
                        ? "bg-sol-violet/20 border-sol-violet/50 text-sol-violet"
                        : "border-sol-violet/30 text-sol-violet/80 hover:bg-sol-violet/15 hover:border-sol-violet/50 hover:text-sol-violet"
                    }`}
                  >
                    {isLocalSelected && (
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                    {opt.label}
                    {opt.description && <span className="text-sol-text-dim ml-1">{opt.description}</span>}
                  </button>
                ) : (
                  <span
                    key={j}
                    className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${
                      isSelected || isLocalSelected
                        ? "bg-sol-green/15 border-sol-green/40 text-sol-green"
                        : "border-sol-border/30 text-sol-text-dim"
                    }`}
                  >
                    {(isSelected || isLocalSelected) && (
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                    {opt.label}
                    {opt.description && <span className="text-sol-text-dim ml-1">{opt.description}</span>}
                  </span>
                );
              })}
              {isInteractive && !otherOpen[i] && (
                <button
                  onClick={() => {
                    setOtherOpen(prev => ({ ...prev, [i]: true }));
                    setSelections(prev => { const next = { ...prev }; delete next[i]; return next; });
                  }}
                  className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border transition-colors cursor-pointer ${
                    isOtherSelected
                      ? "bg-sol-blue/20 border-sol-blue/50 text-sol-blue"
                      : "border-sol-border/30 text-sol-text-dim hover:border-sol-blue/40 hover:text-sol-blue/80"
                  }`}
                >
                  {isOtherSelected && (
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                  {isOtherSelected ? sel.label : "Other"}
                </button>
              )}
              {!isInteractive && (isCustom || isOtherSelected) && (
                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border bg-sol-blue/15 border-sol-blue/40 text-sol-blue">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  {isOtherSelected ? sel.label : answer}
                </span>
              )}
            </div>
            {isInteractive && otherOpen[i] && (
              <div className="flex items-center gap-1.5 mt-1">
                <input
                  autoFocus
                  type="text"
                  value={otherTexts[i] || ""}
                  onChange={e => setOtherTexts(prev => ({ ...prev, [i]: e.target.value }))}
                  onKeyDown={e => {
                    if (e.key === "Enter" && otherTexts[i]?.trim()) {
                      commitOther(i, otherTexts[i].trim(), q.options.length);
                      setOtherOpen(prev => ({ ...prev, [i]: false }));
                    } else if (e.key === "Escape") {
                      setOtherOpen(prev => ({ ...prev, [i]: false }));
                    }
                  }}
                  placeholder="Type your answer..."
                  className="flex-1 text-xs px-2 py-1 rounded border border-sol-blue/30 bg-sol-bg-alt text-sol-text placeholder:text-sol-text-dim/50 focus:outline-none focus:border-sol-blue/60"
                />
                <button
                  onClick={() => {
                    if (otherTexts[i]?.trim()) {
                      commitOther(i, otherTexts[i].trim(), q.options.length);
                      setOtherOpen(prev => ({ ...prev, [i]: false }));
                    }
                  }}
                  disabled={!otherTexts[i]?.trim()}
                  className="text-[10px] px-2 py-1 rounded border border-sol-blue/40 text-sol-blue hover:bg-sol-blue/15 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  OK
                </button>
                <button
                  onClick={() => setOtherOpen(prev => ({ ...prev, [i]: false }))}
                  className="text-[10px] px-1.5 py-1 text-sol-text-dim hover:text-sol-text transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        );
      })}
      {isInteractive && isMultiQuestion && (
        <div className="pt-1">
          <button
            onClick={handleSubmitAll}
            disabled={!allAnswered}
            className={`text-[11px] px-3 py-1 rounded border transition-colors ${
              allAnswered
                ? "border-sol-green/40 bg-sol-green/10 text-sol-green hover:bg-sol-green/20 cursor-pointer"
                : "border-sol-border/30 bg-sol-bg-alt text-sol-text-dim cursor-not-allowed opacity-50"
            }`}
          >
            Submit answers ({Object.keys(selections).length}/{questions.length})
          </button>
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ content, showContent = true }: { content: string; showContent?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = truncateLines(content, expanded ? 50 : 2);
  const isLong = truncated.truncated || content.length > 200;

  if (!showContent) {
    return (
      <div className="my-0.5 opacity-30 text-xs text-sol-text-muted italic">
        thinking...
      </div>
    );
  }

  return (
    <div className="my-0.5 opacity-50">
      <div
        className={`flex items-start gap-1 ${isLong || expanded ? 'cursor-pointer' : ''}`}
        onClick={() => (isLong || expanded) && setExpanded(!expanded)}
      >
        {(isLong || expanded) && (
          <svg
            className={`w-3 h-3 mt-0.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        )}
        <div className="flex-1 text-sol-text-muted font-mono whitespace-pre-wrap break-words text-xs">
          {truncated.text}
          {truncated.truncated && !expanded && "..."}
        </div>
      </div>
    </div>
  );
}

const IMAGE_COLLAPSED_HEIGHT = 100;

function useSwipeToDismiss(onDismiss: () => void) {
  const [swipeY, setSwipeY] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const startY = useRef(0);

  const handlers = useMemo(() => ({
    onTouchStart: (e: React.TouchEvent) => {
      startY.current = e.touches[0].clientY;
      setSwiping(true);
      setSwipeY(0);
    },
    onTouchMove: (e: React.TouchEvent) => {
      if (!swiping) return;
      const dy = e.touches[0].clientY - startY.current;
      setSwipeY(Math.max(0, dy));
    },
    onTouchEnd: () => {
      if (swipeY > 120) {
        onDismiss();
      }
      setSwipeY(0);
      setSwiping(false);
    },
  }), [swiping, swipeY, onDismiss]);

  const style = useMemo(() => swipeY > 0 ? {
    transform: `translateY(${swipeY}px)`,
    transition: swiping ? 'none' : 'transform 0.2s ease-out',
  } : undefined, [swipeY, swiping]);

  const backdropOpacity = swipeY > 0 ? Math.max(0.2, 1 - swipeY / 300) : 1;

  return { handlers, style, backdropOpacity, swipeY };
}

function ImageBlock({ image }: { image: ImageData }) {
  const storageUrl = useQuery(
    api.images.getImageUrl,
    image.storage_id ? { storageId: image.storage_id as Id<"_storage"> } : "skip"
  );
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const gallery = useImageGallery();

  // storageUrl: undefined = still loading, null = not found, string = URL
  const storageResolved = image.storage_id ? storageUrl !== undefined : true;
  const storageMissing = image.storage_id && storageUrl === null;

  const src = image.storage_id
    ? (typeof storageUrl === "string" ? storageUrl : undefined)
    : image.data
      ? `data:${image.media_type};base64,${image.data}`
      : undefined;

  useWatchEffect(() => {
    if (src && gallery) gallery.register(src);
  }, [src, gallery]);

  // Don't render if storage resolved to missing, image errored, or no source available
  if (storageMissing || errored || (!src && storageResolved)) {
    return null;
  }

  if (!src) {
    return (
      <div className="my-2 max-w-md rounded-t border-x border-t border-sol-border bg-sol-bg-alt flex items-center justify-center" style={{ height: IMAGE_COLLAPSED_HEIGHT }}>
        <span className="text-sol-text-dim text-xs">Loading image...</span>
      </div>
    );
  }

  return (
    <div
      className="my-2 cursor-pointer relative max-w-md"
      style={{ minHeight: IMAGE_COLLAPSED_HEIGHT }}
      onClick={() => gallery?.open(src)}
    >
      {!loaded && (
        <div className="absolute inset-0 rounded-t border-x border-t border-sol-border bg-sol-bg-alt flex items-center justify-center z-10" style={{ height: IMAGE_COLLAPSED_HEIGHT }}>
          <span className="text-sol-text-dim text-xs">Loading image...</span>
        </div>
      )}
      <div
        className="overflow-hidden rounded-t border-x border-t border-sol-border hover:border-sol-blue/50 transition-all"
        style={{ height: IMAGE_COLLAPSED_HEIGHT }}
      >
        <img
          src={src}
          alt="User provided image"
          className="w-full"
          style={loaded ? undefined : { width: 0, height: 0, overflow: 'hidden', position: 'absolute' }}
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
        />
      </div>
      {loaded && (
        <div
          className="absolute bottom-0 left-0 right-0 h-20 pointer-events-none"
          style={{ background: 'linear-gradient(to bottom, transparent, var(--image-fade-bg, var(--sol-bg, #0a0a0a)))' }}
        />
      )}
    </div>
  );
}

function UserIcon({ avatarUrl }: { avatarUrl?: string | null }) {
  if (avatarUrl) {
    return <img src={avatarUrl} alt="" className="w-6 h-6 rounded shrink-0 object-cover shadow-[0_0_0_0.5px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.06)]" />;
  }
  return (
    <div className="w-6 h-6 rounded bg-sol-blue flex items-center justify-center shrink-0">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    </div>
  );
}

function CommandStatusLine({ content, timestamp }: { content: string; timestamp: number }) {
  const cmdType = getCommandType(content);
  const cmdNameMatch = content.match(/<command-name>([^<]*)<\/command-name>/) || content.match(/<command-message>([^<]*)<\/command-message>/) || content.trim().match(/^\/([\w-]+)/);
  const cmdName = cmdNameMatch?.[1]?.replace(/^\//, "");
  const cleaned = cleanContent(content);
  const rawDisplay = cleaned.slice(0, 100) || content.replace(/<[^>]+>/g, "").slice(0, 100);
  const displayText = cmdName ? rawDisplay.replace(new RegExp(`(/?${cmdName}\\s*)+`), "").trim() : rawDisplay;

  if (cmdName) {
    return (
      <div className="mb-2 px-3 py-1.5 flex items-center gap-2 text-xs">
        <svg className="w-3 h-3 text-sol-cyan/70 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
        </svg>
        <span className="font-mono text-sol-cyan/80 font-medium">/{cmdName}</span>
        {displayText && <span className="text-[11px] text-sol-text-dim truncate">{displayText}</span>}
        <span className="text-sol-text-dim text-[10px] ml-auto shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      </div>
    );
  }

  return (
    <div className="mb-2 px-3 py-1.5 flex items-center gap-2 text-xs text-sol-text-dim">
      <span className="text-sol-text-dim" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      <span className="px-1.5 py-0.5 rounded bg-sol-bg-alt/50 text-sol-text-muted font-mono text-[10px]">
        {cmdType || "status"}
      </span>
      <span className="font-mono truncate">{displayText}</span>
    </div>
  );
}

function SkillExpansionBlock({ content, timestamp, cmdName, collapsed }: { content: string; timestamp: number; cmdName?: string; collapsed?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const info = extractSkillInfo(content);
  const skillName = cmdName || info?.name || "skill";

  if (collapsed) {
    return (
      <div className="px-3 py-1.5 flex items-center gap-2 text-xs">
        <svg className="w-3 h-3 text-sol-cyan/70 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
        </svg>
        <span className="font-mono text-sol-cyan/80 font-medium">/{skillName}</span>
        <span className="text-sol-text-dim ml-auto shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      </div>
    );
  }

  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded(e => !e)}
        className="group flex items-center gap-2 px-3 py-2 rounded-md bg-sol-bg-alt/40 border border-sol-border/30 hover:border-sol-cyan/30 transition-colors w-full text-left"
      >
        <svg className="w-3.5 h-3.5 text-sol-cyan/70 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
        </svg>
        <span className="font-mono text-xs text-sol-cyan/80 font-medium">/{skillName}</span>
        {info?.preview && !expanded && (
          <span className="text-[11px] text-sol-text-dim truncate">{info.preview}</span>
        )}
        <span className="ml-auto text-sol-text-dim text-[10px] shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
        <svg className={`w-3 h-3 text-sol-text-dim transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="mt-1 rounded-md bg-sol-bg-alt/25 border border-sol-border/20 p-3 text-xs text-sol-text-muted overflow-y-auto leading-relaxed prose prose-invert prose-sm max-w-none">
          <ReactMarkdown
            remarkPlugins={entityRemarkPlugins}
            rehypePlugins={[rehypeHighlight]}
            components={{
              code: EntityAwareCode,
              a: EntityAwareLink,
              img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} />,
              pre: ({ node, children, ...props }) => renderMarkdownPre(node, children, props),
            }}
          >{content
            .replace(/<command-name>[^<]*<\/command-name>\s*/g, "")
            .replace(/<command-message>[^<]*<\/command-message>\s*/g, "")
            .replace(/^Base directory for this skill:[^\n]*\n?/, "")
            .replace(/<[^>]+>/g, "")
            .trim()}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function isInterruptMessage(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith("[Request interrupted") || trimmed.startsWith("[Request cancelled");
}

function isCodexTurnAbortedMessage(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith("<turn_aborted>") && trimmed.includes("</turn_aborted>");
}

function isInterruptLikeMessage(content: string, agentType?: string): boolean {
  if (isInterruptMessage(content)) return true;
  return agentType === "codex" && isCodexTurnAbortedMessage(content);
}

function InterruptStatusLine({ label = "user interrupted", tone = "sky" }: { label?: string; tone?: "sky" | "amber" }) {
  const lineClass = tone === "amber"
    ? "flex-1 h-px bg-gradient-to-r from-transparent via-amber-500/40 to-transparent"
    : "flex-1 h-px bg-gradient-to-r from-transparent via-sky-400/40 to-transparent";
  const textClass = tone === "amber" ? "text-xs text-amber-500 font-medium" : "text-xs text-sky-400 font-medium";
  return (
    <div className="my-6 flex items-center gap-3">
      <div className={lineClass} />
      <span className={textClass}>{label}</span>
      <div className={lineClass} />
    </div>
  );
}

function isTaskNotification(content: string): boolean {
  return content.trim().startsWith('<task-notification>');
}

function parseTaskNotification(content: string): { taskId: string; status: string; summary: string; outputFile?: string } | null {
  const match = content.match(/<task-notification>([\s\S]*?)<\/task-notification>/);
  if (!match) return null;
  const inner = match[1];
  const taskId = inner.match(/<task-id>(.*?)<\/task-id>/)?.[1] || '';
  const status = inner.match(/<status>(.*?)<\/status>/)?.[1] || '';
  const summary = inner.match(/<summary>(.*?)<\/summary>/)?.[1] || '';
  const outputFile = inner.match(/<output-file>(.*?)<\/output-file>/)?.[1];
  return { taskId, status, summary, outputFile };
}

function isCompactionPromptMessage(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  return (
    trimmed.includes("Your task is to create a detailed summary of the conversation so far") ||
    (trimmed.startsWith("Your task is to create a detailed summary") && trimmed.includes("<summary>"))
  );
}

function extractCompactionSummaryContent(content: string): string {
  if (!content) return "";
  const summaryMatch = content.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/i);
  if (summaryMatch?.[1]) {
    return summaryMatch[1].trim();
  }
  return content.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "").trim();
}

const taskStatusConfig: Record<string, { icon: string; color: string; bg: string }> = {
  completed: { icon: '\u2713', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
  killed: { icon: '\u25A0', color: 'text-sol-orange', bg: 'bg-sol-orange/10 border-sol-orange/20' },
  failed: { icon: '\u2717', color: 'text-sol-red', bg: 'bg-sol-red/10 border-sol-red/20' },
  running: { icon: '\u25B6', color: 'text-sol-blue', bg: 'bg-sol-blue/10 border-sol-blue/20' },
};

function TaskNotificationLine({ content, timestamp, agentNameToChildMap }: { content: string; timestamp: number; agentNameToChildMap?: Record<string, string> }) {
  const parsed = parseTaskNotification(content);
  const router = useRouter();
  if (!parsed) return null;
  const cfg = taskStatusConfig[parsed.status] || taskStatusConfig.killed;

  let childId: string | undefined;
  const nameMatch = parsed.summary.match(/['\u201c\u201d"](.*?)['\u201c\u201d"]/);
  const agentName = nameMatch?.[1];
  if (agentName && agentNameToChildMap?.[agentName]) {
    childId = agentNameToChildMap[agentName];
  }

  return (
    <div
      className={`mb-2 px-3 py-2 flex items-center gap-2.5 text-xs border rounded ${cfg.bg}${childId ? " cursor-pointer hover:brightness-125 transition-all" : ""}`}
      onClick={childId ? () => router.push(`/conversation/${childId}`) : undefined}
    >
      <span className={`font-mono text-sm leading-none shrink-0 ${cfg.color}`}>{cfg.icon}</span>
      <span className="text-sol-text-muted min-w-0 truncate">{parsed.summary}</span>
      {childId && (
        <svg className={`w-3 h-3 shrink-0 ${cfg.color}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      )}
      <span className="text-sol-text-dim font-mono text-[10px] ml-auto shrink-0">{parsed.taskId}</span>
      <span className="text-sol-text-dim shrink-0 whitespace-nowrap" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
    </div>
  );
}

function ScheduledTaskBlock({ content, timestamp }: { content: string; timestamp: number }) {
  const match = content.match(/<scheduled-task\s+title="([^"]*)"(?:\s+task-id="([^"]*)")?[^>]*>([\s\S]*?)<\/scheduled-task>/);
  const title = match?.[1]?.replace(/&quot;/g, '"') || "Scheduled Task";
  const taskId = match?.[2]?.slice(-8);
  const prompt = match?.[3]?.trim() || content;

  return (
    <div className="mb-2 mx-1 rounded border-l-2 border-sol-violet/60 bg-sol-violet/5">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <Clock className="w-3.5 h-3.5 text-sol-violet/70" />
        <span className="text-[11px] font-medium tracking-wide uppercase text-sol-violet/70">Scheduled</span>
        <span className="text-xs text-sol-text-muted truncate">{title}</span>
        {taskId && <span className="text-[10px] font-mono text-sol-text-dim ml-auto shrink-0">{taskId}</span>}
        <span className="text-[10px] text-sol-text-dim shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      </div>
      <div className="px-3 pb-2 text-sm text-sol-text">{prompt}</div>
    </div>
  );
}

const USER_CONTENT_MAX_HEIGHT = 1800;

function parseSkillBlocks(text: string): { parts: Array<{ type: 'text' | 'skill'; content: string; skillName?: string; skillDesc?: string; skillPath?: string }>} {
  if (!text || typeof text !== 'string') {
    return { parts: [{ type: 'text', content: String(text || '') }] };
  }
  const parts: Array<{ type: 'text' | 'skill'; content: string; skillName?: string; skillDesc?: string; skillPath?: string }> = [];
  const skillRegex = /<skill>([\s\S]*?)<\/skill>/g;
  let lastIndex = 0;
  let match;
  while ((match = skillRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).trim();
      if (before) parts.push({ type: 'text', content: before });
    }
    const inner = match[1];
    const nameMatch = inner.match(/<name>(.*?)<\/name>/);
    const pathMatch = inner.match(/<path>(.*?)<\/path>/);
    const descMatch = inner.match(/description:\s*(.+)/);
    parts.push({
      type: 'skill',
      content: match[0],
      skillName: nameMatch?.[1],
      skillDesc: descMatch?.[1]?.trim(),
      skillPath: pathMatch?.[1],
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) parts.push({ type: 'text', content: remaining });
  }
  if (parts.length === 0) parts.push({ type: 'text', content: text });
  return { parts };
}

interface ParsedContextBlock {
  type: string;
  title: string;
  id?: string;
  status?: string;
  priority?: string;
}

function parseContextBlocks(text: string): { contexts: ParsedContextBlock[]; remaining: string } {
  const contexts: ParsedContextBlock[] = [];
  const remaining = text.replace(
    /<context\s+type="([^"]+)"\s+title="([^"]+)"(?:\s+id="([^"]+)")?\s*>\s*([\s\S]*?)\s*<\/context>\s*/g,
    (_, type, title, tagId, inner) => {
      const ctx: ParsedContextBlock = { type, title };
      if (tagId) ctx.id = tagId;
      const idMatch = inner.match(/ID:\s*(\S+)/);
      const statusMatch = inner.match(/Status:\s*(\S+)/);
      const priorityMatch = inner.match(/Priority:\s*(\S+)/);
      if (!ctx.id && idMatch) ctx.id = idMatch[1];
      if (statusMatch) ctx.status = statusMatch[1];
      if (priorityMatch) ctx.priority = priorityMatch[1];
      contexts.push(ctx);
      return "";
    }
  ).trim();
  return { contexts, remaining };
}

const CONTEXT_TYPE_CONFIG: Record<string, { icon: typeof ListChecks; colorClass: string }> = {
  task: { icon: ListChecks, colorClass: "bg-sol-yellow/10 text-sol-yellow border-sol-yellow/20 hover:bg-sol-yellow/20" },
  plan: { icon: Target, colorClass: "bg-sol-cyan/10 text-sol-cyan border-sol-cyan/20 hover:bg-sol-cyan/20" },
  doc: { icon: FileText, colorClass: "bg-sol-violet/10 text-sol-violet border-sol-violet/20 hover:bg-sol-violet/20" },
};

function ContextBlockPill({ ctx }: { ctx: ParsedContextBlock }) {
  const router = useRouter();
  const config = CONTEXT_TYPE_CONFIG[ctx.type] || CONTEXT_TYPE_CONFIG.task;
  const Icon = config.icon;

  const handleClick = ctx.id ? (e: React.MouseEvent) => {
    e.stopPropagation();
    const route = ctx.type === "doc" ? `/docs/${ctx.id}` : ctx.type === "plan" ? `/plans/${ctx.id}` : `/tasks/${ctx.id}`;
    router.push(route);
  } : undefined;

  return (
    <button
      onClick={handleClick}
      disabled={!handleClick}
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded border text-xs ${config.colorClass} ${handleClick ? "cursor-pointer" : ""}`}
    >
      <Icon className="w-3 h-3 flex-shrink-0" />
      <span className="font-medium capitalize">{ctx.type}</span>
      <span className="text-sol-text-muted truncate max-w-[250px]">{ctx.title}</span>
      {ctx.id && <EntityIdPill shortId={ctx.id} />}
    </button>
  );
}

type InsightPart = { type: 'text'; content: string } | { type: 'insight'; label: string; content: string };

function parseInsightBlocks(text: string): InsightPart[] {
  if (!text || typeof text !== 'string') {
    return [{ type: 'text', content: String(text || '') }];
  }
  const insightRegex = /`([★✦⭐☆\*])\s+([\w\s]+?)\s*─+`([\s\S]*?)`─+`/g;
  const parts: InsightPart[] = [];
  let lastIndex = 0;
  let match;
  while ((match = insightRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).trim();
      if (before) parts.push({ type: 'text', content: before });
    }
    parts.push({
      type: 'insight',
      label: match[2].trim(),
      content: match[3].trim(),
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) parts.push({ type: 'text', content: remaining });
  }
  if (parts.length === 0) parts.push({ type: 'text', content: text });
  return parts;
}

function InsightCard({ label, content }: { label: string; content: string }) {
  return (
    <div className="my-3 rounded-lg overflow-hidden border border-sol-violet/30 bg-gradient-to-br from-sol-bg-alt via-sol-bg-alt to-sol-violet/5">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-sol-violet/20 bg-sol-violet/8">
        <svg className="w-3.5 h-3.5 text-sol-violet flex-shrink-0" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z" />
        </svg>
        <span className="text-xs font-semibold tracking-wide uppercase text-sol-violet">{label}</span>
      </div>
      <div className="px-4 py-3 text-sm text-sol-text-secondary leading-relaxed prose prose-invert prose-sm max-w-none">
        <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={[rehypeHighlight]}
          components={{
            code: EntityAwareCode,
            a: EntityAwareLink,
            pre: ({ node, children, ...props }) => renderMarkdownPre(node, children, props),
          }}
        >{content}</ReactMarkdown>
      </div>
    </div>
  );
}

function SkillCard({ name, description, path }: { name?: string; description?: string; path?: string }) {
  const shortPath = path ? path.replace(/^\/Users\/[^/]+\//, "~/") : undefined;
  return (
    <div className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-sol-bg-alt border border-sol-border/40 text-xs font-mono">
      <span className="text-sol-violet font-semibold">/{name || "skill"}</span>
      {description && <span className="text-sol-text-muted">{description}</span>}
      {shortPath && <span className="text-sol-text-dim text-[10px] hidden sm:inline">{shortPath}</span>}
    </div>
  );
}

type TeammateMessagePart = { type: 'text'; content: string } | { type: 'teammate'; teammateId: string; color?: string; summary?: string; content: string; };

function parseTeammateMessages(text: string): TeammateMessagePart[] {
  if (!text || typeof text !== 'string') {
    return [{ type: 'text', content: String(text || '') }];
  }
  const parts: TeammateMessagePart[] = [];
  const regex = /<teammate-message\s+([^>]*)>([\s\S]*?)<\/teammate-message>/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).trim();
      if (before) parts.push({ type: 'text', content: before });
    }
    const attrs = match[1];
    const inner = match[2].trim();
    const idMatch = attrs.match(/teammate_id="([^"]+)"/);
    const colorMatch = attrs.match(/color="([^"]+)"/);
    const summaryMatch = attrs.match(/summary="([^"]+)"/);
    parts.push({
      type: 'teammate',
      teammateId: idMatch?.[1] || 'agent',
      color: colorMatch?.[1],
      summary: summaryMatch?.[1],
      content: inner,
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) parts.push({ type: 'text', content: remaining });
  }
  return parts;
}

const agentColorMap: Record<string, string> = {
  blue: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  red: "bg-red-500/20 text-red-400 border-red-500/30",
  green: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  yellow: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  purple: "bg-violet-500/20 text-violet-400 border-violet-500/30",
  cyan: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  orange: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  pink: "bg-pink-500/20 text-pink-400 border-pink-500/30",
};

const agentBorderMap: Record<string, string> = {
  blue: "border-blue-500/30",
  red: "border-red-500/30",
  green: "border-emerald-500/30",
  yellow: "border-amber-500/30",
  purple: "border-violet-500/30",
  cyan: "border-cyan-500/30",
  orange: "border-orange-500/30",
  pink: "border-pink-500/30",
};

function TeammateEventsBlock({ content, timestamp }: { content: string; timestamp: number }) {
  const parts = parseTeammateMessages(content);
  return (
    <div className="my-1 space-y-1 pl-8">
      {parts.map((part, i) => part.type === 'teammate' ? (
        <TeammateMessageCard key={i} teammateId={part.teammateId} color={part.color} summary={part.summary} content={part.content} />
      ) : part.content.trim() ? (
        <span key={i} className="text-xs text-sol-text-dim whitespace-pre-wrap">{part.content}</span>
      ) : null)}
    </div>
  );
}

function TeammateMessageCard({ teammateId, color, summary, content }: { teammateId: string; color?: string; summary?: string; content: string }) {
  const [expanded, setExpanded] = useState(false);

  const safeContent = content || '';
  let parsed: any = null;
  try { if (safeContent) parsed = JSON.parse(safeContent); } catch {}

  if (parsed?.type === "idle_notification") {
    const idleSummary = parsed.summary;
    if (idleSummary) {
      return (
        <div className="flex items-center gap-2 py-1 px-2 text-xs text-sol-text-dim rounded bg-sol-bg-alt/30">
          <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${agentColorMap[color || "blue"] || agentColorMap.blue}`}>
            {teammateId}
          </span>
          <svg className="w-2.5 h-2.5 text-sol-text-dim/40 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="italic truncate">{idleSummary}</span>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2 py-0.5 px-2 text-xs text-sol-text-dim opacity-40">
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${agentColorMap[color || "blue"] || agentColorMap.blue}`}>
          {teammateId}
        </span>
        <span className="italic">idle</span>
      </div>
    );
  }

  if (parsed?.type === "task_assignment") {
    const badgeColor = agentColorMap[color || "blue"] || agentColorMap.blue;
    return (
      <div className="flex items-center gap-2 py-1.5 px-2.5 rounded-md bg-sol-bg-alt/50 border border-sol-border/20">
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono shrink-0 ${badgeColor}`}>
          {parsed.assignedBy || teammateId}
        </span>
        <svg className="w-3 h-3 text-sol-text-dim/40 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
        </svg>
        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-sol-bg-highlight border border-sol-border/30 text-sol-text-secondary shrink-0">
          #{parsed.taskId}
        </span>
        <span className="text-xs text-sol-text-secondary truncate">{parsed.subject}</span>
      </div>
    );
  }

  if (parsed?.type === "shutdown_request" || parsed?.type === "shutdown_approved") {
    const isApproved = parsed.type === "shutdown_approved";
    return (
      <div className="flex items-center gap-2 py-1.5 px-2.5 rounded-md bg-red-500/5 border border-red-500/15">
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono shrink-0 ${agentColorMap[color || "red"] || agentColorMap.red}`}>
          {parsed.from || teammateId}
        </span>
        <svg className="w-3 h-3 text-red-400/60 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5.636 5.636a9 9 0 1012.728 0M12 3v9" />
        </svg>
        <span className="text-xs text-red-400/80 font-medium">{isApproved ? "shutdown approved" : "shutdown request"}</span>
      </div>
    );
  }

  if (parsed?.type === "teammate_terminated") {
    return (
      <div className="flex items-center gap-2 py-1.5 px-2.5 rounded-md bg-sol-bg-alt/30 border border-sol-border/15">
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono shrink-0 ${agentColorMap[color || "blue"] || agentColorMap.blue}`}>
          {teammateId}
        </span>
        <svg className="w-3 h-3 text-sol-text-dim/40 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
        </svg>
        <span className="text-xs text-sol-text-dim">{parsed.message || "terminated"}</span>
      </div>
    );
  }

  const borderColor = agentBorderMap[color || "blue"] || agentBorderMap.blue;
  const badgeColor = agentColorMap[color || "blue"] || agentColorMap.blue;
  const isLong = content.length > 200;

  return (
    <div className={`my-1.5 border-l-2 ${borderColor} pl-3 py-1`}>
      <div className="flex items-center gap-2 mb-1">
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${badgeColor}`}>
          {teammateId}
        </span>
        {summary && <span className="text-xs text-sol-text-muted">{summary}</span>}
      </div>
      <div
        className={`text-sm text-sol-text-secondary whitespace-pre-wrap break-words ${isLong && !expanded ? "line-clamp-4" : ""}`}
      >
        {content}
      </div>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-sol-text-dim hover:text-sol-blue mt-1 transition-colors"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function UserPrompt({ content, timestamp, messageId, conversationId, collapsed, userName, avatarUrl, onOpenComments, isHighlighted, shareSelectionMode, isSelectedForShare, onToggleShareSelection, onStartShareSelection, onForkFromMessage, forkChildren, messageUuid, images, onBranchSwitch, activeBranchId, loadingBranchId, isPending, isQueued, mainMessageCount }: { content: string; timestamp: number; messageId: string; conversationId?: Id<"conversations">; collapsed?: boolean; userName?: string; avatarUrl?: string | null; onOpenComments?: () => void; isHighlighted?: boolean; shareSelectionMode?: boolean; isSelectedForShare?: boolean; onToggleShareSelection?: () => void; onStartShareSelection?: (messageId: string) => void; onForkFromMessage?: (messageUuid: string) => void; forkChildren?: Array<{ _id: string; title: string; short_id?: string; started_at?: number; username?: string; message_count?: number; agent_type?: string }>; messageUuid?: string; images?: ImageData[]; onBranchSwitch?: (convId: string | null) => void; activeBranchId?: string | null; loadingBranchId?: string | null; isPending?: boolean; isQueued?: boolean; mainMessageCount?: number }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const [contentExpanded, setContentExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const rawContent = content
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
    .replace(/\[Image[:\s][^\]]*\]/gi, "")
    .replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, "")
    .replace(/\[image\]/gi, "")
    .trim();
  const { contexts: contextBlocks, remaining: displayContent } = parseContextBlocks(rawContent);
  const isMarkdown = hasRichMarkdown(displayContent);

  const effectivelyCollapsed = collapsed && !isExpanded;

  useWatchEffect(() => {
    if (effectivelyCollapsed && contentRef.current) {
      const el = contentRef.current;
      setIsTruncated(el.scrollHeight > el.clientHeight);
    } else {
      setIsTruncated(false);
    }
  }, [effectivelyCollapsed, content]);

  useWatchEffect(() => {
    if (!effectivelyCollapsed && contentRef.current && !contentExpanded) {
      setIsOverflowing(contentRef.current.scrollHeight > USER_CONTENT_MAX_HEIGHT);
    }
  }, [content, effectivelyCollapsed, contentExpanded]);

  useWatchEffect(() => {
    if (!fullscreen) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = ''; };
  }, [fullscreen]);

  const isRealMessageId = messageId && !messageId.startsWith("optimistic_");
  const commentCount = useQuery(api.comments.getCommentCount,
    isRealMessageId ? { message_id: messageId as Id<"messages"> } : "skip"
  );

  const isBookmarked = useQuery(
    api.bookmarks.isBookmarked,
    isRealMessageId ? { message_id: messageId as Id<"messages"> } : "skip"
  );
  const toggleBookmark = useMutation(api.bookmarks.toggleBookmark);

  const handleCopy = () => {
    setTimeout(() => { copyToClipboard(content).then(() => toast.success("Copied!")).catch(() => toast.error("Failed to copy")); });
  };

  const handleCopyLink = () => copyMessageLink(conversationId, messageId);

  const handleToggleBookmark = async () => {
    if (!conversationId) return;
    try {
      const result = await toggleBookmark({
        conversation_id: conversationId,
        message_id: messageId as Id<"messages">,
      });
      toast.success(result ? "Bookmarked!" : "Bookmark removed");
    } catch (err) {
      toast.error("Failed to toggle bookmark");
    }
  };

  const handleToggleExpand = () => {
    setIsExpanded(!isExpanded);
  };

  return (
    <div id={`msg-${messageId}`} className={`group relative scroll-mt-20 bg-sol-blue/10 -mx-4 px-4 py-4 rounded-lg border border-sol-blue/30 ${effectivelyCollapsed ? "mb-2" : "mb-6"} transition-all ${isHighlighted ? "ring-2 ring-sol-yellow shadow-lg rounded-lg message-highlight" : ""} ${shareSelectionMode ? "cursor-pointer" : ""} ${isSelectedForShare ? "bg-sol-cyan/10 border-2 border-sol-cyan ring-2 ring-sol-cyan/30" : ""} ${isPending ? "opacity-80 pending-stripes" : isQueued ? "opacity-90 queued-pulse" : ""}`} style={{ '--image-fade-bg': 'color-mix(in srgb, var(--sol-blue) 10%, var(--sol-bg))' } as React.CSSProperties} onClick={shareSelectionMode ? onToggleShareSelection : undefined}>
      <div className={`absolute -top-2 right-0 transition-opacity flex gap-0.5 z-10 bg-sol-bg rounded shadow-md px-0.5 ${shareSelectionMode ? "opacity-0 pointer-events-none" : "opacity-0 group-hover:opacity-100"}`}>
        {onStartShareSelection && (
          <button
            onClick={() => onStartShareSelection(messageId)}
            className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
            title="Share message"
            aria-label="Share message"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
            </svg>
          </button>
        )}
        <button
          onClick={handleCopyLink}
          className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
          title="Copy link to message"
          aria-label="Copy link to message"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
        </button>
        <button
          onClick={handleToggleBookmark}
          className={`p-1.5 rounded hover:bg-sol-bg-alt ${isBookmarked ? "text-amber-400" : "text-sol-text-dim hover:text-sol-text-secondary"}`}
          title={isBookmarked ? "Remove bookmark" : "Bookmark message"}
          aria-label={isBookmarked ? "Remove bookmark" : "Bookmark message"}
        >
          <svg className="w-4 h-4" fill={isBookmarked ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
        </button>
        <button
          onClick={onOpenComments}
          className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary flex items-center gap-1"
          title="Comments"
          aria-label="Comments"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
          </svg>
          {commentCount !== undefined && commentCount > 0 && (
            <span className="text-xs">{commentCount}</span>
          )}
        </button>
        {onForkFromMessage && messageUuid && (
          <button
            onClick={() => onForkFromMessage(messageUuid)}
            className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
            title="Fork from this message"
            aria-label="Fork from this message"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          </button>
        )}
        <button
          onClick={handleCopy}
          className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
          title="Copy message"
          aria-label="Copy message"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </button>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <UserIcon avatarUrl={avatarUrl} />
        <span className="text-sol-blue text-xs font-medium">{userName || "You"}</span>
        <a
          href={`#msg-${messageId}`}
          className="text-sol-text-dim hover:text-sol-text-muted text-xs transition-colors"
          title={`${formatFullTimestamp(timestamp)} (click to copy)`}
          onClick={(e) => { e.preventDefault(); setTimeout(() => { copyToClipboard(formatFullTimestamp(timestamp)).then(() => toast.success("Timestamp copied")); }); }}
        >
          {formatRelativeTime(timestamp)}
        </a>
        {isBookmarked && (
          <svg className="w-3 h-3 text-amber-500 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
            <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
        )}
      </div>
      {contextBlocks.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pl-8 mb-1.5">
          {contextBlocks.map((ctx, i) => (
            <ContextBlockPill key={i} ctx={ctx} />
          ))}
        </div>
      )}
      {displayContent ? <div
        ref={contentRef}
        className={`text-sol-text text-sm pl-8 break-words relative ${effectivelyCollapsed ? "line-clamp-2 whitespace-pre-wrap" : isMarkdown ? "prose prose-invert prose-sm max-w-none" : "whitespace-pre-wrap"}`}
        style={!effectivelyCollapsed && !contentExpanded && isOverflowing ? { maxHeight: USER_CONTENT_MAX_HEIGHT, overflowY: 'hidden' } : undefined}
      >
        {(() => {
          const hasTeammate = displayContent.includes('<teammate-message');
          if (effectivelyCollapsed && !hasTeammate) return <>{renderWithMentions(displayContent)}</>;
          if (effectivelyCollapsed && hasTeammate) {
            const tmParts = parseTeammateMessages(displayContent);
            return (
              <div className="space-y-1">
                {tmParts.map((part, i) => part.type === 'teammate' ? (
                  <TeammateMessageCard key={i} teammateId={part.teammateId} color={part.color} summary={part.summary} content={part.content} />
                ) : <span key={i} className="whitespace-pre-wrap">{renderWithMentions(part.content)}</span>)}
              </div>
            );
          }
          if (hasTeammate) {
            const tmParts = parseTeammateMessages(displayContent);
            return (
              <div className="space-y-1">
                {tmParts.map((part, i) => part.type === 'teammate' ? (
                  <TeammateMessageCard key={i} teammateId={part.teammateId} color={part.color} summary={part.summary} content={part.content} />
                ) : hasRichMarkdown(part.content) ? (
                  <ReactMarkdown key={i} remarkPlugins={entityRemarkPlugins} rehypePlugins={[rehypeHighlight]}
                    components={{ code: EntityAwareCode, a: EntityAwareLink, img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} />, pre: ({ node, children, ...props }) => renderMarkdownPre(node, children, props) }}
                  >{part.content}</ReactMarkdown>
                ) : <span key={i} className="whitespace-pre-wrap">{renderWithMentions(part.content)}</span>)}
              </div>
            );
          }
          const hasSkill = displayContent.includes('<skill>');
          if (hasSkill) {
            const { parts } = parseSkillBlocks(displayContent);
            return (
              <div className="space-y-2">
                {parts.map((part, i) => part.type === 'skill' ? (
                  <SkillCard key={i} name={part.skillName} description={part.skillDesc} path={part.skillPath} />
                ) : isMarkdown || hasRichMarkdown(part.content) ? (
                  <ReactMarkdown key={i} remarkPlugins={entityRemarkPlugins} rehypePlugins={[rehypeHighlight]}
                    components={{ code: EntityAwareCode, a: EntityAwareLink, img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} />, pre: ({ node, children, ...props }) => renderMarkdownPre(node, children, props) }}
                  >{part.content}</ReactMarkdown>
                ) : <span key={i}>{renderWithMentions(part.content)}</span>)}
              </div>
            );
          }
          return isMarkdown ? (
            <ReactMarkdown
              remarkPlugins={entityRemarkPlugins}
              rehypePlugins={[rehypeHighlight]}
              components={{
                code: EntityAwareCode,
                a: EntityAwareLink,
                img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} />,
                pre: ({ node, children, ...props }) => renderMarkdownPre(node, children, props),
              }}
            >{displayContent}</ReactMarkdown>
          ) : <>{renderWithMentions(displayContent)}</>;
        })()}
        {!effectivelyCollapsed && !contentExpanded && isOverflowing && (
          <div className="absolute bottom-0 left-0 right-0 h-20 pointer-events-none bg-gradient-to-b from-transparent to-[color-mix(in_srgb,var(--sol-blue)_10%,var(--sol-bg))]" />
        )}
      </div> : null}
      {!effectivelyCollapsed && images && images.filter(img => !img.tool_use_id).length > 0 && (
        <div className="pl-8 mt-2">
          {images.filter(img => !img.tool_use_id).map((img, i) => <ImageBlock key={i} image={img} />)}
        </div>
      )}
      {isTruncated && (
        <button
          onClick={handleToggleExpand}
          className="text-xs text-sol-text-dim hover:text-sol-blue mt-2 ml-8 transition-colors"
        >
          Expand
        </button>
      )}
      {isExpanded && collapsed && (
        <button
          onClick={handleToggleExpand}
          className="text-xs text-sol-text-dim hover:text-sol-blue mt-2 ml-8 transition-colors"
        >
          Collapse
        </button>
      )}
      {!effectivelyCollapsed && (isOverflowing || contentExpanded) && (
        <div className="flex items-center gap-3 mt-2 ml-8">
          <button
            onClick={() => setContentExpanded(e => !e)}
            className="text-xs font-medium text-sol-blue hover:text-sol-blue/80 transition-colors"
          >
            {contentExpanded ? "Collapse" : "Expand"}
          </button>
          <button
            onClick={() => setFullscreen(true)}
            className="text-xs font-medium text-sol-blue hover:text-sol-blue/80 transition-colors"
          >
            Fullscreen
          </button>
        </div>
      )}

      {forkChildren && forkChildren.length > 0 && onBranchSwitch && (
        <BranchSelector
          forkChildren={forkChildren}
          activeBranchId={activeBranchId ?? null}
          onSwitchBranch={(convId) => onBranchSwitch(convId)}
          loadingBranchId={loadingBranchId}
          mainMessageCount={mainMessageCount}
        />
      )}

      {fullscreen && createPortal(
        <div className="fixed inset-0 z-[10001] bg-sol-bg overflow-auto" onClick={() => setFullscreen(false)}>
          <div className="max-w-7xl mx-auto px-8 py-12" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <span className="text-sol-text-secondary text-sm font-medium">{userName || "You"}</span>
              <button
                onClick={() => setFullscreen(false)}
                className="text-sol-text-dim hover:text-sol-text-muted transition-colors p-1"
                title="Close (Esc)"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className={isMarkdown ? "prose prose-invert prose-sm max-w-none text-sol-text" : "text-sol-text text-sm whitespace-pre-wrap"}>
              {isMarkdown ? (
                <ReactMarkdown
                  remarkPlugins={entityRemarkPlugins}
                  rehypePlugins={[rehypeHighlight]}
                  components={{
                    code: EntityAwareCode,
                    a: EntityAwareLink,
                    img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} />,
                    pre: ({ node, children, ...props }) => {
                      const codeElement = node?.children?.[0];
                      if (codeElement && codeElement.type === 'element' && codeElement.tagName === 'code') {
                        const className = codeElement.properties?.className as string[] | undefined;
                        const language = className?.find((cls) => cls.startsWith('language-'))?.replace('language-', '');
                        const code = extractTextFromHast(codeElement);
                        if (code) {
                          return <CodeBlock code={code} language={language} />;
                        }
                      }
                      return <pre {...(props as any)}>{children as any}</pre>;
                    },
                  }}
                >
                  {content}
                </ReactMarkdown>
              ) : content}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function linkifyMentions(text: string, map: Record<string, string>): string {
  if (!text || Object.keys(map).length === 0) return text;
  const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (i % 2 === 1) return part;
    return part.replace(/@([\w][\w-]*)/g, (match, name) => {
      const childId = map[name];
      if (childId) return `[@${name}](/conversation/${childId})`;
      return match;
    });
  }).join('');
}

function AssistantBlock({
  content,
  timestamp,
  thinking,
  showThinking,
  toolCalls,
  toolResults,
  images,
  messageId,
  messageUuid,
  conversationId,
  collapsed,
  childConversationMap,
  childConversations,
  agentNameToChildMap,
  showHeader = true,
  onOpenComments,
  toolCallChangeSelectionMap,
  isHighlighted,
  onToggleCollapsed,
  isSequenceExpanded,
  showCollapseButton,
  runMessageIds,
  shareSelectionMode,
  isSelectedForShare,
  onToggleShareSelection,
  onStartShareSelection,
  agentType,
  taskSubjectMap,
  taskRecordMap,
  onForkFromMessage,
  forkChildren,
  onBranchSwitch,
  activeBranchId,
  loadingBranchId,
  mainMessageCount,
  model,
  onSendInlineMessage,
  isConversationActive,
  globalImageMap,
}: {
  content?: string;
  timestamp: number;
  thinking?: string;
  showThinking?: boolean;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  images?: ImageData[];
  messageId: string;
  messageUuid?: string;
  conversationId?: Id<"conversations">;
  collapsed?: boolean;
  childConversationMap?: Record<string, string>;
  childConversations?: Array<{ _id: string; title: string; is_subagent?: boolean; first_message_preview?: string }>;
  agentNameToChildMap?: Record<string, string>;
  showHeader?: boolean;
  onOpenComments?: () => void;
  toolCallChangeSelectionMap?: Record<string, ToolCallChangeSelection>;
  isHighlighted?: boolean;
  onToggleCollapsed?: () => void;
  isSequenceExpanded?: boolean;
  showCollapseButton?: boolean;
  runMessageIds?: string[];
  shareSelectionMode?: boolean;
  isSelectedForShare?: boolean;
  onToggleShareSelection?: () => void;
  onStartShareSelection?: (messageId: string) => void;
  agentType?: string;
  taskSubjectMap?: Record<string, string>;
  taskRecordMap?: TaskRecordMaps;
  onForkFromMessage?: (messageUuid: string) => void;
  forkChildren?: Array<{ _id: string; title: string; short_id?: string; started_at?: number; username?: string; message_count?: number; agent_type?: string }>;
  onBranchSwitch?: (convId: string | null) => void;
  activeBranchId?: string | null;
  loadingBranchId?: string | null;
  mainMessageCount?: number;
  model?: string;
  onSendInlineMessage?: (content: string) => void;
  isConversationActive?: boolean;
  globalImageMap?: Record<string, ImageData>;
}) {
  const COLLAPSED_LINES = 2;
  const CONTENT_MAX_HEIGHT = 800;

  const [contentExpanded, setContentExpanded] = useState(true);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const safeContent = content ? safeString(content) : content;
  const strippedContent = safeContent ? stripSystemTags(safeContent) : safeContent;
  const displayContent = strippedContent && agentNameToChildMap
    ? linkifyMentions(strippedContent, agentNameToChildMap)
    : strippedContent;
  const parsedApiError = useMemo(() => parseApiErrorContent(displayContent), [displayContent]);
  const insightParts = useMemo(() => {
    if (!displayContent) return null;
    const parts = parseInsightBlocks(displayContent);
    return parts.some(p => p.type === 'insight') ? parts : null;
  }, [displayContent]);
  const hasContent = displayContent && displayContent.trim().length > 0;
  const hasThinking = thinking && thinking.trim().length > 0;
  const hasToolCalls = toolCalls && toolCalls.length > 0;
  const hasImages = images?.some(img => !img.tool_use_id) ?? false;

  const isRealMessageId = messageId && !messageId.startsWith("optimistic_");
  const commentCount = useQuery(api.comments.getCommentCount,
    isRealMessageId ? { message_id: messageId as Id<"messages"> } : "skip"
  );

  const isBookmarked = useQuery(
    api.bookmarks.isBookmarked,
    isRealMessageId ? { message_id: messageId as Id<"messages"> } : "skip"
  );
  const toggleBookmark = useMutation(api.bookmarks.toggleBookmark);

  const toolResultMap = useMemo(() => {
    const map: Record<string, ToolResult> = {};
    if (toolResults) {
      for (const r of toolResults) {
        map[r.tool_use_id] = r;
      }
    }
    return map;
  }, [toolResults]);

  useWatchEffect(() => {
    if (!contentRef.current || collapsed) return;
    const el = contentRef.current;
    const check = () => setIsOverflowing(el.scrollHeight > CONTENT_MAX_HEIGHT);
    check();
    const obs = new ResizeObserver(check);
    obs.observe(el);
    return () => obs.disconnect();
  }, [content, collapsed]);

  useWatchEffect(() => {
    if (!fullscreen) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = ''; };
  }, [fullscreen]);

  if (!hasContent && !hasThinking && !hasToolCalls && !hasImages) {
    return null;
  }

  const lines = displayContent ? displayContent.split("\n") : [];
  const getCollapsedContent = () => {
    if (!collapsed || !displayContent) return { text: displayContent || "", wasTruncated: false };
    if (lines.length <= COLLAPSED_LINES) return { text: displayContent, wasTruncated: false };
    return { text: lines.slice(0, COLLAPSED_LINES).join("\n"), wasTruncated: true };
  };
  const { text: truncatedContent } = getCollapsedContent();

  const handleCopy = () => {
    const text = formatMessagePartsForCopy(displayContent, toolCalls, toolResults);
    if (!text) return;
    setTimeout(() => { copyToClipboard(text).then(() => toast.success("Copied!")).catch(() => toast.error("Failed to copy")); });
  };

  const handleCopyLink = () => copyMessageLink(conversationId, messageId);

  const handleToggleBookmark = async () => {
    if (!conversationId) return;
    try {
      const result = await toggleBookmark({
        conversation_id: conversationId,
        message_id: messageId as Id<"messages">,
      });
      toast.success(result ? "Bookmarked!" : "Bookmark removed");
    } catch (err) {
      toast.error("Failed to toggle bookmark");
    }
  };

  // Show Claude header for first message in sequence (regardless of content type)
  const visibleThinking = hasThinking && showThinking;
  const shouldShowHeader = showHeader;
  const onlyToolCalls = hasToolCalls && !hasContent && !visibleThinking;
  const hasVisibleContent = hasContent || visibleThinking || hasToolCalls || hasImages;

  // When nothing visible, hide completely
  if (!hasVisibleContent) {
    return null;
  }

  // When collapsed and only tool calls (no text content), hide completely -- unless it has plan writes
  const hasPlanWrite = hasToolCalls && toolCalls?.some(isPlanWriteToolCall);
  if (collapsed && onlyToolCalls && !hasPlanWrite) {
    return null;
  }

  return (
    <div id={`msg-${messageId}`} className={`group relative scroll-mt-20 ${collapsed ? "mb-1" : onlyToolCalls ? "mb-1" : "mb-6"} transition-all ${isHighlighted ? "ring-2 ring-sol-yellow shadow-lg rounded-lg p-2 -m-2 message-highlight" : ""} ${shareSelectionMode ? "cursor-pointer" : ""} ${isSelectedForShare ? "bg-sol-cyan/10 rounded-lg p-2 -m-2 border-2 border-sol-cyan ring-2 ring-sol-cyan/30" : ""}`} onClick={shareSelectionMode ? onToggleShareSelection : undefined} title={!shouldShowHeader ? formatRelativeTime(timestamp) : undefined}>
      {(hasContent || hasToolCalls) && (
        <div className={`absolute ${hasPlanWrite && onlyToolCalls ? "-top-6" : onlyToolCalls ? "top-1" : "-top-2"} right-0 transition-opacity flex gap-0.5 z-10 bg-sol-bg rounded shadow-md px-0.5 ${shareSelectionMode ? "opacity-0 pointer-events-none" : "opacity-0 group-hover:opacity-100"}`}>
          {onStartShareSelection && (
            <button
              onClick={() => onStartShareSelection(messageId)}
              className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
              title="Share message"
              aria-label="Share message"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
            </button>
          )}
          <button
            onClick={handleCopyLink}
            className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
            title="Copy link to message"
            aria-label="Copy link to message"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
          </button>
          <button
            onClick={handleToggleBookmark}
            className={`p-1.5 rounded hover:bg-sol-bg-alt ${isBookmarked ? "text-amber-400" : "text-sol-text-dim hover:text-sol-text-secondary"}`}
            title={isBookmarked ? "Remove bookmark" : "Bookmark message"}
            aria-label={isBookmarked ? "Remove bookmark" : "Bookmark message"}
          >
            <svg className="w-4 h-4" fill={isBookmarked ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
            </svg>
          </button>
          <button
            onClick={onOpenComments}
            className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary flex items-center gap-1"
            title="Comments"
            aria-label="Comments"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
            </svg>
            {commentCount !== undefined && commentCount > 0 && (
              <span className="text-xs">{commentCount}</span>
            )}
          </button>
          {onForkFromMessage && messageUuid && (
            <button
              onClick={() => onForkFromMessage(messageUuid)}
              className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
              title="Fork from this message"
              aria-label="Fork from this message"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
            </button>
          )}
          <button
            onClick={handleCopy}
            className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
            title="Copy message"
            aria-label="Copy message"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>
        </div>
      )}

      {shouldShowHeader && (
        <div className="flex items-center gap-2 mb-2 mt-4">
          <AssistantIcon agentType={agentType} />
          <span className="text-sol-text-secondary text-xs font-medium">{assistantLabel(agentType)}</span>
          {model && (
            <span className="text-sol-text-dim text-[10px] font-mono">{formatModel(model)}</span>
          )}
          <a
            href={`#msg-${messageId}`}
            className="text-sol-text-dim hover:text-sol-text-muted text-xs transition-colors"
            title={`${formatFullTimestamp(timestamp)} (click to copy)`}
            onClick={(e) => { e.preventDefault(); setTimeout(() => { copyToClipboard(formatFullTimestamp(timestamp)).then(() => toast.success("Timestamp copied")); }); }}
          >
            {formatRelativeTime(timestamp)}
          </a>
          {isBookmarked && (
            <svg className="w-3 h-3 text-amber-500 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
              <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
            </svg>
          )}
        </div>
      )}

      <div className={shouldShowHeader || !showHeader ? "pl-8" : "pl-0"}>
        {!collapsed && hasImages && images?.filter(img => !img.tool_use_id).map((img, i) => <ImageBlock key={i} image={img} />)}

        {!collapsed && hasThinking && showThinking && <ThinkingBlock content={thinking!} showContent={showThinking} />}

        {hasToolCalls && toolCalls?.map((tc) => {
          if (collapsed && !isPlanWriteToolCall(tc)) return null;
          return (tc.name === "Task" || tc.name === "Agent") ? (
            <TaskToolBlock
              key={tc.id}
              tool={tc}
              result={toolResultMap[tc.id]}
              childConversationId={messageUuid && childConversationMap ? childConversationMap[messageUuid] : undefined}
              childConversations={childConversations}
            />
          ) : tc.name === "TodoWrite" ? (
            <TodoWriteBlock key={tc.id} tool={tc} />
          ) : tc.name === "AskUserQuestion" ? (
            <AskUserQuestionBlock key={tc.id} tool={tc} result={toolResultMap[tc.id]} onSendMessage={onSendInlineMessage} />
          ) : tc.name === "TaskList" ? (
            <TaskListBlock key={tc.id} tool={tc} result={toolResultMap[tc.id]} taskRecordMap={taskRecordMap} />
          ) : tc.name === "TaskCreate" || tc.name === "TaskUpdate" || tc.name === "TaskGet" ? (
            <TaskCreateUpdateBlock key={tc.id} tool={tc} result={toolResultMap[tc.id]} taskSubjectMap={taskSubjectMap} taskRecordMap={taskRecordMap} />
          ) : tc.name === "SendMessage" ? (
            <SendMessageBlock key={tc.id} tool={tc} agentNameToChildMap={agentNameToChildMap} />
          ) : tc.name === "TeamCreate" || tc.name === "TeamDelete" ? (
            <TeamCreateBlock key={tc.id} tool={tc} />
          ) : tc.name === "Skill" ? (
            <SkillBlock key={tc.id} tool={tc} />
          ) : tc.name === "EnterPlanMode" || tc.name === "ExitPlanMode" ? (
            <PlanModeBlock key={tc.id} tool={tc} result={toolResultMap[tc.id]} onSendMessage={onSendInlineMessage} />
          ) : parseCastCommand(tc) ? (
            <CastCommandBlock key={tc.id} tool={tc} result={toolResultMap[tc.id]} />
          ) : (
            <ToolBlock
              key={tc.id}
              tool={tc}
              result={toolResultMap[tc.id]}
              changeIndex={toolCallChangeSelectionMap?.[tc.id]?.index}
              changeRange={toolCallChangeSelectionMap?.[tc.id]?.range}
              shareSelectionMode={shareSelectionMode}
              messageId={messageId}
              conversationId={conversationId}
              onStartShareSelection={onStartShareSelection}
              onOpenComments={onOpenComments}
              collapsed={collapsed}
              timestamp={timestamp}
              images={images}
              globalImageMap={globalImageMap}
            />
          );
        })}

        {hasContent && (
          <>
            <div className={parsedApiError ? "" : `text-sol-text ${collapsed ? "text-sm whitespace-pre-wrap break-words" : "prose prose-invert prose-sm max-w-none"}`}>
              {parsedApiError ? (
                <ApiErrorCard error={parsedApiError} compact={!!collapsed} />
              ) : collapsed ? (
                <div className="relative overflow-hidden">
                  <span>{truncatedContent}</span>
                  {lines.length > COLLAPSED_LINES && (
                    <div className="absolute bottom-0 left-0 right-0 h-[1.4em] pointer-events-none bg-gradient-to-b from-transparent to-[var(--sol-bg)]" />
                  )}
                </div>
              ) : (
                <div
                  ref={contentRef}
                  className="relative"
                  style={!contentExpanded && isOverflowing ? { maxHeight: CONTENT_MAX_HEIGHT, overflowY: 'hidden' } : undefined}
                >
                  {insightParts ? (
                    <div className="space-y-2">
                      {insightParts.map((part, i) => part.type === 'insight' ? (
                        <InsightCard key={i} label={part.label} content={part.content} />
                      ) : (
                        <ReactMarkdown
                          key={i}
                          remarkPlugins={entityRemarkPlugins}
                          rehypePlugins={[rehypeHighlight]}
                          components={{
                            code: EntityAwareCode,
                            a: EntityAwareLink,
                            img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} />,
                            pre: ({ node, children, ...props }) => renderMarkdownPre(node, children, props),
                          }}
                        >{part.content}</ReactMarkdown>
                      ))}
                    </div>
                  ) : (
                    <ReactMarkdown
                      remarkPlugins={entityRemarkPlugins}
                      rehypePlugins={[rehypeHighlight]}
                      components={{
                        code: EntityAwareCode,
                        a: EntityAwareLink,
                        img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} />,
                        pre: ({ node, children, ...props }) => renderMarkdownPre(node, children, props),
                      }}
                    >
                      {displayContent}
                    </ReactMarkdown>
                  )}
                  {!contentExpanded && isOverflowing && (
                    <div className="absolute bottom-0 left-0 right-0 h-8 pointer-events-none bg-gradient-to-b from-transparent to-[var(--sol-bg)]" />
                  )}
                </div>
              )}
            </div>
            {!collapsed && !parsedApiError && (isOverflowing || !contentExpanded) && (
              <div className="flex items-center gap-1 mt-2">
                <button
                  onClick={() => setFullscreen(true)}
                  className="p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-cyan transition-colors flex items-center gap-1"
                  title="Fullscreen"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                  </svg>
                  <span className="hidden sm:inline text-xs text-sol-text-dim">Full Screen</span>
                </button>
                <button
                  onClick={() => setContentExpanded(e => !e)}
                  className="p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-cyan transition-colors"
                  title={contentExpanded ? "Collapse" : "Expand"}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    {contentExpanded ? (
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
                    ) : (
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                    )}
                  </svg>
                </button>
              </div>
            )}
          </>
        )}

        {fullscreen && createPortal(
          <div className="fixed inset-0 z-[10001] bg-sol-bg overflow-auto" onClick={() => setFullscreen(false)}>
            <div className="max-w-7xl mx-auto px-8 py-12" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-6">
                <span className="text-sol-text-secondary text-sm font-medium">Message</span>
                <button
                  onClick={() => setFullscreen(false)}
                  className="text-sol-text-dim hover:text-sol-text-muted transition-colors p-1"
                  title="Close"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="prose prose-invert prose-sm max-w-none text-sol-text">
                {parsedApiError ? (
                  <ApiErrorCard error={parsedApiError} />
                ) : (
                  <ReactMarkdown
                    remarkPlugins={entityRemarkPlugins}
                    rehypePlugins={[rehypeHighlight]}
                    components={{
                      code: EntityAwareCode,
                      a: EntityAwareLink,
                      img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} />,
                      pre: ({ node, children, ...props }) => {
                        const codeElement = node?.children?.[0];
                        if (codeElement && codeElement.type === 'element' && codeElement.tagName === 'code') {
                          const className = codeElement.properties?.className as string[] | undefined;
                          const language = className?.find((cls) => cls.startsWith('language-'))?.replace('language-', '');
                          const code = extractTextFromHast(codeElement);
                          if (code) {
                            return <CodeBlock code={code} language={language} />;
                          }
                        }
                        return <pre {...(props as any)}>{children as any}</pre>;
                      },
                    }}
                  >
                    {displayContent}
                  </ReactMarkdown>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}

        {collapsed && onToggleCollapsed && (
          <button
            onClick={onToggleCollapsed}
            className="text-xs text-sol-text-dim hover:text-sol-text-muted mt-1 transition-colors"
          >
            Expand
          </button>
        )}
        {showCollapseButton && onToggleCollapsed && (
          <button
            onClick={onToggleCollapsed}
            className="text-xs text-sol-text-dim hover:text-sol-text-muted mt-1 transition-colors"
          >
            Collapse
          </button>
        )}
      </div>

      {forkChildren && forkChildren.length > 0 && onBranchSwitch && (
        <BranchSelector
          forkChildren={forkChildren}
          activeBranchId={activeBranchId ?? null}
          onSwitchBranch={(convId) => onBranchSwitch(convId)}
          loadingBranchId={loadingBranchId}
          mainMessageCount={mainMessageCount}
        />
      )}
    </div>
  );
}

function ToolResultMessage({ toolResults, toolName }: { toolResults: ToolResult[]; toolName?: string }) {
  // Don't render separate result messages - results are shown inline with tool calls
  // This component was showing duplicate content with the 1→ line number format
  return null;
}

function SystemBlock({ content, subtype, timestamp, messageUuid, messageId, conversationId, onOpenComments, onStartShareSelection }: { content: string; subtype?: string; timestamp?: number; messageUuid?: string; messageId?: string; conversationId?: Id<"conversations">; onOpenComments?: () => void; onStartShareSelection?: (messageId: string) => void }) {
  if (subtype === "compact_boundary") {
    return (
      <div className="my-6 flex items-center gap-3">
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-amber-500/40 to-transparent" />
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/30">
          <svg className="w-3.5 h-3.5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
          <span className="text-xs text-amber-500 font-medium">Context compacted</span>
        </div>
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-amber-500/40 to-transparent" />
      </div>
    );
  }

  if (subtype === "compaction_summary" && content) {
    return <CompactionSummaryBlock content={content} />;
  }

  if (subtype === "plan" && content) {
    return <PlanBlock content={content} timestamp={timestamp || Date.now()} messageId={messageId} conversationId={conversationId} onOpenComments={onOpenComments} onStartShareSelection={onStartShareSelection} />;
  }

  if (subtype === "pull_request" && content) {
    const prMatch = content.match(/^#(\d+)\s+(.*)/);
    const prNum = prMatch ? prMatch[1] : "";
    const prTitle = prMatch ? prMatch[2] : content;
    return (
      <div className="mb-3 flex items-center gap-2 px-3 py-2 bg-sol-violet/5 border border-sol-violet/20 rounded text-xs">
        <svg className="w-3.5 h-3.5 text-sol-violet flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
        </svg>
        {prNum && <span className="text-sol-violet font-mono font-medium">#{prNum}</span>}
        <span className="text-sol-text-secondary truncate">{prTitle}</span>
        {timestamp && <span className="text-sol-text-dim ml-auto flex-shrink-0">{formatRelativeTime(timestamp)}</span>}
      </div>
    );
  }

  if (subtype === "commit" && content) {
    const sha = messageUuid?.slice(0, 7) || "";
    return (
      <div className="mb-3 flex items-center gap-2 px-3 py-2 bg-emerald-500/5 border border-emerald-500/20 rounded text-xs">
        <svg className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m0 0l4-4m6 0v12m0 0l4-4m-4 4l-4-4" />
        </svg>
        {sha && <span className="text-emerald-500 font-mono font-medium">{sha}</span>}
        <span className="text-sol-text-secondary truncate">{content}</span>
        {timestamp && <span className="text-sol-text-dim ml-auto flex-shrink-0">{formatRelativeTime(timestamp)}</span>}
      </div>
    );
  }

  if ((subtype === "stop_hook_summary" || subtype === "local_command") && content) {
    const label = subtype === "stop_hook_summary" ? "hook" : "command";
    const trimmed = stripAnsiCodes(content).slice(0, 200);
    return (
      <div className="mb-3 flex items-center gap-2 px-3 py-2 bg-sol-bg-alt/30 border-l-2 border-sol-border text-xs">
        <span className="text-[10px] text-sol-text-dim bg-sol-bg-highlight px-1.5 py-0.5 rounded font-mono">{label}</span>
        <span className="text-sol-text-muted font-mono truncate">{trimmed}</span>
      </div>
    );
  }

  const cleanText = stripAnsiCodes(content.replace(/<[^>]+>/g, "")).slice(0, 200);
  if (!cleanText) return null;

  return (
    <div className="mb-4 px-3 py-2 bg-sol-bg-alt/20 border-l-2 border-sol-border text-xs">
      {subtype && (
        <span className="text-sol-text-dim text-[10px] mr-2">
          {subtype.replace(/_/g, " ")}
        </span>
      )}
      <span className="text-sol-text-muted font-mono">
        {cleanText}
        {content.length > 200 && "..."}
      </span>
    </div>
  );
}

function WorkflowEventBlock({ content, workflowRun, onGateChoice, gateResponding }: {
  content: string;
  workflowRun?: { _id: string; status: string; gate_response?: string | null } | null;
  onGateChoice?: (key: string) => void;
  gateResponding?: boolean;
}) {
  let event: Record<string, any> = {};
  try { event = JSON.parse(content); } catch { return null; }

  const wf = event.__wf as string;

  if (wf === "started") {
    return (
      <div className="my-2 flex items-center gap-2.5 px-3 py-2 rounded-lg bg-sol-violet/10 border border-sol-violet/25 text-xs">
        <svg className="w-3.5 h-3.5 text-sol-violet flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        <span className="text-sol-text-muted">Workflow started</span>
        {event.goal && <span className="text-sol-text-dim truncate">— {event.goal}</span>}
      </div>
    );
  }

  if (wf === "node_start" || wf === "node_done" || wf === "node_failed") {
    const label = event.node_label || event.node_id;
    const nodeType = event.node_type || "agent";
    const isDone = wf === "node_done";
    const isFailed = wf === "node_failed";
    const isRunning = wf === "node_start";

    const typeColors: Record<string, { bg: string; border: string; text: string }> = {
      agent:   { bg: "bg-sol-green/20", border: "border-sol-green/50", text: "text-sol-green" },
      command: { bg: "bg-sol-yellow/20", border: "border-sol-yellow/50", text: "text-sol-yellow" },
      human:   { bg: "bg-sol-magenta/20", border: "border-sol-magenta/50", text: "text-sol-magenta" },
      prompt:  { bg: "bg-sol-violet/20", border: "border-sol-violet/50", text: "text-sol-violet" },
    };
    const tc = typeColors[nodeType] || typeColors.agent;

    return (
      <div className="my-0.5">
        <div className="flex items-center gap-1.5 text-xs">
          {isDone && <span className="text-emerald-400 text-[10px]">{"\u2713"}</span>}
          {isFailed && <span className="text-sol-red text-[10px]">{"\u2717"}</span>}
          {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow animate-pulse flex-shrink-0" />}
          <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${tc.bg} border ${tc.border} ${tc.text}`}>
            {nodeType}
          </span>
          <span className={`text-xs ${isFailed ? "text-sol-red/80" : "text-sol-text-muted"}`}>{label}</span>
          {isRunning && <span className="text-sol-text-dim/50 text-[10px]">running…</span>}
          {event.session_id && isDone && (
            <Link
              href={`/conversation/${event.session_id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-sol-cyan hover:text-sol-cyan text-[10px] font-medium underline underline-offset-2"
            >
              view
            </Link>
          )}
        </div>
      </div>
    );
  }

  if (wf === "gate") {
    const choices = event.choices as Array<{ key: string; label: string; target: string }> | undefined;
    const isResolved = !workflowRun || workflowRun.status !== "paused";
    return (
      <div className="my-3 rounded-lg border border-sol-magenta/40 bg-sol-magenta/8 overflow-hidden">
        <div className="px-3 py-2 border-b border-sol-magenta/20 flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-sol-magenta flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-[10px] text-sol-magenta uppercase tracking-wider font-semibold">Human Gate</span>
          {isResolved
            ? <span className="ml-auto text-[10px] text-sol-green">responded</span>
            : <span className="ml-auto text-[10px] text-sol-magenta/70 animate-pulse">waiting…</span>
          }
        </div>
        <div className="px-3 py-2.5">
          <p className="text-sm text-sol-text">{event.prompt}</p>
          {!isResolved && choices && choices.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {choices.map(choice => (
                <button
                  key={choice.key}
                  onClick={() => onGateChoice?.(choice.key)}
                  disabled={gateResponding}
                  className="px-2 py-0.5 text-xs font-medium text-sol-text border border-sol-border/30 rounded hover:bg-sol-bg-highlight hover:border-sol-magenta/40 transition-colors disabled:opacity-40"
                >
                  <span className="font-mono text-sol-magenta mr-1">[{choice.key}]</span>
                  {choice.label.replace(/^\[.\]\s*/, "")}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}

function CompactionSummaryBlock({ content }: { content: string }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="mb-4">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 text-xs text-sol-text-dim hover:text-sol-text-muted transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-amber-500/70">Previous context summary</span>
      </button>
      {isExpanded && (
        <div className="mt-2 px-3 py-2 bg-sol-bg-alt/20 border-l-2 border-amber-500/30 text-xs prose prose-invert prose-sm max-w-none">
          <ReactMarkdown remarkPlugins={entityRemarkPlugins} components={{ code: EntityAwareCode, a: EntityAwareLink, img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} /> }}>
            {content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

const PLAN_MAX_HEIGHT = 1800;

function PlanBlock({ content, timestamp, collapsed, messageId, conversationId, onOpenComments, onStartShareSelection }: { content: string; timestamp: number; collapsed?: boolean; messageId?: string; conversationId?: Id<"conversations">; onOpenComments?: () => void; onStartShareSelection?: (messageId: string) => void }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  const isRealMessageId = messageId && !messageId.startsWith("optimistic_");
  const commentCount = useQuery(api.comments.getCommentCount,
    isRealMessageId ? { message_id: messageId as Id<"messages"> } : "skip"
  );
  const isBookmarked = useQuery(
    api.bookmarks.isBookmarked,
    isRealMessageId ? { message_id: messageId as Id<"messages"> } : "skip"
  );
  const toggleBookmark = useMutation(api.bookmarks.toggleBookmark);

  useWatchEffect(() => {
    if (contentRef.current && !isExpanded) {
      setIsOverflowing(contentRef.current.scrollHeight > PLAN_MAX_HEIGHT);
    }
  }, [content, isExpanded]);

  useWatchEffect(() => {
    if (!fullscreen) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = ''; };
  }, [fullscreen]);

  const handleCopy = () => {
    setTimeout(() => { copyToClipboard(content || "").then(() => toast.success("Copied!")).catch(() => toast.error("Failed to copy")); });
  };

  const handleCopyLink = () => messageId && copyMessageLink(conversationId, messageId);

  const handleToggleBookmark = async () => {
    if (!conversationId || !messageId) return;
    try {
      const result = await toggleBookmark({
        conversation_id: conversationId,
        message_id: messageId as Id<"messages">,
      });
      toast.success(result ? "Bookmarked!" : "Bookmark removed");
    } catch {
      toast.error("Failed to toggle bookmark");
    }
  };

  const title = content.match(/^#\s+(.+)$/m)?.[1] || "Plan";

  if (collapsed) {
    return (
      <div className="mb-2 rounded-lg border border-sol-border/60 bg-sol-bg-alt/30 px-4 py-2">
        <div className="flex items-center gap-2 text-xs text-sol-text-muted">
          <svg className="w-3.5 h-3.5 text-sol-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
          </svg>
          <span className="font-medium">{title}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="group/plan relative mb-6 rounded-lg border border-sol-border/60 bg-sol-bg-alt/30 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-sol-border/40">
        <div className="flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-sol-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
          </svg>
          <span className="text-xs font-medium text-sol-text-muted">Plan</span>
          <span className="text-xs text-sol-text-dim">{formatRelativeTime(timestamp)}</span>
        </div>
        <div className="flex items-center gap-0.5">
          {onStartShareSelection && messageId && (
            <button onClick={() => onStartShareSelection(messageId)} className="p-1 rounded hover:bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text-muted transition-colors" title="Share">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
            </button>
          )}
          {messageId && (
            <button onClick={handleCopyLink} className="p-1 rounded hover:bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text-muted transition-colors" title="Copy link">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
            </button>
          )}
          {isRealMessageId && conversationId && (
            <button onClick={handleToggleBookmark} className={`p-1 rounded hover:bg-sol-bg-highlight ${isBookmarked ? "text-amber-400" : "text-sol-text-dim hover:text-sol-text-muted"} transition-colors`} title={isBookmarked ? "Remove bookmark" : "Bookmark"}>
              <svg className="w-3.5 h-3.5" fill={isBookmarked ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
              </svg>
            </button>
          )}
          {onOpenComments && (
            <button onClick={onOpenComments} className="p-1 rounded hover:bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text-muted transition-colors flex items-center gap-0.5" title="Comments">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
              </svg>
              {commentCount !== undefined && commentCount > 0 && (
                <span className="text-[10px]">{commentCount}</span>
              )}
            </button>
          )}
          <button onClick={handleCopy} className="p-1 rounded hover:bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text-muted transition-colors" title="Copy">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>
          <button onClick={() => setFullscreen(true)} className="p-1 rounded hover:bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text-muted transition-colors" title="Fullscreen">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
          </button>
        </div>
      </div>
      <div className="px-4 py-3">
        <div
          ref={contentRef}
          className="relative prose prose-invert prose-sm max-w-none"
          style={!isExpanded && isOverflowing ? { maxHeight: PLAN_MAX_HEIGHT, overflowY: 'hidden' } : undefined}
        >
          <ReactMarkdown
            remarkPlugins={entityRemarkPlugins}
            rehypePlugins={[rehypeHighlight]}
            components={{
              code: EntityAwareCode,
              a: EntityAwareLink,
              img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} />,
              pre: ({ node, children, ...props }) => renderMarkdownPre(node, children, props),
            }}
          >
            {content}
          </ReactMarkdown>
          {!isExpanded && isOverflowing && (
            <div className="absolute bottom-0 left-0 right-0 h-20 pointer-events-none bg-gradient-to-b from-transparent to-[var(--sol-bg)]" />
          )}
        </div>
        {(isOverflowing || isExpanded) && (
          <div className="flex items-center gap-3 mt-2 pt-2 border-t border-sol-border/30">
            <button
              onClick={() => setIsExpanded(e => !e)}
              className="text-sm font-medium text-sol-cyan hover:text-sol-cyan/80 transition-colors"
            >
              {isExpanded ? "Collapse" : "Expand"}
            </button>
            <button
              onClick={() => setFullscreen(true)}
              className="text-sm font-medium text-sol-cyan hover:text-sol-cyan/80 transition-colors"
            >
              Fullscreen
            </button>
          </div>
        )}
      </div>

      {fullscreen && createPortal(
        <div className="fixed inset-0 z-[10001] bg-sol-bg overflow-auto" onClick={() => setFullscreen(false)}>
          <div className="max-w-7xl mx-auto px-8 py-12" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-sol-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                </svg>
                <span className="text-sol-text-secondary text-sm font-medium">Plan</span>
              </div>
              <button
                onClick={() => setFullscreen(false)}
                className="text-sol-text-dim hover:text-sol-text-muted transition-colors p-1"
                title="Close"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="prose prose-invert prose-sm max-w-none text-sol-text">
              <ReactMarkdown
                remarkPlugins={entityRemarkPlugins}
                rehypePlugins={[rehypeHighlight]}
                components={{
                  code: EntityAwareCode,
                  a: EntityAwareLink,
                  img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} />,
                  pre: ({ node, children, ...props }) => renderMarkdownPre(node, children, props),
                }}
              >
                {content}
              </ReactMarkdown>
            </div>
          </div>
        </div>,
        document.body
      )}

    </div>
  );
}

function GitBranchBadge({
  gitBranch,
  gitStatus,
  gitRemoteUrl,
  hasDiff,
  diffExpanded,
  onToggleDiff,
}: {
  gitBranch: string;
  gitStatus?: string | null;
  gitRemoteUrl?: string | null;
  hasDiff: boolean;
  diffExpanded: boolean;
  onToggleDiff: () => void;
}) {
  const isClean = gitStatus === "(clean)" || gitStatus === "clean" || !gitStatus;

  const githubUrl = gitRemoteUrl
    ? (() => {
        const match = gitRemoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
        if (match) {
          return `https://github.com/${match[1]}/tree/${gitBranch}`;
        }
        return null;
      })()
    : null;

  return (
    <button
      onClick={() => hasDiff && onToggleDiff()}
      className={`font-mono text-[11px] text-sol-text-muted flex-shrink-0 ${hasDiff ? "cursor-pointer hover:text-sol-text-secondary" : "cursor-default"}`}
      title={hasDiff ? (diffExpanded ? "hide diff" : "show diff") : undefined}
    >
      (
      {githubUrl ? (
        <a
          href={githubUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sol-green hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {gitBranch}
        </a>
      ) : (
        <span className="text-sol-green">{gitBranch}</span>
      )}
      {!isClean && <span className="text-sol-orange ml-0.5">*</span>})
    </button>
  );
}

function GitDiffPanel({
  gitDiff,
  gitDiffStaged,
}: {
  gitDiff?: string | null;
  gitDiffStaged?: string | null;
}) {
  return (
    <div className="border-t border-sol-border bg-sol-bg-alt/30">
      <div className="max-w-7xl mx-auto px-4 py-2 max-h-96 overflow-y-auto">
        {gitDiffStaged && gitDiffStaged.trim().length > 0 && (
          <div className="mb-2">
            <div className="text-sol-green text-[10px] font-semibold mb-1">Staged</div>
            <div className="rounded overflow-hidden bg-sol-bg-alt border border-sol-border/30">
              <GitDiffView diff={gitDiffStaged} />
            </div>
          </div>
        )}
        {gitDiff && gitDiff.trim().length > 0 && (
          <div>
            {gitDiffStaged && gitDiffStaged.trim().length > 0 && (
              <div className="text-sol-orange text-[10px] font-semibold mb-1">Unstaged</div>
            )}
            <div className="rounded overflow-hidden bg-sol-bg-alt border border-sol-border/30">
              <GitDiffView diff={gitDiff} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function GitDiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n');

  return (
    <div className="font-mono text-xs p-2 overflow-x-auto scrollbar-auto">
      <div className="min-w-fit">
      {lines.map((line, i) => {
        let className = 'whitespace-pre text-sol-text-muted';

        if (line.startsWith('+') && !line.startsWith('+++')) {
          className = 'whitespace-pre bg-sol-green/10 text-sol-green';
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          className = 'whitespace-pre bg-sol-red/10 text-sol-red';
        } else if (line.startsWith('@@')) {
          className = 'whitespace-pre text-sol-blue';
        } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
          className = 'whitespace-pre text-sol-text-secondary font-medium';
        }

        return (
          <div key={i} className={className}>
            {line}
          </div>
        );
      })}
      </div>
    </div>
  );
}

function ShortcutHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sol-text/70">{label}</span>
      <span className="flex items-center gap-[2px]">
        {keys.map((k, i) => (
          <KeyCap key={i} size="xs">{k}</KeyCap>
        ))}
      </span>
    </div>
  );
}

const CYCLING_SHORTCUTS = [
  { keys: ["Cmd", "K"], label: "command palette" },
  { keys: ["Ctrl", "I"], label: "jump to needs input" },
  { keys: ["Ctrl", "J"], label: "next session" },
  { keys: ["Ctrl", "K"], label: "previous session" },
  { keys: ["Ctrl", "Tab"], label: "MRU next" },
  { keys: ["Shift", "←"], label: "defer & next session" },
  { keys: ["Ctrl", "←"], label: "dismiss session" },
  { keys: ["Esc"], label: "escape to session" },
  { keys: ["Esc", "Esc"], label: "send escape" },
  { keys: ["Cmd", "⇧", "C"], label: "collapse tool blocks" },
  { keys: ["Ctrl", "."], label: "zen mode" },
  { keys: ["⇧", "Tab"], label: "cycle CC mode" },
  { keys: ["Cmd", "⇧", "L"], label: "copy link" },
];

function CyclingShortcutHint() {
  const [index, setIndex] = useState(0);
  const [animating, setAnimating] = useState(false);

  useMountEffect(() => {
    const interval = setInterval(() => {
      setAnimating(true);
      setTimeout(() => {
        setIndex(i => (i + 1) % CYCLING_SHORTCUTS.length);
        setAnimating(false);
      }, 200);
    }, 180000);
    return () => clearInterval(interval);
  });

  const { keys, label } = CYCLING_SHORTCUTS[index];
  return (
    <p className="text-[11px] opacity-[0.55] hidden sm:flex items-center gap-1 overflow-hidden h-[18px]">
      <span
        className={`flex items-center gap-1 transition-all duration-200 ${
          animating ? "-translate-y-full opacity-0" : "translate-y-0 opacity-100"
        }`}
      >
        {keys.map((k, i) => (
          <kbd key={i} className="px-1 py-0.5 rounded border border-current/40 text-[10px] leading-none font-semibold bg-sol-bg/50">{k}</kbd>
        ))}
        <span className="ml-1.5 text-[10px] opacity-80">{label}</span>
      </span>
    </p>
  );
}

type NavUserMessage = { _id: string; message_uuid?: string; content: string; timestamp: number };

function MessageNavigator({ userMessages, onRewind, onFork, onClose, forkPointMap, onBranchSwitch, activeBranches }: {
  userMessages: NavUserMessage[];
  onRewind: (msg: NavUserMessage, indexFromEnd: number) => void;
  onFork: (msg: NavUserMessage) => void;
  onClose: (selectedMsg?: { content: string }) => void;
  forkPointMap?: Record<string, ForkChild[]>;
  onBranchSwitch?: (messageUuid: string, convId: string | null) => void;
  activeBranches?: Record<string, string>;
}) {
  const [selectedIdx, setSelectedIdx] = useState(userMessages.length - 1);
  const [branchIdx, setBranchIdx] = useState<number>(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const escTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedMsg = userMessages[selectedIdx];
  const forks = selectedMsg?.message_uuid && forkPointMap ? forkPointMap[selectedMsg.message_uuid] || [] : [];
  const hasBranches = forks.length > 0;

  useWatchEffect(() => {
    if (!hasBranches) { setBranchIdx(-1); return; }
    const uuid = selectedMsg?.message_uuid;
    if (!uuid || !activeBranches) { setBranchIdx(-1); return; }
    const activeId = activeBranches[uuid];
    if (!activeId) { setBranchIdx(-1); return; }
    const idx = forks.findIndex(f => f._id === activeId);
    setBranchIdx(idx >= 0 ? idx : -1);
  }, [selectedIdx, hasBranches, selectedMsg?.message_uuid, activeBranches, forks]);

  useMountEffect(() => {
    return () => { if (escTimerRef.current) clearTimeout(escTimerRef.current); };
  });

  useWatchEffect(() => {
    const el = listRef.current?.children[selectedIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  useWatchEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (escTimerRef.current) {
          clearTimeout(escTimerRef.current);
          escTimerRef.current = null;
          onClose(userMessages[selectedIdx]);
        } else {
          escTimerRef.current = setTimeout(() => { escTimerRef.current = null; }, 250);
          onClose();
        }
        return;
      }
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx(i => Math.min(i + 1, userMessages.length - 1));
        return;
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx(i => Math.max(i - 1, 0));
        return;
      }
      if ((e.key === "h" || e.key === "ArrowLeft") && hasBranches) {
        e.preventDefault();
        e.stopPropagation();
        setBranchIdx(i => {
          const newIdx = Math.max(i - 1, -1);
          const uuid = selectedMsg?.message_uuid;
          if (uuid && onBranchSwitch) {
            onBranchSwitch(uuid, newIdx === -1 ? null : forks[newIdx]._id);
          }
          return newIdx;
        });
        return;
      }
      if ((e.key === "l" || e.key === "ArrowRight") && hasBranches) {
        e.preventDefault();
        e.stopPropagation();
        setBranchIdx(i => {
          const newIdx = Math.min(i + 1, forks.length - 1);
          const uuid = selectedMsg?.message_uuid;
          if (uuid && onBranchSwitch) {
            onBranchSwitch(uuid, newIdx === -1 ? null : forks[newIdx]._id);
          }
          return newIdx;
        });
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const indexFromEnd = userMessages.length - 1 - selectedIdx;
        onRewind(userMessages[selectedIdx], indexFromEnd);
        return;
      }
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        e.stopPropagation();
        onFork(userMessages[selectedIdx]);
        return;
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [userMessages, selectedIdx, onRewind, onFork, onClose, hasBranches, forks, selectedMsg, onBranchSwitch]);

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 z-50" style={{ maxHeight: "calc(100vh - 200px)" }}>
      <div className="mx-auto max-w-7xl px-4 h-full flex flex-col">
        <div className="bg-sol-bg-alt border border-sol-blue/30 rounded-lg shadow-2xl overflow-hidden flex flex-col" style={{ maxHeight: "calc(100vh - 220px)" }}>
          <div ref={listRef} className="flex-1 overflow-y-auto py-2 relative" style={{ maxHeight: "calc(100vh - 280px)" }}>
            {userMessages.map((msg, idx) => {
              const msgForks = msg.message_uuid && forkPointMap ? forkPointMap[msg.message_uuid] || [] : [];
              const msgHasBranches = msgForks.length > 0;
              const isSelected = idx === selectedIdx;
              const isLast = idx === userMessages.length - 1;
              return (
                <div key={msg._id} className="relative">
                  {/* Tree line */}
                  <div className="absolute left-3 top-0 bottom-0 flex flex-col items-center" style={{ width: "12px" }}>
                    {/* Vertical line segment */}
                    <div className={`w-px flex-1 ${msgHasBranches ? "bg-sol-cyan/30" : "bg-sol-blue/15"} ${isLast ? "hidden" : ""}`} />
                  </div>
                  {/* Fork node dot */}
                  {msgHasBranches && (
                    <div className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center" style={{ width: "12px" }}>
                      <div className={`w-2 h-2 rounded-full mx-auto ${isSelected ? "bg-sol-cyan shadow-[0_0_6px_rgba(0,205,205,0.5)]" : "bg-sol-cyan/50"}`} />
                    </div>
                  )}
                  {!msgHasBranches && (
                    <div className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center" style={{ width: "12px" }}>
                      <div className={`w-1 h-1 rounded-full mx-auto ${isSelected ? "bg-sol-blue/60" : "bg-sol-blue/20"}`} />
                    </div>
                  )}
                  <button
                    onClick={() => setSelectedIdx(idx)}
                    onDoubleClick={() => { setSelectedIdx(idx); onRewind(msg, userMessages.length - 1 - idx); }}
                    className={`w-full text-left pl-8 pr-4 py-2.5 transition-colors flex items-start gap-3 ${
                      isSelected
                        ? "bg-sol-blue/20 ring-1 ring-inset ring-sol-blue/50"
                        : "hover:bg-sol-bg-highlight"
                    }`}
                  >
                    <span className={`text-xs font-mono mt-0.5 shrink-0 w-6 text-right ${isSelected ? "text-sol-blue" : "text-sol-blue/40"}`}>{idx + 1}</span>
                    <div className="flex-1 min-w-0">
                      <span className={`text-sm leading-relaxed ${isSelected ? "text-sol-text" : "text-sol-text-secondary"}`} style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                        {safeString(msg.content)}
                      </span>
                      {msgHasBranches && isSelected && (
                        <div className="flex items-center gap-1 mt-1.5">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${branchIdx === -1 ? "bg-sol-cyan/15 text-sol-cyan border-sol-cyan/30" : "text-sol-text-dim border-transparent"}`}>
                            main
                          </span>
                          {msgForks.map((fork, fi) => (
                            <span
                              key={fork._id}
                              className={`text-[10px] px-1.5 py-0.5 rounded border truncate max-w-[120px] transition-colors ${fi === branchIdx ? "bg-sol-cyan/15 text-sol-cyan border-sol-cyan/30" : "text-sol-text-dim border-transparent"}`}
                            >
                              {fork.title || fork.short_id || "fork"}
                            </span>
                          ))}
                          <span className="text-[9px] text-sol-blue/30 ml-1">h/l</span>
                        </div>
                      )}
                      {msgHasBranches && !isSelected && (
                        <div className="flex items-center gap-1 mt-1">
                          <span className="text-[9px] text-sol-cyan/50">{msgForks.length + 1} branches</span>
                        </div>
                      )}
                    </div>
                  </button>
                </div>
              );
            })}
          </div>
          <div className="px-4 py-2 border-t border-sol-blue/20 flex items-center justify-between">
            <div className="flex items-center gap-4 text-[11px] text-sol-blue/60">
              <span className="flex items-center gap-1"><span className="flex items-center gap-[2px]"><KeyCap size="xs">J</KeyCap><span className="text-sol-text-dim/40">/</span><KeyCap size="xs">K</KeyCap></span> navigate</span>
              <span className="flex items-center gap-1"><span className="flex items-center gap-[2px]"><KeyCap size="xs">H</KeyCap><span className="text-sol-text-dim/40">/</span><KeyCap size="xs">L</KeyCap></span> branches</span>
              <span className="flex items-center gap-1"><KeyCap size="xs">Enter</KeyCap> rewind</span>
              <span className="flex items-center gap-1"><KeyCap size="xs">F</KeyCap> fork</span>
              <span className="flex items-center gap-1"><KeyCap size="xs">Esc</KeyCap> close</span>
            </div>
            <span className="text-[10px] text-sol-blue/40">{userMessages.length} message{userMessages.length !== 1 ? "s" : ""}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function GuestJoinCTA() {
  return (
    <div className="bg-sol-bg border-t border-sol-border/30">
      <div className="mx-auto max-w-7xl px-2 sm:px-4 py-3 flex items-center justify-between gap-4">
        <a href="/" className="flex items-center gap-2 text-sol-text-dim text-xs hover:text-sol-text transition-colors">
          <LogoIcon size={20} />
          <span className="font-mono font-bold text-sol-text-muted tracking-tight">codecast</span>
          <span className="opacity-50">|</span>
          <span>AI session sharing</span>
        </a>
        <a
          href="/signup"
          className="text-xs font-medium px-4 py-1.5 rounded-full bg-sol-cyan/15 text-sol-cyan border border-sol-cyan/30 hover:bg-sol-cyan/25 transition-colors whitespace-nowrap"
        >
          Join to message
        </a>
      </div>
    </div>
  );
}

// Isolated component: keeps useConvexAuth() out of ConversationView's render
// scope so auth-context re-renders don't cascade through the tooltip ref chain.
function NonOwnerMessageInput({ conversation, onForkReply, autoFocusInput }: {
  conversation: ConversationData;
  onForkReply: (content: string) => void;
  autoFocusInput?: boolean;
}) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  if (!isAuthenticated && !isLoading) return <GuestJoinCTA />;
  return (
    <ForkReplyInput
      userName={conversation.user?.name || conversation.user?.email?.split("@")[0] || "Teammate"}
      userAvatar={conversation.user?.avatar_url}
      onForkReply={onForkReply}
      autoFocusInput={autoFocusInput}
    />
  );
}

const ForkReplyInput = memo(function ForkReplyInput({ userName, userAvatar, onForkReply, autoFocusInput }: { userName: string; userAvatar?: string | null; onForkReply: (content: string) => void; autoFocusInput?: boolean }) {
  const [message, setMessage] = useState("");
  const [isForking, setIsForking] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useMountEffect(() => { if (autoFocusInput && textareaRef.current) textareaRef.current.focus(); });
  useWatchEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = textareaRef.current.scrollHeight + "px";
    }
  }, [message]);
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || isForking) return;
    setIsForking(true);
    onForkReply(message.trim());
    setMessage("");
  };
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };
  return (
    <div className="bg-sol-bg">
      <div className="flex items-center gap-2 px-4 py-1.5 text-[11px] text-sol-violet border-t border-sol-violet/15 bg-sol-violet/5">
        <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.172 13.828a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.102 1.101" />
        </svg>
        <span>
          Viewing <span className="font-medium">{userName}</span>'s session
          <span className="text-sol-text-dim ml-1">-- reply to fork as your own</span>
        </span>
      </div>
      <form onSubmit={handleSubmit} className="mx-auto max-w-7xl px-2 sm:px-4 pb-3 pt-1.5">
        <div className="flex items-end gap-2 border px-4 py-2 rounded-2xl bg-sol-bg-alt border-sol-violet/30 shadow-lg">
          <textarea
            ref={textareaRef}
            data-chat-input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isForking}
            placeholder="Reply to fork this session..."
            rows={1}
            className="flex-1 bg-transparent text-sm placeholder:text-sol-text-dim focus:outline-none disabled:opacity-50 resize-none overflow-hidden leading-relaxed py-1 text-sol-text"
          />
          <button
            type="submit"
            disabled={!message.trim() || isForking}
            className={`shrink-0 h-8 px-3 rounded-full transition-colors flex items-center gap-1.5 text-xs font-medium border ${
              !message.trim() || isForking
                ? "border-sol-border/30 text-sol-text-dim/25 cursor-not-allowed"
                : "border-sol-violet/50 bg-sol-violet/20 text-sol-violet hover:bg-sol-violet/30 hover:border-sol-violet"
            }`}
          >
            {isForking ? (
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            )}
            Fork & reply
          </button>
        </div>
      </form>
    </div>
  );
});

const MessageInput = memo(function MessageInput({ conversationId, status, embedded, onSendAndAdvance, onSendAndDismiss, autoFocusInput, initialDraft, isWaitingForResponse, isThinking, isConversationLive, isSessionDisconnected, isSessionStarting, isSessionReady, sessionId, agentType, agentStatus, deliveryStatus, pendingPermissionsCount, hasAskUserQuestion, selectedMessageContent, selectedMessageUuid, onClearSelection, onForkFromMessage, onSendEscape, onOpenNavigator, onPopulateInput, permissionMode, onCycleMode, onMessageSent, onLightboxChange, onDropFiles, onWorkflowLaunch, onGateSend, skills, filePaths, mentionItemsRef, onMentionQuery }: { conversationId: string; status?: string; embedded?: boolean; onSendAndAdvance?: () => void; onSendAndDismiss?: () => void; autoFocusInput?: boolean; initialDraft?: string; isWaitingForResponse?: boolean; isThinking?: boolean; isConversationLive?: boolean; isSessionDisconnected?: boolean; isSessionStarting?: boolean; isSessionReady?: boolean; sessionId?: string; agentType?: string; agentStatus?: "working" | "idle" | "permission_blocked" | "compacting" | "thinking" | "connected" | "starting" | "resuming"; deliveryStatus?: string; pendingPermissionsCount?: number; hasAskUserQuestion?: boolean; selectedMessageContent?: string | null; selectedMessageUuid?: string | null; onClearSelection?: () => void; onForkFromMessage?: (uuid: string) => void; onSendEscape?: () => void; onOpenNavigator?: () => void; onPopulateInput?: React.MutableRefObject<((text: string) => void) | null>; permissionMode?: string; onCycleMode?: () => void; onMessageSent?: () => void; onLightboxChange?: (active: boolean) => void; onDropFiles?: React.MutableRefObject<((files: File[]) => void) | null>; onWorkflowLaunch?: (goal: string) => Promise<void>; onGateSend?: (content: string) => Promise<void>; skills?: SkillItem[]; filePaths?: string[]; mentionItemsRef?: React.MutableRefObject<MentionItem[]>; onMentionQuery?: (q: string) => void }) {
  const sacredKey = sessionId || conversationId;
  const sacredKeyRef = useRef(sacredKey);
  const convIdRef = useRef(conversationId);
  const cached = useInboxStore.getState().getDraft(conversationId);
  const [message, _setMessage] = useState(() => sacredInputs.get(sacredKey)?.text ?? cached?.draft_message ?? initialDraft ?? "");
  const setMessage = useCallback((val: string) => {
    sacredInputs.set(sacredKeyRef.current, { text: val });
    _setMessage(val);
  }, []);
  const messageRef = useRef(message);
  messageRef.current = message;
  const sendingRef = useRef(false);
  const [isWaitingForUpload, setIsWaitingForUpload] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [composeMode, setComposeMode] = useState(false);
  const [composeHasContent, setComposeHasContent] = useState(false);
  const composeRef = useRef<ComposeEditorHandle>(null);
  const composeMentionQuery = useMentionQuery();
  const [shortcutTooltip, setShortcutTooltip] = useState<{ x: number; y: number } | null>(null);
  const [pendingMessageId, setPendingMessageId] = useState<Id<"pending_messages"> | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [showStuckBanner, setShowStuckBanner] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [optimisticSending, setOptimisticSending] = useState(false);
  const [showModeLabel, setShowModeLabel] = useState(false);
  const [modeTooltip, setModeTooltip] = useState(false);
  const modeLabelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoResumeTriggeredRef = useRef(false);
  const forceRestartAttemptedRef = useRef(false);
  const resumeSessionMutation = useMutation(api.users.resumeSession);
  const restartSessionMutation = useMutation(api.conversations.restartSession);
  const addOptimistic = useInboxStore((s) => s.addOptimisticMessage);
  const markAsQueued = useInboxStore((s) => s.markOptimisticAsQueued);
  const sentContentRef = useRef<string | null>(null);

  type AutocompleteTrigger = { type: "/" | "@"; startPos: number } | null;
  type AcItem = {
    label: string;
    description?: string;
    type: string;
    id?: string;
    shortId?: string;
    status?: string;
    priority?: string;
    docType?: string;
    messageCount?: number;
    projectPath?: string;
    goal?: string;
    model?: string;
    image?: string;
  };
  const [acTrigger, setAcTrigger] = useState<AutocompleteTrigger>(null);
  const [acIndex, setAcIndex] = useState(0);
  const acRef = useRef<HTMLDivElement>(null);
  const filePathsRef = useRef(filePaths);
  filePathsRef.current = filePaths;

  const acQuery = useMemo(() => {
    if (!acTrigger) return "";
    const rawQuery = message.slice(acTrigger.startPos + 1);
    return (acTrigger.type === "@" ? rawQuery.match(/^[\w./\\-]*/)?.[0] ?? "" : rawQuery).toLowerCase();
  }, [acTrigger, message]);

  const acItems: AcItem[] = useMemo(() => {
    if (!acTrigger) return [];
    if (acTrigger.type === "/") {
      return (skills || [])
        .filter(s => s.name.toLowerCase().includes(acQuery))
        .slice(0, 30)
        .map(s => ({ label: s.name, description: s.description, type: "skill" as string }));
    }
    if (acTrigger.type === "@") {
      const items: AcItem[] = [];
      const currentMentionItems = mentionItemsRef?.current;

      if (currentMentionItems?.length) {
        const entityMatches = currentMentionItems
          .filter(m => {
            if (!acQuery) return true;
            return m.label.toLowerCase().includes(acQuery) ||
              (m.shortId && m.shortId.toLowerCase().includes(acQuery)) ||
              (m.sublabel && m.sublabel.toLowerCase().includes(acQuery));
          })
          .slice(0, 15)
          .map(m => ({
            label: m.label,
            description: m.sublabel,
            type: m.type,
            id: m.id,
            shortId: m.shortId,
            image: m.image,
          }));
        items.push(...entityMatches);
      }

      const fileMatches = (filePathsRef.current || [])
        .filter(p => {
          const name = p.split("/").pop() || p;
          return name.toLowerCase().includes(acQuery) || p.toLowerCase().includes(acQuery);
        })
        .slice(0, 8)
        .map(p => ({ label: p, description: undefined, type: "file" as string }));
      items.push(...fileMatches);

      return items;
    }
    return [];
  }, [acTrigger, acQuery, skills]);

  const clampedAcIndex = acItems.length > 0 ? Math.min(acIndex, acItems.length - 1) : 0;

  const applyAutocomplete = useCallback((item: AcItem) => {
    if (!acTrigger) return;
    if (acTrigger.type === "/") {
      const newVal = `/${item.label} `;
      setMessage(newVal);
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = textareaRef.current.selectionEnd = newVal.length;
        }
      }, 0);
    } else {
      const before = message.slice(0, acTrigger.startPos);
      const cursorPos = textareaRef.current?.selectionStart ?? message.length;
      const after = message.slice(cursorPos);

      let inserted: string;
      if (item.type === "file" || item.type === "skill") {
        inserted = `@${item.label} `;
      } else {
        const truncTitle = item.label.length > 30 ? item.label.slice(0, 30) + "..." : item.label;
        const id = item.shortId || (item.type === "doc" ? `doc:${item.id}` : "");
        const ref = id ? `@[${truncTitle} ${id}]` : `@[${truncTitle}]`;
        inserted = `${ref} `;
      }

      const newVal = before + inserted + after;
      setMessage(newVal);
      const newCursor = before.length + inserted.length;
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = textareaRef.current.selectionEnd = newCursor;
        }
      }, 0);
    }
    setAcTrigger(null);
    setAcIndex(0);
    textareaRef.current?.focus();
  }, [acTrigger, message]);

  const messageStatus = useQuery(
    api.pendingMessages.getMessageStatus,
    pendingMessageId ? { message_id: pendingMessageId } : "skip"
  );

  const canQueryServer = isConvexId(conversationId);
  const existingPending = useQuery(
    api.pendingMessages.getConversationPendingMessage,
    canQueryServer ? { conversation_id: conversationId as Id<"conversations"> } : "skip"
  );

  const isAgentStarting = agentStatus === "starting" || agentStatus === "resuming" || deliveryStatus === "starting";
  const isAgentDelivering = agentStatus === "connected" || deliveryStatus === "connected";
  const isAgentResuming = agentStatus === "resuming";
  const stuckThresholdMs = isAgentResuming ? 120_000 : isSessionStarting || isAgentStarting ? 60_000 : isSessionReady ? 30_000 : 15_000;

  const isExistingMessageDead = existingPending?.status === "failed" || existingPending?.status === "undeliverable";

  useWatchEffect(() => {
    if (pendingMessageId) return;
    if (!existingPending) {
      if (!isWaitingForResponse) setShowStuckBanner(false);
      autoResumeTriggeredRef.current = false;
      forceRestartAttemptedRef.current = false;
      return;
    }
    const age = Date.now() - existingPending.created_at;
    // Stale pendings from old sessions are noise — only banner for recent messages
    if (age > 10 * 60_000) return;
    if (isExistingMessageDead) {
      setShowStuckBanner(true);
      return;
    }
    if (age > stuckThresholdMs) {
      setShowStuckBanner(true);
    } else {
      const timer = setTimeout(() => setShowStuckBanner(true), stuckThresholdMs - age);
      return () => clearTimeout(timer);
    }
  }, [existingPending, pendingMessageId, isWaitingForResponse, stuckThresholdMs, isExistingMessageDead]);

  // Agent actively working proves the message reached the session — clear stale stuck banner
  useWatchEffect(() => {
    if (showStuckBanner && agentStatus && (agentStatus === "thinking" || agentStatus === "working" || agentStatus === "compacting" || agentStatus === "permission_blocked")) {
      setShowStuckBanner(false);
    }
  }, [showStuckBanner, agentStatus]);

  useWatchEffect(() => {
    if (!sentAt || !pendingMessageId) return;
    if (messageStatus?.status === "delivered") {
      if (sentContentRef.current) {
        markAsQueued(conversationId, sentContentRef.current);
        sentContentRef.current = null;
      }
      setPendingMessageId(null);
      setSentAt(null);
      setShowStuckBanner(false);
      return;
    }
    const timer = setTimeout(() => {
      if (messageStatus?.status === "pending") {
        setShowStuckBanner(true);
      }
    }, stuckThresholdMs);
    return () => clearTimeout(timer);
  }, [sentAt, pendingMessageId, messageStatus?.status, conversationId, markAsQueued, stuckThresholdMs]);

  // Removed: generic 60s timeout was showing "not responding" even when no message was sent.
  // The banner should only show when we sent a message and it wasn't delivered (handled by the effects above).

  const sendRef = useRef<HTMLDivElement>(null);
  const pastedImagesRef = useRef<Array<{ file: File; previewUrl: string; storageId?: Id<"_storage">; uploading: boolean }>>([]);
  const [pastedImages, setPastedImages] = useState<Array<{ file: File; previewUrl: string; storageId?: Id<"_storage">; uploading: boolean }>>(() => {
    if (cached?.draft_image_storage_ids) {
      return (cached.draft_image_storage_ids as Array<{ storageId: string; previewUrl: string; name: string }>).map(img => ({
        file: new File([], img.name || "image"),
        previewUrl: img.previewUrl || "",
        storageId: img.storageId as Id<"_storage">,
        uploading: false,
      }));
    }
    if (cached?.draft_image_storage_id) {
      return [{ file: new File([], cached.draft_image_name || "image"), previewUrl: cached.draft_image_preview || "", storageId: cached.draft_image_storage_id, uploading: false }];
    }
    return [];
  });
  const staleImageIds = useMemo(() => {
    const ids = pastedImages
      .filter(img => img.storageId && (!img.previewUrl || img.previewUrl.startsWith("blob:")))
      .map(img => img.storageId!);
    return ids.length > 0 ? ids : null;
  }, [pastedImages]);
  const resolvedImageUrls = useQuery(
    api.images.getImageUrls,
    staleImageIds ? { storageIds: staleImageIds as Id<"_storage">[] } : "skip"
  );
  useWatchEffect(() => {
    if (!resolvedImageUrls) return;
    setPastedImages(prev => {
      const updated = prev.map(img => {
        if (img.storageId && resolvedImageUrls[img.storageId as string]) {
          return { ...img, previewUrl: resolvedImageUrls[img.storageId as string]! };
        }
        return img;
      });
      const draftImages = updated.filter(i => i.storageId).map(i => ({
        storageId: i.storageId as string, previewUrl: i.previewUrl, name: i.file.name,
      }));
      const existing = useInboxStore.getState().getDraft(conversationId);
      if (draftImages.length > 0) {
        useInboxStore.getState().setDraft(conversationId, {
          ...existing, draft_image_storage_ids: draftImages,
        });
      }
      return updated;
    });
  }, [resolvedImageUrls, conversationId]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const escapeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedImageIndex, setSelectedImageIndex] = useState<number | null>(null);
  const [lightboxImageIndex, setLightboxImageIndex] = useState<number | null>(null);
  const dismissLightbox = useCallback(() => { setLightboxImageIndex(null); textareaRef.current?.focus(); }, []);
  useWatchEffect(() => { onLightboxChange?.(lightboxImageIndex !== null); }, [lightboxImageIndex, onLightboxChange]);
  const lightboxSwipe = useSwipeToDismiss(dismissLightbox);
  const sendMessage = useMutation(api.pendingMessages.sendMessageToSession);
  const generateUploadUrl = useMutation(api.images.generateUploadUrl);
  const convex = useConvex();

  const expandMentionsInMessage = useCallback(async (text: string): Promise<string> => {
    const mentionRegex = /@\[([^\]]*?)\s+(ct-\w+|pl-\w+|jx\w+|doc:\w+)\](?:\s*\([^)]*\))?/g;
    const docMentionLegacyRegex = /@\[([^\]]*?)\](?:\s*\(cast doc read (\w+)\))/g;
    const mentions: Array<{ type: string; shortId?: string; id?: string; fullMatch: string }> = [];
    let match: RegExpExecArray | null;
    const textCopy = text;
    mentionRegex.lastIndex = 0;
    while ((match = mentionRegex.exec(textCopy)) !== null) {
      const id = match[2];
      if (id.startsWith("doc:")) {
        mentions.push({ type: "doc", id: id.slice(4), fullMatch: match[0] });
      } else {
        const type = id.startsWith("ct-") ? "task" : id.startsWith("pl-") ? "plan" : "session";
        mentions.push({ type, shortId: id, fullMatch: match[0] });
      }
    }
    docMentionLegacyRegex.lastIndex = 0;
    while ((match = docMentionLegacyRegex.exec(textCopy)) !== null) {
      if (match![2] && !mentions.some(m => m.fullMatch === match![0])) {
        mentions.push({ type: "doc", id: match![2], fullMatch: match![0] });
      }
    }
    if (mentions.length === 0) return text;
    try {
      const expanded = await convex.query(api.docs.expandMentions, {
        mentions: mentions.map(m => ({ type: m.type, shortId: m.shortId, id: m.id })),
      });
      let result = text;
      for (const m of mentions) {
        const exp = expanded.find((e: any) =>
          (m.shortId && e.shortId === m.shortId) || (m.id && e.id === m.id)
        );
        if (exp?.markdown) {
          result = result.replace(m.fullMatch, m.fullMatch + exp.markdown);
        }
      }
      return result;
    } catch {
      return text;
    }
  }, [convex]);
  pastedImagesRef.current = pastedImages;

  const waitForConvexId = useCallback(async (id: string): Promise<string> => {
    const resolved = useInboxStore.getState().getConvexId(id);
    if (resolved) return resolved;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const r = useInboxStore.getState().getConvexId(id);
      if (r) return r;
    }
    throw new Error("Session not yet created on server");
  }, []);

  useMountEffect(() => {
    return () => { if (escapeTimerRef.current) clearTimeout(escapeTimerRef.current); };
  });

  useWatchEffect(() => {
    if (onPopulateInput) {
      onPopulateInput.current = (text: string) => {
        setMessage(text);
        setTimeout(() => textareaRef.current?.select(), 0);
      };
      return () => { if (onPopulateInput) onPopulateInput.current = null; };
    }
  }, [onPopulateInput]);

  const handleForceResume = useCallback(async () => {
    if (isResuming) return;
    setIsResuming(true);
    try {
      if (isExistingMessageDead || (messageStatus?.status === "failed" || messageStatus?.status === "undeliverable")) {
        await restartSessionMutation({ conversation_id: conversationId as Id<"conversations"> });
      } else {
        await resumeSessionMutation({ conversation_id: conversationId as Id<"conversations"> });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to resume session");
      setIsResuming(false);
    }
  }, [conversationId, resumeSessionMutation, restartSessionMutation, isResuming, isExistingMessageDead, messageStatus?.status]);

  useWatchEffect(() => {
    if (isResuming && (isConversationLive || isThinking)) {
      setIsResuming(false);
      setShowStuckBanner(false);
      return;
    }
    if (!isResuming) return;
    const timeout = setTimeout(async () => {
      setIsResuming(false);
      if (!forceRestartAttemptedRef.current && conversationId && isConvexId(conversationId)) {
        forceRestartAttemptedRef.current = true;
        try {
          await restartSessionMutation({ conversation_id: conversationId as Id<"conversations"> });
          setIsResuming(true);
        } catch {
          toast.error("Session restart failed");
        }
      }
    }, 30_000);
    return () => clearTimeout(timeout);
  }, [isResuming, isConversationLive, isThinking, conversationId, restartSessionMutation]);

  useWatchEffect(() => {
    if (!showStuckBanner || !sessionId || isResuming || autoResumeTriggeredRef.current) return;
    if (!existingPending && !pendingMessageId) return;
    autoResumeTriggeredRef.current = true;
    handleForceResume();
  }, [showStuckBanner, sessionId, isResuming, existingPending, pendingMessageId, handleForceResume]);

  const updateDraft = useCallback((text: string, images?: Array<{ storageId?: string; previewUrl?: string; name?: string }> | null) => {
    if (!text && (!images || images.length === 0)) {
      useInboxStore.getState().clearDraft(conversationId);
    } else {
      useInboxStore.getState().setDraft(conversationId, {
        draft_message: text || null,
        draft_image_storage_ids: images && images.length > 0 ? images : null,
      });
    }
  }, [conversationId]);

  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveDraftSnapshot = useCallback((targetId: string) => {
    if (sendingRef.current) return;
    const msg = messageRef.current;
    const imgs = pastedImagesRef.current;
    const draftImages = imgs
      .filter(i => i.storageId && !i.uploading)
      .map(i => ({ storageId: i.storageId as string, previewUrl: i.previewUrl, name: i.file.name }));
    if (!msg && draftImages.length === 0) return;
    useInboxStore.getState().setDraft(targetId, {
      draft_message: msg || null,
      draft_image_storage_ids: draftImages.length > 0 ? draftImages : null,
    });
  }, []);

  useWatchEffect(() => {
    const keyChanged = sacredKeyRef.current !== sacredKey;
    if (keyChanged) {
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
      sacredInputs.set(sacredKeyRef.current, { text: messageRef.current });
      saveDraftSnapshot(convIdRef.current);
      sacredKeyRef.current = sacredKey;
      convIdRef.current = conversationId;
      const sacred = sacredInputs.get(sacredKey);
      const storeDraft = useInboxStore.getState().getDraft(conversationId)?.draft_message;
      const newDraft = sacred?.text ?? storeDraft ?? "";
      sacredInputs.set(sacredKey, { text: newDraft });
      _setMessage(newDraft);
    } else if (convIdRef.current !== conversationId) {
      convIdRef.current = conversationId;
    }
  }, [sacredKey, conversationId, saveDraftSnapshot]);

  useMountEffect(() => () => {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    saveDraftSnapshot(convIdRef.current);
  });

  const handleMessageChange = useCallback((val: string) => {
    setMessage(val);
    if (savedDraftRef.current !== null) {
      isSelectionEditedRef.current = true;
    }
    if (val.startsWith("/") && (skills?.length ?? 0) > 0) {
      const query = val.slice(1);
      if (!query.includes(" ")) {
        setAcTrigger({ type: "/", startPos: 0 });
        setAcIndex(0);
      } else {
        setAcTrigger(null);
      }
    } else {
      const cursorPos = textareaRef.current?.selectionStart ?? val.length;
      const textBefore = val.slice(0, cursorPos);
      const atMatch = textBefore.match(/@([\w./\\-]*)$/);
      if (atMatch) {
        setAcTrigger({ type: "@", startPos: cursorPos - atMatch[0].length });
        setAcIndex(0);
        onMentionQuery?.(atMatch[1] || "");
      } else {
        setAcTrigger(null);
        onMentionQuery?.("");
      }
    }
    if (!sendingRef.current) {
      const existing = useInboxStore.getState().getDraft(conversationId);
      useInboxStore.getState().setDraftLocal(conversationId, { ...existing, draft_message: val || null });
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      draftTimerRef.current = setTimeout(() => {
        if (sendingRef.current) return;
        const existing = useInboxStore.getState().getDraft(conversationId);
        if (!val && !existing?.draft_image_storage_ids?.length) {
          useInboxStore.getState().clearDraft(conversationId);
        } else {
          useInboxStore.getState().setDraft(conversationId, { ...existing, draft_message: val || null });
        }
      }, 300);
    }
  }, [conversationId, skills, onMentionQuery]);

  const isSelectionActive = !!(selectedMessageContent && selectedMessageUuid);
  const savedDraftRef = useRef<string | null>(null);
  const isSelectionEditedRef = useRef(false);
  const prevSelectionRef = useRef<string | null>(null);

  useWatchEffect(() => {
    const wasActive = prevSelectionRef.current !== null;
    const isActive = !!(selectedMessageContent && selectedMessageUuid);
    prevSelectionRef.current = selectedMessageUuid || null;

    if (isActive && !wasActive) {
      savedDraftRef.current = message;
      isSelectionEditedRef.current = false;
      setMessage(selectedMessageContent);
    } else if (isActive && wasActive) {
      setMessage(selectedMessageContent);
    } else if (!isActive && wasActive) {
      const restored = savedDraftRef.current ?? "";
      savedDraftRef.current = null;
      isSelectionEditedRef.current = false;
      setMessage(restored);
    }
  }, [selectedMessageContent, selectedMessageUuid]);

  const isInactive = status && status !== "active" && !pendingMessageId;
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  const [selectedQueueIndex, setSelectedQueueIndex] = useState<number | null>(null);
  const setSessionHasQueuedMessages = useInboxStore((s) => s.setSessionHasQueuedMessages);
  useWatchEffect(() => {
    setSessionHasQueuedMessages(conversationId, queuedMessages.length > 0);
    return () => setSessionHasQueuedMessages(conversationId, false);
  }, [conversationId, queuedMessages.length, setSessionHasQueuedMessages]);
  const hasContent = (composeMode ? composeHasContent : message.trim().length > 0) || pastedImages.length > 0 || queuedMessages.length > 0;
  const isExpanded = composeMode || !!onSendAndAdvance || isFocused || message.length > 0 || pastedImages.length > 0 || queuedMessages.length > 0;

  const toggleCompose = useCallback(() => {
    if (composeMode) {
      const md = composeRef.current?.getMarkdown() || "";
      setMessage(md);
      setComposeMode(false);
      setComposeHasContent(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    } else {
      setComposeMode(true);
    }
  }, [composeMode, setMessage]);

  const [isMultiline, setIsMultiline] = useState(false);
  const resetTextareaHeight = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      const sh = textareaRef.current.scrollHeight;
      textareaRef.current.style.height = sh + "px";
      setIsMultiline(sh > 36);
    }
  };

  useWatchEffect(() => {
    resetTextareaHeight();
  }, [message]);

  const mountConvIdRef = useRef(conversationId);
  useWatchEffect(() => {
    if (textareaRef.current) {
      const isIdTransition = mountConvIdRef.current !== conversationId;
      mountConvIdRef.current = conversationId;
      if (isIdTransition) {
        if (autoFocusInput) textareaRef.current.focus();
        return;
      }
      const len = textareaRef.current.value.length;
      if (len > 0) {
        textareaRef.current.focus();
        textareaRef.current.select();
      } else if (autoFocusInput) {
        textareaRef.current.focus();
      }
    }
  }, [autoFocusInput, conversationId]);

  const clearImage = useCallback((index: number) => {
    setPastedImages(prev => {
      const img = prev[index];
      if (img) URL.revokeObjectURL(img.previewUrl);
      const next = prev.filter((_, i) => i !== index);
      updateDraft(message, next.length > 0 ? next.map(i => ({ storageId: i.storageId as string, previewUrl: i.previewUrl, name: i.file.name })) : null);
      return next;
    });
  }, [updateDraft, message]);

  const clearAllImages = useCallback(() => {
    pastedImages.forEach(img => URL.revokeObjectURL(img.previewUrl));
    setPastedImages([]);
    setSelectedImageIndex(null);
    setLightboxImageIndex(null);
  }, [pastedImages]);

  const uploadImage = useCallback(async (file: File) => {
    const previewUrl = URL.createObjectURL(file);
    const placeholder = { file, previewUrl, uploading: true };
    setPastedImages(prev => [...prev, placeholder]);
    try {
      const uploadUrl = await generateUploadUrl({});
      const result = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!result.ok) throw new Error(`Upload failed: ${result.status} ${result.statusText}`);
      const { storageId } = await result.json();
      setPastedImages(prev => {
        const next = prev.map(img => img.previewUrl === previewUrl ? { ...img, storageId, uploading: false } : img);
        updateDraft(message, next.map(i => ({ storageId: i.storageId as string, previewUrl: i.previewUrl, name: i.file.name })));
        return next;
      });
    } catch (err: any) {
      console.error("[uploadImage] failed:", err);
      toast.error(err?.message?.includes("Authentication") ? "Upload failed: not authenticated" : `Failed to upload image: ${err?.message || "unknown error"}`);
      URL.revokeObjectURL(previewUrl);
      setPastedImages(prev => prev.filter(img => img.previewUrl !== previewUrl));
    }
  }, [generateUploadUrl, updateDraft, message]);

  useWatchEffect(() => {
    if (onDropFiles) {
      onDropFiles.current = (files: File[]) => {
        files.forEach(f => { if (f.type.startsWith("image/")) uploadImage(f); });
      };
      return () => { if (onDropFiles) onDropFiles.current = null; };
    }
  }, [onDropFiles, uploadImage]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    let hasImage = false;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        if (!hasImage) { e.preventDefault(); hasImage = true; }
        const file = items[i].getAsFile();
        if (file) uploadImage(file);
      }
    }
  }, [uploadImage]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAcTrigger(null);
    // In compose mode, read content from the TipTap editor
    const message = composeMode && composeRef.current
      ? composeRef.current.getMarkdown()
      : messageRef.current;
    if (onGateSend) {
      const text = message.trim();
      if (!text) return;
      sendingRef.current = true;
      if (draftTimerRef.current) { clearTimeout(draftTimerRef.current); draftTimerRef.current = null; }
      setMessage("");
      messageRef.current = "";
      useInboxStore.getState().clearDraftFinal(conversationId);
      sendingRef.current = false;
      await onGateSend(text);
      return;
    }
    if (onWorkflowLaunch) {
      const goal = message.trim();
      sendingRef.current = true;
      if (draftTimerRef.current) { clearTimeout(draftTimerRef.current); draftTimerRef.current = null; }
      setMessage("");
      messageRef.current = "";
      useInboxStore.getState().clearDraftFinal(conversationId);
      sendingRef.current = false;
      await onWorkflowLaunch(goal);
      return;
    }
    const hasUploadingImages = pastedImages.some(img => img.uploading);
    const readyImages = pastedImages.filter(img => !img.uploading && img.storageId);
    const canSend = message.trim() || readyImages.length > 0 || hasUploadingImages;
    if (!canSend) return;

    if (hasUploadingImages) {
      setIsWaitingForUpload(true);
      const waitForUploads = () => new Promise<void>((resolve) => {
        const check = () => {
          const current = pastedImagesRef.current;
          if (current.every(img => !img.uploading)) {
            resolve();
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      });
      await waitForUploads();
      setIsWaitingForUpload(false);
    }

    const finalImages = pastedImagesRef.current.filter(img => !img.uploading && img.storageId);
    const finalCanSend = message.trim() || finalImages.length > 0;
    if (!finalCanSend) return;

    // If a message is selected, fork from it then send the new content
    if (isSelectionActive && selectedMessageUuid && onForkFromMessage) {
      sendingRef.current = true;
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
      isSelectionEditedRef.current = true;
      savedDraftRef.current = null;
      const content = message.trim();
      setMessage("");
      messageRef.current = "";
      useInboxStore.getState().clearDraftFinal(conversationId);
      sendingRef.current = false;
      onClearSelection?.();
      const savedPopulateFn = onPopulateInput?.current ?? null;
      if (onPopulateInput) onPopulateInput.current = null;
      await onForkFromMessage(selectedMessageUuid);
      setTimeout(() => { if (onPopulateInput) onPopulateInput.current = savedPopulateFn; }, 200);
      const branches = useInboxStore.getState().activeBranches;
      const forkId = Object.values(branches)[0];
      if (!forkId) {
        addOptimistic(conversationId, content);
        toast.error("Fork not ready — message saved locally");
        return;
      }
      const clientId = addOptimistic(forkId, content);
      onMessageSent?.();
      try {
        const resolvedId = await waitForConvexId(forkId);
        const msgId = await sendMessage({
          conversation_id: resolvedId as Id<"conversations">,
          content,
          client_id: clientId,
        });
        setPendingMessageId(msgId);
        setSentAt(Date.now());
        sentContentRef.current = content;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to send rewrite");
      }
      return;
    }

    const targetConvId = conversationId;
    const targetCanQuery = canQueryServer;
    const trimmed = message.trim() || (finalImages.length > 0 ? "[image]" : "");
    const storageIds = finalImages.map(img => img.storageId!);
    const optimisticImages = finalImages.map(img => ({ media_type: img.file.type, storage_id: img.storageId as string }));
    sendingRef.current = true;
    if (isInactive) setOptimisticSending(true);
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    const clientId = addOptimistic(targetConvId, trimmed, optimisticImages.length > 0 ? optimisticImages : undefined);
    soundSend();
    setMessage("");
    messageRef.current = "";
    setSelectedQueueIndex(null);
    clearAllImages();
    useInboxStore.getState().clearDraftFinal(targetConvId);
    if (composeMode) { composeRef.current?.clear(); setComposeMode(false); setComposeHasContent(false); }
    sendingRef.current = false;
    requestAnimationFrame(() => textareaRef.current?.focus());
    onMessageSent?.();

    const expandedContent = await expandMentionsInMessage(trimmed);

    try {
      const resolvedId = targetCanQuery ? targetConvId : await waitForConvexId(targetConvId);
      const msgId = await sendMessage({
        conversation_id: resolvedId as Id<"conversations">,
        content: expandedContent,
        image_storage_ids: storageIds.length > 0 ? storageIds : undefined,
        client_id: clientId,
      });
      setPendingMessageId(msgId);
      setOptimisticSending(false);
      setSentAt(Date.now());
      sentContentRef.current = trimmed;
      setShowStuckBanner(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send message");
      useInboxStore.getState().markOptimisticAsFailed(targetConvId, clientId);
      setOptimisticSending(false);
    }
  };

  const queueDrainingRef = useRef(false);
  useWatchEffect(() => {
    if (queuedMessages.length === 0 || queueDrainingRef.current) return;
    const isIdle = agentStatus === "idle" || (!agentStatus && !isWaitingForResponse && !isThinking && !isConversationLive && !isSessionStarting);
    if (!isIdle) return;
    queueDrainingRef.current = true;
    const queueTargetConvId = conversationId;
    const queueCanQuery = canQueryServer;
    const next = queuedMessages[0];
    setQueuedMessages(prev => prev.slice(1));
    setSelectedQueueIndex(null);
    const clientId = addOptimistic(queueTargetConvId, next);
    soundSend();
    onMessageSent?.();
    (async () => {
      try {
        const expanded = await expandMentionsInMessage(next);
        const resolvedId = queueCanQuery ? queueTargetConvId : await waitForConvexId(queueTargetConvId);
        const msgId = await sendMessage({
          conversation_id: resolvedId as Id<"conversations">,
          content: expanded,
          client_id: clientId,
        });
        setPendingMessageId(msgId);
        setSentAt(Date.now());
        sentContentRef.current = next;
        setShowStuckBanner(false);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to send queued message");
        useInboxStore.getState().markOptimisticAsFailed(queueTargetConvId, clientId);
      } finally {
        queueDrainingRef.current = false;
      }
    })();
  }, [queuedMessages, agentStatus, isWaitingForResponse, isThinking, isConversationLive, isSessionStarting, conversationId, canQueryServer]);

  const flashModeLabel = useCallback(() => {
    setShowModeLabel(true);
    if (modeLabelTimerRef.current) clearTimeout(modeLabelTimerRef.current);
    modeLabelTimerRef.current = setTimeout(() => setShowModeLabel(false), 1500);
  }, []);

  const acScrollRef = useRef(false);
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (acTrigger && acItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        acScrollRef.current = true;
        setAcIndex(i => Math.min(i + 1, acItems.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        acScrollRef.current = true;
        setAcIndex(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        applyAutocomplete(acItems[clampedAcIndex]);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        applyAutocomplete(acItems[clampedAcIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setAcTrigger(null);
        return;
      }
    }
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      onCycleMode?.();
      flashModeLabel();
      return;
    }

    if (selectedImageIndex !== null && pastedImages.length > 0) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        const next = Math.max(0, selectedImageIndex - 1);
        setSelectedImageIndex(next);
        if (lightboxImageIndex !== null) setLightboxImageIndex(next);
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        if (selectedImageIndex < pastedImages.length - 1) {
          const next = selectedImageIndex + 1;
          setSelectedImageIndex(next);
          if (lightboxImageIndex !== null) setLightboxImageIndex(next);
        } else {
          setSelectedImageIndex(null);
          setLightboxImageIndex(null);
        }
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        const nextIdx = pastedImages.length <= 1 ? null : Math.min(selectedImageIndex, pastedImages.length - 2);
        clearImage(selectedImageIndex);
        setSelectedImageIndex(nextIdx);
        if (lightboxImageIndex === selectedImageIndex) setLightboxImageIndex(nextIdx);
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setLightboxImageIndex(lightboxImageIndex === selectedImageIndex ? null : selectedImageIndex);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (lightboxImageIndex !== null) {
          setLightboxImageIndex(null);
        } else {
          setSelectedImageIndex(null);
        }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedImageIndex(null);
        setLightboxImageIndex(null);
        return;
      }
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        setSelectedImageIndex(null);
      }
    }

    if (selectedQueueIndex !== null && queuedMessages.length > 0) {
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedQueueIndex(Math.max(0, selectedQueueIndex - 1));
        return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        if (selectedQueueIndex < queuedMessages.length - 1) {
          setSelectedQueueIndex(selectedQueueIndex + 1);
        } else {
          setSelectedQueueIndex(null);
          textareaRef.current?.focus();
        }
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        setQueuedMessages(prev => prev.filter((_, i) => i !== selectedQueueIndex));
        const newLen = queuedMessages.length - 1;
        if (newLen === 0) {
          setSelectedQueueIndex(null);
          textareaRef.current?.focus();
        } else {
          setSelectedQueueIndex(Math.min(selectedQueueIndex, newLen - 1));
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedQueueIndex(null);
        textareaRef.current?.focus();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const text = queuedMessages[selectedQueueIndex];
        setQueuedMessages(prev => prev.filter((_, i) => i !== selectedQueueIndex));
        setSelectedQueueIndex(null);
        setMessage(text);
        requestAnimationFrame(() => textareaRef.current?.focus());
        return;
      }
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        setSelectedQueueIndex(null);
      }
    }

    if (e.key === "ArrowUp" && pastedImages.length > 0) {
      const textarea = textareaRef.current;
      if (textarea && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
        e.preventDefault();
        setSelectedImageIndex(pastedImages.length - 1);
        return;
      }
    }

    if (e.key === "ArrowUp" && queuedMessages.length > 0 && selectedImageIndex === null) {
      const textarea = textareaRef.current;
      if (textarea && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
        e.preventDefault();
        setSelectedQueueIndex(queuedMessages.length - 1);
        return;
      }
    }

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      const hasText = messageRef.current.trim().length > 0;
      if (escapeTimerRef.current) {
        clearTimeout(escapeTimerRef.current);
        escapeTimerRef.current = null;
        if (hasText) { setMessage(""); } else if (queuedMessages.length > 0) { setQueuedMessages([]); setSelectedQueueIndex(null); } else { onOpenNavigator?.(); }
      } else {
        if (hasText) {
          escapeTimerRef.current = setTimeout(() => { escapeTimerRef.current = null; }, 250);
        } else if (queuedMessages.length > 0) {
          escapeTimerRef.current = setTimeout(() => { escapeTimerRef.current = null; }, 250);
        } else {
          escapeTimerRef.current = setTimeout(() => { escapeTimerRef.current = null; onSendEscape?.(); }, 250);
        }
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      toggleCompose();
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const text = message.trim();
      if (text) {
        sendingRef.current = true;
        if (draftTimerRef.current) { clearTimeout(draftTimerRef.current); draftTimerRef.current = null; }
        setQueuedMessages(prev => [...prev, text]);
        setMessage("");
        messageRef.current = "";
        useInboxStore.getState().clearDraftFinal(conversationId);
        sendingRef.current = false;
        setSelectedQueueIndex(null);
      }
      return;
    }
    if (e.key === "Enter" && e.altKey && e.shiftKey && onSendAndDismiss) {
      e.preventDefault();
      handleSubmit(e).then(() => onSendAndDismiss());
      return;
    }
    if (e.key === "Enter" && e.altKey && !e.shiftKey && onSendAndAdvance) {
      e.preventDefault();
      handleSubmit(e).then(() => onSendAndAdvance());
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const canSubmit = hasContent && !isWaitingForUpload;

  return (
    <div className={`shrink-0 pointer-events-none sticky bottom-0 ${lightboxImageIndex !== null ? "z-[10002]" : "z-10"}`}>
      {lightboxImageIndex === null && <div className="h-16 bg-gradient-to-t from-sol-bg via-sol-bg/80 to-transparent -mt-16 relative" />}
      <div className={`pb-4 pointer-events-auto ${lightboxImageIndex === null ? "bg-sol-bg" : ""}`}>
        <div className="relative">
          {(isFocused || shortcutTooltip || showStuckBanner || isSessionStarting || isSessionReady || isInactive || optimisticSending || isSessionDisconnected || (pendingMessageId || existingPending) || (agentStatus && agentStatus !== "idle") || (!agentStatus && (isWaitingForResponse || isThinking || isConversationLive))) && (
            <div className={`mx-auto px-4 mb-1 flex justify-between items-center ${isExpanded ? "max-w-7xl" : "max-w-md"} ${lightboxImageIndex !== null ? "hidden" : ""}`}>
              <p className="text-[11px] text-sol-text-dim/70 pl-1">
                {((isSessionStarting && !agentStatus) || isAgentStarting) && !showStuckBanner ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sol-cyan/50 animate-pulse" />
                    Starting session...
                  </span>
                ) : (pendingMessageId || existingPending) && !showStuckBanner && (isAgentStarting || isAgentDelivering) ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sol-cyan/50 animate-pulse" />
                    {agentStatus === "resuming" ? "Resuming session..." : isAgentStarting ? "Starting session..." : "Delivering..."}
                  </span>
                ) : (pendingMessageId || existingPending) && !showStuckBanner && !agentStatus ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sol-cyan/50 animate-pulse" />
                    Processing...
                  </span>
                ) : isSessionReady && !showStuckBanner && (!agentStatus || agentStatus === "idle" || agentStatus === "connected") ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-400" />
                    Ready
                  </span>
                ) : showStuckBanner && sessionId ? (
                  isResuming ? (
                    isSessionStarting ? (
                      <span className="flex items-center gap-1.5 text-sol-cyan">
                        <span className="w-2 h-2 rounded-full bg-sol-cyan/50 animate-pulse" />
                        Starting session — waiting for agent to connect...
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-sol-yellow">
                        <span className="w-2 h-2 rounded-full bg-sol-yellow animate-pulse" />
                        Waiting for connection…
                      </span>
                    )
                  ) : (
                    <span className="flex items-center gap-1.5 text-sol-orange">
                      <span className="w-2 h-2 rounded-full bg-sol-orange" />
                      {isExistingMessageDead || messageStatus?.status === "undeliverable"
                        ? "Message undeliverable — session lost"
                        : (existingPending || pendingMessageId)
                          ? `Message not reaching session${messageStatus?.retry_count ? ` (retry ${messageStatus.retry_count})` : ""}`
                          : "Session not responding"}
                      <button
                        type="button"
                        onClick={handleForceResume}
                        className="ml-1 px-1.5 py-0.5 rounded bg-sol-orange/10 hover:bg-sol-orange/20 border border-sol-orange/30 text-sol-orange transition-colors text-[10px]"
                      >
                        {isExistingMessageDead || messageStatus?.status === "undeliverable" || messageStatus?.status === "failed" ? "Restart & retry" : "Force resume"}
                      </button>
                    </span>
                  )
                ) : agentStatus === "thinking" ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sol-violet/50 animate-pulse" />
                    Thinking...
                  </span>
                ) : agentStatus === "compacting" ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-amber-400/60 animate-pulse" />
                    Compacting...
                  </span>
                ) : agentStatus === "permission_blocked" ? (
                  <span className="flex items-center gap-1.5 text-sol-orange">
                    <span className="w-2 h-2 rounded-full bg-sol-orange animate-pulse" />
                    {(pendingPermissionsCount ?? 0) > 0 ? "Permission needed" : hasAskUserQuestion ? "Answer needed" : "Needs input"}
                  </span>
                ) : agentStatus === "connected" ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sol-cyan/50 animate-pulse" />
                    Connected
                  </span>
                ) : agentStatus === "working" ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    Working
                  </span>
                ) : agentStatus === "idle" && queuedMessages.length > 0 ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sol-cyan/50 animate-pulse" />
                    Sending queued ({queuedMessages.length})...
                  </span>
                ) : agentStatus === "idle" || agentStatus === "connected" ? (
                  "\u00A0"
                ) : isThinking ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sol-violet/50 animate-pulse" />
                    Thinking...
                  </span>
                ) : isWaitingForResponse ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sol-cyan/50 animate-pulse" />
                    Connecting...
                  </span>
                ) : isConversationLive ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    Working
                  </span>
                ) : isSessionDisconnected ? (
                  isResuming ? (
                    <span className="flex items-center gap-1.5 text-sol-text-dim">
                      <span className="w-2 h-2 rounded-full bg-sol-text-dim animate-pulse" />
                      Restarting...
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-sol-text-dim/50">
                      <span className="w-2 h-2 rounded-full bg-sol-text-dim/30" />
                      Session idle
                    </span>
                  )
                ) : optimisticSending ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sol-cyan/50 animate-pulse" />
                    Resuming session...
                  </span>
                ) : isInactive ? "Session idle — message to resume" : "\u00A0"}
              </p>
              <div className="flex items-center gap-2">
                <CyclingShortcutHint />
                <button
                  type="button"
                  onClick={() => {
                    const rect = sendRef.current?.getBoundingClientRect();
                    if (rect) setShortcutTooltip(prev => prev ? null : { x: rect.right, y: rect.top });
                  }}
                  onMouseEnter={() => {
                    clearTimeout((window as any).__shortcutTooltipTimer);
                    const rect = sendRef.current?.getBoundingClientRect();
                    if (rect) setShortcutTooltip({ x: rect.right, y: rect.top });
                  }}
                  onMouseLeave={() => {
                    (window as any).__shortcutTooltipTimer = setTimeout(() => {
                      if (!document.querySelector('[data-shortcut-tooltip]:hover')) setShortcutTooltip(null);
                    }, 150);
                  }}
                  className="text-[9px] text-sol-text-dim hover:text-sol-text transition-colors w-4 h-4 flex items-center justify-center rounded-full border border-sol-text-dim/50 hover:border-sol-text-dim bg-sol-bg-alt font-semibold"
                >
                  ?
                </button>
                {permissionMode && (
                  <div className="relative">
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { onCycleMode?.(); flashModeLabel(); }}
                      onMouseEnter={() => setModeTooltip(true)}
                      onMouseLeave={() => setModeTooltip(false)}
                      className="flex items-center gap-1.5"
                    >
                      <div className={`w-2 h-2 rounded-full transition-colors ${
                        permissionMode === "plan" ? "bg-sol-blue" :
                        permissionMode === "acceptEdits" ? "bg-emerald-400" :
                        permissionMode === "bypassPermissions" ? "bg-orange-500" :
                        permissionMode === "dontAsk" ? "bg-sol-yellow" :
                        "bg-sol-base00/50"
                      }`} />
                      {permissionMode !== "default" && (
                        <span
                          className={`text-[10px] font-mono transition-all duration-300 ease-out overflow-hidden whitespace-nowrap ${
                            showModeLabel ? "max-w-[80px] opacity-100 translate-x-0" : "max-w-0 opacity-0 -translate-x-1"
                          } ${
                            permissionMode === "plan" ? "text-sol-blue" :
                            permissionMode === "acceptEdits" ? "text-emerald-400" :
                            permissionMode === "bypassPermissions" ? "text-orange-500" :
                            "text-sol-yellow"
                          }`}
                        >
                          {permissionMode === "plan" ? "plan" :
                           permissionMode === "acceptEdits" ? "auto-edit" :
                           permissionMode === "bypassPermissions" ? "bypass" :
                           permissionMode === "dontAsk" ? "don't ask" :
                           permissionMode}
                        </span>
                      )}
                    </button>
                    {modeTooltip && (
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 rounded bg-sol-bg border border-sol-border/60 shadow-lg whitespace-nowrap text-[10px] pointer-events-none flex items-center gap-1.5">
                        <span className={
                          permissionMode === "plan" ? "text-sol-blue" :
                          permissionMode === "acceptEdits" ? "text-emerald-400" :
                          permissionMode === "bypassPermissions" ? "text-orange-500" :
                          permissionMode === "dontAsk" ? "text-sol-yellow" :
                          "text-sol-text-dim"
                        }>
                          {permissionMode === "default" ? "default" :
                           permissionMode === "plan" ? "plan mode" :
                           permissionMode === "acceptEdits" ? "accept edits" :
                           permissionMode === "bypassPermissions" ? "bypass permissions" :
                           permissionMode === "dontAsk" ? "don't ask" :
                           permissionMode}
                        </span>
                        <span className="text-sol-text-dim/50">(Shift+Tab)</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
          {acTrigger && acItems.length > 0 && (() => {
            const typeConfig: Record<string, { icon: typeof User; color: string; label: string }> = {
              person: { icon: User, color: "text-sol-green", label: "People" },
              task: { icon: CheckSquare, color: "text-sol-yellow", label: "Tasks" },
              doc: { icon: FileText, color: "text-sol-cyan", label: "Docs" },
              session: { icon: MessageSquare, color: "text-sol-blue", label: "Sessions" },
              plan: { icon: MapIcon, color: "text-sol-violet", label: "Plans" },
              file: { icon: FolderOpen, color: "text-sol-base01", label: "Files" },
              skill: { icon: Hash, color: "text-sol-orange", label: "Commands" },
            };
            const grouped: Array<{ type: string; items: typeof acItems; startIdx: number }> = [];
            let idx = 0;
            for (const item of acItems) {
              let group = grouped.find(g => g.type === item.type);
              if (!group) { group = { type: item.type, items: [], startIdx: idx }; grouped.push(group); }
              group.items.push(item);
              idx++;
            }
            return (
              <div ref={acRef} className={`mx-auto px-2 sm:px-4 mb-1 ${isExpanded ? "max-w-7xl" : "max-w-md"}`}>
                <div className="bg-sol-bg border border-sol-border/50 rounded-lg shadow-xl py-1.5 max-h-[320px] overflow-y-auto">
                  {grouped.map(group => {
                    const config = typeConfig[group.type] || typeConfig.doc;
                    const GIcon = config.icon;
                    return (
                      <div key={group.type}>
                        <div className="px-3 py-1.5 flex items-center gap-1.5">
                          <GIcon className={`w-3 h-3 ${config.color}`} />
                          <span className="text-[10px] font-medium uppercase tracking-wider text-sol-text-dim">{config.label}</span>
                        </div>
                        {group.items.map((item, i) => {
                          const globalIdx = group.startIdx + i;
                          const isSelected = globalIdx === clampedAcIndex;
                          return (
                            <button
                              key={item.id || item.label}
                              type="button"
                              ref={isSelected ? (el) => { if (el && acScrollRef.current) { el.scrollIntoView({ block: "nearest" }); acScrollRef.current = false; } } : undefined}
                              onMouseEnter={() => setAcIndex(globalIdx)}
                              onMouseDown={(e) => { e.preventDefault(); applyAutocomplete(item); }}
                              className={`w-full text-left px-3 py-1.5 flex items-center gap-2.5 transition-colors ${isSelected ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt"}`}
                            >
                              {item.image ? (
                                <img src={item.image} alt="" className="w-5 h-5 rounded-full object-cover flex-shrink-0" />
                              ) : (
                                <Hash className={`w-3.5 h-3.5 flex-shrink-0 ${config.color} opacity-60`} />
                              )}
                              <span className="text-sm flex-shrink-0">
                                {item.type === "file" ? (item.label.split("/").pop() || item.label) : item.type === "skill" ? `/${item.label}` : item.label}
                              </span>
                              {item.type === "file" && (
                                <span className="text-[11px] text-sol-text-dim font-mono flex-shrink-0 truncate max-w-[50%]">{item.label.replace(/\/[^/]+$/, "")}</span>
                              )}
                              {item.type !== "file" && item.description && (
                                <span className="text-[11px] text-sol-text-dim font-mono truncate">{item.description}</span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
          <form onSubmit={handleSubmit} className={`mx-auto px-2 sm:px-4 transition-all duration-200 ease-out ${isExpanded ? "max-w-7xl" : "max-w-md"}`}>
            <div className={`flex flex-col border px-4 py-2 shadow-lg transition-all duration-300 ${isExpanded ? "rounded-2xl" : "rounded-full"} ${composeMode ? "min-h-[40vh]" : ""} bg-sol-bg-alt ${isSelectionActive ? "border-sol-cyan/40 ring-1 ring-sol-cyan/20" : composeMode ? "border-sol-cyan/20" : "border-sol-border"}`}>
              {isSelectionActive && (
                <div className="flex items-center gap-2 pb-1.5 mb-1.5 border-b border-sol-cyan/20 text-[10px] text-sol-cyan">
                  <span className="font-medium">Rewriting message</span>
                  <span className="text-sol-text-dim">Enter to fork &amp; send</span>
                  <span className="text-sol-text-dim">Esc to cancel</span>
                </div>
              )}
              {queuedMessages.length > 0 && (
                <div className="flex flex-col gap-1 pb-2 mb-2 border-b border-sol-border/50">
                  {queuedMessages.map((qMsg, idx) => (
                    <div
                      key={idx}
                      className={`group flex items-center gap-1.5 px-2 py-1 rounded text-[11px] cursor-pointer transition-colors ${
                        selectedQueueIndex === idx
                          ? "bg-sol-blue/15 border border-sol-blue/40 text-sol-text"
                          : "bg-sol-bg/50 border border-sol-border/30 text-sol-text-secondary hover:border-sol-border/60"
                      }`}
                      onClick={() => {
                        setSelectedQueueIndex(selectedQueueIndex === idx ? null : idx);
                        textareaRef.current?.focus();
                      }}
                    >
                      <span className="text-sol-text-dim text-[9px] font-mono shrink-0">{idx + 1}</span>
                      <span className="truncate flex-1 font-mono">{qMsg}</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setQueuedMessages(prev => prev.filter((_, i) => i !== idx));
                          if (selectedQueueIndex === idx) setSelectedQueueIndex(null);
                          else if (selectedQueueIndex !== null && selectedQueueIndex > idx) setSelectedQueueIndex(selectedQueueIndex - 1);
                        }}
                        className="shrink-0 w-4 h-4 flex items-center justify-center rounded text-sol-text-dim hover:text-sol-text opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                  {selectedQueueIndex !== null && (
                    <span className="text-[9px] text-sol-text-dim flex items-center gap-2 pl-1">
                      <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/50 text-sol-text-secondary font-mono text-[8px]">&uarr;&darr;</kbd> navigate</span>
                      <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/50 text-sol-text-secondary font-mono text-[8px]">Del</kbd> remove</span>
                      <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/50 text-sol-text-secondary font-mono text-[8px]">Enter</kbd> edit</span>
                      <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/50 text-sol-text-secondary font-mono text-[8px]">Esc</kbd> deselect</span>
                    </span>
                  )}
                </div>
              )}
              {pastedImages.length > 0 && (
                <div className="flex items-center gap-2 pb-2 mb-2 border-b border-sol-border/50 flex-wrap">
                  {pastedImages.map((img, idx) => (
                    <div
                      key={idx}
                      className="relative group cursor-pointer"
                      onClick={() => {
                        setSelectedImageIndex(idx);
                        setLightboxImageIndex(idx);
                        textareaRef.current?.focus();
                      }}
                    >
                      <div className={`relative h-16 w-16 rounded-lg overflow-hidden bg-sol-bg shrink-0 transition-all ${selectedImageIndex === idx ? "ring-2 ring-sol-blue ring-offset-1 ring-offset-sol-bg" : ""}`}>
                        <img src={img.previewUrl} alt="Pasted" className="h-full w-full object-cover" />
                        {img.uploading && (
                          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                            <svg className="w-5 h-5 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                            </svg>
                          </div>
                        )}
                      </div>
                      <button type="button" onClick={(e) => { e.stopPropagation(); clearImage(idx); if (selectedImageIndex === idx) { setSelectedImageIndex(null); setLightboxImageIndex(null); } }} className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-sol-bg-alt border border-sol-border flex items-center justify-center text-sol-text-secondary hover:text-sol-text transition-colors opacity-0 group-hover:opacity-100">
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                  {selectedImageIndex !== null && (
                    <span className="text-[10px] text-sol-text-dim ml-1 flex items-center gap-2">
                      <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/50 text-sol-text-secondary font-mono text-[9px]">&larr;&rarr;</kbd> navigate</span>
                      <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/50 text-sol-text-secondary font-mono text-[9px]">Space</kbd> preview</span>
                      <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/50 text-sol-text-secondary font-mono text-[9px]">Del</kbd> remove</span>
                      <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/50 text-sol-text-secondary font-mono text-[9px]">Esc</kbd> exit</span>
                    </span>
                  )}
                </div>
              )}
              {composeMode ? (
                <div className="flex flex-col flex-1 min-h-0">
                  <div className="flex-1 min-h-0 overflow-y-auto">
                    <ComposeEditor
                      ref={composeRef}
                      initialContent={message}
                      onMentionQuery={composeMentionQuery}
                      onImagePaste={uploadImage}
                      onSubmit={() => handleSubmit({ preventDefault: () => {} } as any)}
                      onExit={toggleCompose}
                      onContentChange={setComposeHasContent}
                      placeholder="Compose your message... / for commands, @ to mention"
                    />
                  </div>
                  <div className="flex items-center justify-between pt-2 mt-1 border-t border-sol-border/20">
                    <span className="text-[10px] text-sol-text-dim/50 select-none">
                      {navigator.platform?.includes("Mac") ? "Cmd" : "Ctrl"}+Enter send &middot; Esc collapse
                    </span>
                    <div ref={sendRef} className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={toggleCompose}
                        className="w-7 h-7 rounded-full transition-colors flex items-center justify-center text-sol-text-dim hover:text-sol-text hover:bg-sol-bg/50"
                        title="Collapse editor (Cmd+Shift+E)"
                      >
                        <Minimize2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="submit"
                        disabled={!canSubmit}
                        className={`w-8 h-8 rounded-full transition-colors flex items-center justify-center border ${!canSubmit ? "border-sol-border/30 text-sol-text-dim/25 cursor-not-allowed" : "border-sol-blue/50 bg-sol-blue/20 text-sol-blue hover:bg-sol-blue/30 hover:border-sol-blue hover:text-sol-blue"}`}
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5M5 12l7-7 7 7" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-end gap-2">
                  <textarea
                    ref={textareaRef}
                    data-chat-input
                    data-draft-conv={conversationId}
                    value={message}
                    onChange={(e) => handleMessageChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    onFocus={() => setIsFocused(true)}
                    onBlur={() => { setIsFocused(false); setAcTrigger(null); }}
                    disabled={isWaitingForUpload}
                    placeholder={onGateSend ? "Send a message to continue the workflow..." : onWorkflowLaunch ? "Goal override (optional) — press send to run workflow..." : agentStatus === "permission_blocked" ? ((pendingPermissionsCount ?? 0) > 0 ? "Approve or deny permission to continue..." : hasAskUserQuestion ? "Answer the question to continue..." : "Send a message...") : "Send a message..."}
                    rows={1}
                    className={`flex-1 bg-transparent text-sm placeholder:text-sol-text-dim focus:outline-none disabled:opacity-50 resize-none overflow-hidden leading-relaxed py-1 ${isSelectionActive && !isSelectionEditedRef.current ? "text-sol-text-dim italic" : "text-sol-text"}`}
                  />
                  <div ref={sendRef} className="shrink-0 flex items-end gap-1">
                    {isMultiline && (
                      <button
                        type="button"
                        onClick={toggleCompose}
                        className="w-7 h-7 mb-0.5 rounded-full transition-all flex items-center justify-center text-sol-text-dim/30 hover:text-sol-text-dim hover:bg-sol-bg/50"
                        title="Expand editor (Cmd+Shift+E)"
                      >
                        <Maximize2 className="w-3 h-3" />
                      </button>
                    )}
                    <button
                      type="submit"
                      disabled={!canSubmit}
                      className={`w-8 h-8 rounded-full transition-colors flex items-center justify-center border ${!canSubmit ? "border-sol-border/30 text-sol-text-dim/25 cursor-not-allowed" : "border-sol-blue/50 bg-sol-blue/20 text-sol-blue hover:bg-sol-blue/30 hover:border-sol-blue hover:text-sol-blue"}`}
                    >
                      {isWaitingForUpload ? (
                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5M5 12l7-7 7 7" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </form>
        </div>
      </div>
      {shortcutTooltip && createPortal(
        <div
          data-shortcut-tooltip
          className="fixed z-[10000] bg-sol-bg border border-sol-border/60 rounded-lg shadow-lg p-3 w-56"
          style={{ top: shortcutTooltip.y - 30, left: shortcutTooltip.x, transform: 'translate(-100%, -100%)' }}
          onMouseEnter={() => clearTimeout((window as any).__shortcutTooltipTimer)}
          onMouseLeave={() => {
            (window as any).__shortcutTooltipTimer = setTimeout(() => setShortcutTooltip(null), 150);
          }}
        >
          <div className="text-[10px] font-medium text-sol-text/80 mb-2">Keyboard Shortcuts</div>
          <div className="space-y-1.5 text-[9px] text-sol-text-dim/70">
            <ShortcutHint keys={["Cmd", "K"]} label="Command palette" />
            <ShortcutHint keys={["Ctrl", "I"]} label="Jump to needs input" />
            <ShortcutHint keys={["Ctrl", "J"]} label="Next session" />
            <ShortcutHint keys={["Ctrl", "K"]} label="Previous session" />
            <ShortcutHint keys={["Ctrl", "Tab"]} label="MRU next" />
            <ShortcutHint keys={["Shift", "Ctrl", "Tab"]} label="MRU previous" />
            <ShortcutHint keys={["Shift", "←"]} label="Defer session" />
            <ShortcutHint keys={["Ctrl", "←"]} label="Dismiss session" />
            <ShortcutHint keys={["Esc"]} label="Escape to session" />
            <ShortcutHint keys={["Esc", "Esc"]} label="Send escape" />
            <ShortcutHint keys={["Cmd", "Shift", "C"]} label="Collapse tool blocks" />
            <ShortcutHint keys={["Ctrl", "."]} label="Zen mode" />
            <ShortcutHint keys={["Shift", "Tab"]} label="Cycle CC mode" />
            <ShortcutHint keys={["Cmd", "Shift", "L"]} label="Copy link" />
            <div className="border-t border-sol-border/20 my-1.5" />
            <ShortcutHint keys={["Cmd", "Shift", "E"]} label="Compose mode" />
            <ShortcutHint keys={["Shift", "Enter"]} label="New line" />
            <ShortcutHint keys={["Ctrl", "Enter"]} label="Queue message" />
            <ShortcutHint keys={["Alt", "Enter"]} label="Reply and advance" />
            <ShortcutHint keys={["Alt", "Shift", "Enter"]} label="Reply and dismiss" />
            <ShortcutHint keys={["Enter"]} label="Send message" />
            <div className="border-t border-sol-border/20 mt-1.5 pt-1.5">
              <button
                onClick={() => { setShortcutTooltip(null); useInboxStore.getState().toggleShortcutsPanel(); }}
                className="text-sol-cyan/80 hover:text-sol-cyan transition-colors flex items-center gap-1"
              >
                <Keyboard className="w-3 h-3" /> View all shortcuts
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {lightboxImageIndex !== null && pastedImages[lightboxImageIndex] && createPortal(
        <div className="fixed inset-0 z-[10001] flex items-center justify-center" style={{ backgroundColor: `rgba(0,0,0,${0.8 * lightboxSwipe.backdropOpacity})` }}>
          <div className="absolute inset-0" onClick={dismissLightbox} />
          <div className="relative" onClick={(e) => e.stopPropagation()} style={lightboxSwipe.style} {...lightboxSwipe.handlers}>
            <img
              src={pastedImages[lightboxImageIndex].previewUrl}
              alt="Image preview"
              className="max-w-[85vw] max-h-[70vh] object-contain rounded-lg shadow-2xl"
            />
            {pastedImages.length > 1 && (
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
                {pastedImages.map((_, i) => (
                  <div key={i} className={`w-1.5 h-1.5 rounded-full transition-colors ${i === lightboxImageIndex ? "bg-white" : "bg-white/30"}`} />
                ))}
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
});

const CC_MODE_ORDER = ["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk"];

export const ConversationView = forwardRef<ConversationViewHandle, ConversationViewProps>(
  function ConversationView({ conversation, commits = [], pullRequests = [], backHref, backLabel = "Back", headerExtra, headerLeft, headerEnd, hasMoreAbove, hasMoreBelow, isLoadingOlder, isLoadingNewer, onLoadOlder, onLoadNewer, onJumpToStart, onJumpToEnd, onJumpToTimestamp, highlightQuery: propHighlightQuery, onClearHighlight: propClearHighlight, embedded, showMessageInput = true, targetMessageId, isOwner = true, onSendAndAdvance, onSendAndDismiss, autoFocusInput, fallbackStickyContent, onBack, subHeaderContent, hideHeader }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [userScrolled, _setUserScrolled] = useState(false);
  const userScrolledRef = useRef(false);
  const setUserScrolled = useCallback((v: boolean) => { userScrolledRef.current = v; _setUserScrolled(v); }, []);
  const [isNearTop, setIsNearTop] = useState(true);
  const [isScrollable, setIsScrollable] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [expandedSequences, setExpandedSequences] = useState<Set<string>>(new Set());
  const [diffExpanded, setDiffExpanded] = useState(false);
  const convex = useConvex();
  const convexConvId = conversation?._id && isConvexId(conversation._id) ? conversation._id as Id<"conversations"> : undefined;
  const gitDiffData = useQuery(
    api.conversations.getConversationGitDiff,
    diffExpanded && convexConvId ? { conversation_id: convexConvId } : "skip"
  );
  const renamingSessionId = useInboxStore((s) => s.renamingSessionId);
  const isRenaming = renamingSessionId === conversation?._id;
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  useWatchEffect(() => {
    if (isRenaming) {
      setRenameDraft(cleanTitle(conversation?.title || ""));
      setTimeout(() => renameInputRef.current?.select(), 0);
    }
  }, [isRenaming]);
  const [commentMessageId, setCommentMessageId] = useState<Id<"messages"> | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [allMatchingMessageIds, setAllMatchingMessageIds] = useState<string[]>([]);
  const [matchInstances, setMatchInstances] = useState<{ messageId: string; localIndex: number; timestamp: number }[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [isLocalSearchOpen, setIsLocalSearchOpen] = useState(false);
  const [localSearchQuery, setLocalSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [navTrigger, setNavTrigger] = useState(0);
  const localSearchInputRef = useRef<HTMLInputElement>(null);
  useWatchEffect(() => {
    if (!localSearchQuery) { setDebouncedSearchQuery(""); return; }
    const timer = setTimeout(() => setDebouncedSearchQuery(localSearchQuery), 300);
    return () => clearTimeout(timer);
  }, [localSearchQuery]);
  const highlightQuery = isLocalSearchOpen ? (debouncedSearchQuery || undefined) : propHighlightQuery;
  const onClearHighlight = useCallback(() => {
    if (isLocalSearchOpen) {
      setIsLocalSearchOpen(false);
      setLocalSearchQuery("");
      setDebouncedSearchQuery("");
    } else {
      propClearHighlight?.();
    }
  }, [isLocalSearchOpen, propClearHighlight]);
  const scrollAnchorRef = useRef<number | null>(null); // savedScrollHeight before a loadOlder
  const prevTimelineLengthRef = useRef<number>(0);
  const isNearBottomRef = useRef(true);
  const scrollToBottomFnRef = useRef<() => void>(() => {});
  const lastScrollTopRef = useRef(0);
  const scrollProgressRef = useRef<HTMLDivElement>(null);
  const [navScrollProgress, setNavScrollProgress] = useState(1);
  const hasScrolledToTarget = useRef(false);
  const jumpDirectionRef = useRef<'start' | 'end' | null>(null);
  const isPaginatingRef = useRef(false);
  const paginationCooldownRef = useRef(false);
  const isVirtualizerCorrectingRef = useRef(false);
  const correctingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paginationPropsRef = useRef({ hasMoreAbove: false, hasMoreBelow: false, isLoadingOlder: false, isLoadingNewer: false, onLoadOlder: undefined as (() => void) | undefined, onLoadNewer: undefined as (() => void) | undefined });
  paginationPropsRef.current = { hasMoreAbove: !!hasMoreAbove, hasMoreBelow: !!hasMoreBelow, isLoadingOlder: !!isLoadingOlder, isLoadingNewer: !!isLoadingNewer, onLoadOlder, onLoadNewer };
  const scrollCtxRef = useRef({ messageCount: 0, messagesLen: 0, timelineLen: 0, loadedStartIndex: 0 });
  const knownItemIdsRef = useRef<Set<string>>(new Set());
  const newItemIdsRef = useRef<Set<string>>(new Set());
  const mountTimeRef = useRef(Date.now());
  const [shareSelectionMode, setShareSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const [isCreatingShareLink, setIsCreatingShareLink] = useState(false);
  const [isImageLightboxActive, setIsImageLightboxActive] = useState(false);
  const [stickyMsgVisible, setStickyMsgVisible] = useState(false);
  const prevStickyMsgIdRef = useRef<string | null>(null);
  const prevStickyIdxRef = useRef<number | null>(null);
  const stickyGapRef = useRef<{ prevIdx: number } | null>(null);
  const dismissedStickyIdsRef = useRef<Set<string>>(new Set());
  const stickyElRef = useRef<HTMLDivElement>(null);
  const stickyDisabled = useInboxStore(s => s.clientState.ui?.sticky_headers_disabled ?? false);
  const updateUI = useInboxStore(s => s.updateClientUI);
  const headerRef = useRef<HTMLElement>(null);
  const [headerHeight, setHeaderHeight] = useState(32);
  const messageInputRef = useRef<HTMLDivElement>(null);
  const [messageInputHeight, setMessageInputHeight] = useState(0);

  const convLink = useCallback((id: string) => `/conversation/${id}`, []);

  const generateShareLink = useMutation(api.messages.generateMessageShareLink);
  const forkFromMessage = useMutation(api.conversations.forkFromMessage);
  const sendEscape = useMutation(api.conversations.sendEscapeToSession);
  const sendKeys = useMutation(api.conversations.sendKeysToSession);
  const rewindSession = useMutation(api.conversations.rewindSession);
  const sendInlineMessage = useMutation(api.pendingMessages.sendMessageToSession);
  const toggleFavoriteMutation = useMutation(api.conversations.toggleFavorite);
  const restartSession = useMutation(api.conversations.restartSession);
  const repairSession = useMutation(api.conversations.repairSession);

  const addOptimisticMsg = useInboxStore((s) => s.addOptimisticMessage);
  const activeBranches = useInboxStore((s) => s.activeBranches);
  const optimisticForkChildren = useInboxStore((s) => s.optimisticForkChildren);
  const firstActiveForkId = useMemo(() => {
    const entries = Object.entries(activeBranches);
    if (entries.length === 0) return null;
    const [, convId] = entries[0];
    const allForks = [...(conversation?.fork_children || []), ...optimisticForkChildren];
    if (!allForks.some(f => f._id === convId)) return null;
    return convId;
  }, [activeBranches, conversation?.fork_children, optimisticForkChildren]);
  const effectiveConversationId = firstActiveForkId || conversation?._id;

  const { user: currentUser } = useCurrentUser();
  const isForkOwner = useMemo(() => {
    if (!firstActiveForkId || !currentUser?._id) return false;
    const allForks = [...(conversation?.fork_children || []), ...optimisticForkChildren];
    const fork = allForks.find((f: any) => f._id === firstActiveForkId) as any;
    return fork?.user_id?.toString() === currentUser._id.toString();
  }, [firstActiveForkId, currentUser?._id, conversation?.fork_children, optimisticForkChildren]);
  const effectiveIsOwner = isOwner || isForkOwner;

  const handleSendInlineMessage = useCallback(async (content: string) => {
    if (!conversation || !effectiveConversationId) return;
    const clientId = addOptimisticMsg(effectiveConversationId, content);
    setUserScrolled(false);
    requestAnimationFrame(() => scrollToBottomFnRef.current());
    try {
      await sendInlineMessage({ conversation_id: effectiveConversationId as Id<"conversations">, content, client_id: clientId });
    } catch {
      toast.error("Failed to send message");
    }
  }, [conversation, effectiveConversationId, sendInlineMessage, addOptimisticMsg, setUserScrolled]);
  const managedSession = useQuery(
    api.managedSessions.isSessionManaged,
    conversation && effectiveConversationId && isConvexId(effectiveConversationId) && (
      (isOwner && conversation.status === "active") || !!firstActiveForkId
    )
      ? { conversation_id: effectiveConversationId as Id<"conversations"> }
      : "skip"
  );
  const isSessionLive = managedSession?.managed === true;

  const workflowRun = useQuery(
    api.workflow_runs.get,
    conversation?.workflow_run_id ? { id: conversation.workflow_run_id as any } : "skip"
  ) as { _id: string; status: string; gate_prompt?: string; gate_choices?: Array<{ key: string; label: string; target: string }>; gate_response?: string | null } | null | undefined;
  const respondToGate = useMutation(api.workflow_runs.respondToGate);
  const [gateResponding, setGateResponding] = useState(false);
  const handleGateRespond = useCallback(async (text: string) => {
    if (!workflowRun || !text.trim()) return;
    setGateResponding(true);
    try { await respondToGate({ id: workflowRun._id as any, response: text.trim() }); } finally { setGateResponding(false); }
  }, [workflowRun, respondToGate]);
  const handleGateChoice = handleGateRespond;

  const [showWorkflow, setShowWorkflow] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("");
  const workflows = useQuery(api.workflows.webList);
  const createWorkflowRun = useMutation(api.workflow_runs.create);
  const handleWorkflowLaunch = useCallback(async (goal: string) => {
    if (!selectedWorkflowId) return;
    try {
      await createWorkflowRun({
        workflow_id: selectedWorkflowId,
        goal_override: goal || undefined,
        project_path: conversation?.project_path || undefined,
        existing_conversation_id: conversation?._id as any,
      });
      toast.success("Workflow started");
      setShowWorkflow(false);
      setSelectedWorkflowId("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start workflow");
    }
  }, [selectedWorkflowId, createWorkflowRun, conversation?.project_path, conversation?._id]);

  const [optimisticMode, setOptimisticMode] = useState<string | null>(null);
  const optimisticTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const handleCycleMode = useCallback(() => {
    if (!conversation || !effectiveIsOwner || conversation.status !== "active") return;
    sendKeys({ conversation_id: (effectiveConversationId || conversation._id) as Id<"conversations">, keys: "BTab" });
    const currentMode = optimisticMode || managedSession?.permission_mode || "default";
    const nextIdx = (CC_MODE_ORDER.indexOf(currentMode) + 1) % CC_MODE_ORDER.length;
    setOptimisticMode(CC_MODE_ORDER[nextIdx]);
    clearTimeout(optimisticTimerRef.current);
    optimisticTimerRef.current = setTimeout(() => setOptimisticMode(null), 8000);
  }, [conversation, effectiveIsOwner, sendKeys, optimisticMode, managedSession?.permission_mode, effectiveConversationId]);

  const handleEnableBypass = useCallback(() => {
    if (!conversation || !effectiveIsOwner || conversation.status !== "active") return;
    const currentMode = optimisticMode || managedSession?.permission_mode || "default";
    const currentIdx = CC_MODE_ORDER.indexOf(currentMode);
    const targetIdx = CC_MODE_ORDER.indexOf("bypassPermissions");
    if (currentIdx === -1 || targetIdx === -1 || currentIdx === targetIdx) return;
    const steps = (targetIdx - currentIdx + CC_MODE_ORDER.length) % CC_MODE_ORDER.length;
    if (steps === 0) return;
    const keys = Array(steps).fill("BTab").join(" ");
    sendKeys({ conversation_id: (effectiveConversationId || conversation._id) as Id<"conversations">, keys });
    setOptimisticMode("bypassPermissions");
    clearTimeout(optimisticTimerRef.current);
    optimisticTimerRef.current = setTimeout(() => setOptimisticMode(null), 8000);
  }, [conversation, effectiveIsOwner, sendKeys, optimisticMode, managedSession?.permission_mode, effectiveConversationId]);
  useWatchEffect(() => {
    if (optimisticMode && managedSession?.permission_mode === optimisticMode) {
      setOptimisticMode(null);
      clearTimeout(optimisticTimerRef.current);
    }
  }, [managedSession?.permission_mode, optimisticMode]);
  const effectiveMode = optimisticMode || managedSession?.permission_mode || "default";

  const forkSelectedIndex = useForkNavigationStore((s) => s.selectedIndex);

  useWatchEffect(() => {
    if (!conversation || !effectiveIsOwner || conversation.status !== "active") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !e.shiftKey) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      e.preventDefault();
      handleCycleMode();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [conversation, effectiveIsOwner, handleCycleMode]);

  const messages = conversation?.messages || [];

  const agentNameToChildMap = conversation?.agent_name_map as Record<string, string> | undefined;

  const addOptimisticFork = useInboxStore((s) => s.addOptimisticFork);
  const pruneOptimisticForks = useInboxStore((s) => s.pruneOptimisticForks);

  const forkPointMap = useMemo(() => {
    const map: Record<string, Array<ForkChild>> = {};
    const allForks = [...(conversation?.fork_children || []), ...optimisticForkChildren];
    const seen = new Set<string>();
    for (const fork of allForks) {
      if (seen.has(fork._id)) continue;
      seen.add(fork._id);
      if (fork.parent_message_uuid) {
        if (!map[fork.parent_message_uuid]) map[fork.parent_message_uuid] = [];
        map[fork.parent_message_uuid].push(fork);
      }
    }
    return map;
  }, [conversation?.fork_children, optimisticForkChildren]);

  useWatchEffect(() => {
    if (!conversation?.fork_children) return;
    const serverIds = new Set(conversation.fork_children.map(f => f._id));
    pruneOptimisticForks(serverIds);
  }, [conversation?.fork_children, pruneOptimisticForks]);

  const handleStartShareSelection = useCallback((messageId: string) => {
    setShareSelectionMode(true);
    setSelectedMessageIds(new Set([messageId]));
  }, []);

  const handleToggleMessageSelection = useCallback((messageId: string) => {
    setSelectedMessageIds(prev => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }, []);

  const handleCancelShareSelection = useCallback(() => {
    setShareSelectionMode(false);
    setSelectedMessageIds(new Set());
  }, []);

  const handleConfirmShare = useCallback(async () => {
    if (selectedMessageIds.size === 0) return;

    setIsCreatingShareLink(true);
    try {
      const sortedIds = Array.from(selectedMessageIds).sort((a, b) => {
        const msgA = messages.find(m => m._id === a);
        const msgB = messages.find(m => m._id === b);
        return (msgA?.timestamp || 0) - (msgB?.timestamp || 0);
      });

      const token = await generateShareLink({
        message_id: sortedIds[0] as Id<"messages">,
        context_before: 0,
        context_after: 0,
        message_ids: sortedIds as Id<"messages">[],
      });

      const url = `${shareOrigin()}/share/message/${token}`;
      await copyToClipboard(url);
      toast.success("Share link copied!");
      setShareSelectionMode(false);
      setSelectedMessageIds(new Set());
    } catch (err) {
      toast.error("Failed to create share link");
    } finally {
      setIsCreatingShareLink(false);
    }
  }, [selectedMessageIds, messages, generateShareLink]);

  const toolCallChangeSelectionMap = useMemo(() => {
    const fileChanges = extractFileChanges(messages as any);
    const map: Record<string, ToolCallChangeSelection> = {};
    for (const change of fileChanges) {
      const key = change.toolCallId || change.id;
      const existing = map[key];
      if (!existing) {
        map[key] = {
          index: change.sequenceIndex,
          range: {
            start: change.sequenceIndex,
            end: change.sequenceIndex,
          },
        };
        continue;
      }
      existing.index = change.sequenceIndex;
      existing.range.end = change.sequenceIndex;
    }
    return map;
  }, [messages]);

  const pendingPermissionsRaw = useQuery(
    api.permissions.getPendingPermissions,
    conversation?._id && isConvexId(conversation._id) ? { conversation_id: conversation._id } : "skip"
  );
  const PERMISSION_SKIP_TOOLS = new Set(["AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);
  const pendingPermissions = pendingPermissionsRaw?.filter((p: any) => !PERMISSION_SKIP_TOOLS.has(p.tool_name));
  const hasAskUserQuestion = pendingPermissionsRaw?.some((p: any) => p.tool_name === "AskUserQuestion") ?? false;

  // Fork navigation state (data in inbox store, UI state in forkNavigationStore)
  const inboxMessages = useInboxStore((s) => s.messages);
  const forkSwitchBranch = useInboxStore((s) => s.switchBranch);
  const forkClearBranch = useInboxStore((s) => s.clearBranch);
  const forkSetMessages = useInboxStore((s) => s.setMessages);
  const resolveForkSessionId = useInboxStore((s) => s.resolveForkSessionId);
  const forkTreePanelOpen = useForkNavigationStore((s) => s.treePanelOpen);
  const toggleTreePanel = useForkNavigationStore((s) => s.toggleTreePanel);
  const forkSetSelectedIndex = useForkNavigationStore((s) => s.setSelectedIndex);
  const resetForkNav = useInboxStore((s) => s.resetForkNav);

  const prevConvIdRef = useRef<string | null>(null);
  useWatchEffect(() => {
    const id = conversation?._id ?? null;
    if (id && id !== prevConvIdRef.current) {
      if (prevConvIdRef.current !== null) {
        resetForkNav();
        const url = new URL(window.location.href);
        if (url.searchParams.has('branch')) {
          url.searchParams.delete('branch');
          window.history.replaceState({}, '', url.toString());
        }
      }
      prevConvIdRef.current = id;
    }
  }, [conversation?._id, resetForkNav]);

  const timelineRef = useRef<any[]>([]);

  const doFork = useCallback(async (messageUuid: string): Promise<{ forkSessionId: string; conversationId: string } | null> => {
    if (!conversation?._id) return null;
    const sourceConvId = effectiveConversationId || conversation._id;
    const isNestedFork = sourceConvId.toString() !== conversation._id.toString();
    // Must be a valid UUID so the daemon can resume without ID remapping
    const forkSessionId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    if (!isNestedFork) {
      // Single-level fork: use branch overlay on the root conversation
      addOptimisticFork({
        _id: forkSessionId,
        user_id: currentUser?._id?.toString(),
        title: conversation.title ? `Fork: ${conversation.title}` : "Fork",
        started_at: Date.now(),
        username: conversation.user?.name || conversation.user?.email?.split("@")[0],
        parent_message_uuid: messageUuid,
        message_count: 0,
        agent_type: conversation.agent_type,
      });
      forkSetMessages(forkSessionId, []);
      forkSwitchBranch(messageUuid, forkSessionId);
      const url = new URL(window.location.href);
      url.searchParams.set('branch', forkSessionId);
      window.history.replaceState({}, '', url.toString());
      toast.success("Forked -- switched to branch");
    }
    try {
      const result = await forkFromMessage({
        conversation_id: sourceConvId.toString(),
        message_uuid: messageUuid,
        session_id: forkSessionId,
      });
      if (isNestedFork) {
        // Nested fork: branch overlay only supports one level, navigate directly
        window.location.href = `/conversation/${result.conversation_id}`;
        return null;
      }
      resolveForkSessionId(forkSessionId, result.conversation_id);
      const resolvedUrl = new URL(window.location.href);
      resolvedUrl.searchParams.set('branch', result.conversation_id);
      window.history.replaceState({}, '', resolvedUrl.toString());
      return { forkSessionId, conversationId: result.conversation_id };
    } catch (err) {
      if (!isNestedFork) {
        forkClearBranch(messageUuid);
      }
      toast.error(err instanceof Error ? err.message : "Failed to fork");
      return null;
    }
  }, [conversation?._id, conversation?.title, conversation?.user, conversation?.agent_type, effectiveConversationId, forkFromMessage, forkSwitchBranch, forkClearBranch, forkSetMessages, addOptimisticFork, resolveForkSessionId]);

  const handleForkFromMessage = useCallback(async (messageUuid: string) => {
    const tl = timelineRef.current;
    const idx = tl.findIndex((item: any) => item.type === "message" && item.data?.message_uuid === messageUuid);
    if (idx !== -1) {
      const msg = tl[idx].data;
      if (msg.role === "user") {
        for (let i = idx - 1; i >= 0; i--) {
          if (tl[i].type === "message" && tl[i].data?.message_uuid) {
            await doFork(tl[i].data.message_uuid);
            if (msg.content && populateInputRef.current) {
              setTimeout(() => populateInputRef.current?.(msg.content), 100);
            }
            return;
          }
        }
      }
    }
    await doFork(messageUuid);
  }, [doFork]);

  const handleForkReply = useCallback(async (content: string) => {
    if (!conversation) return;
    const msgs = conversation.messages || [];
    const lastMsg = [...msgs].reverse().find((m: any) => m.message_uuid);
    if (!lastMsg?.message_uuid) {
      toast.error("No messages to fork from");
      return;
    }
    const forkResult = await doFork(lastMsg.message_uuid);
    if (!forkResult) return;
    const clientId = addOptimisticMsg(forkResult.conversationId, content);
    try {
      await sendInlineMessage({ conversation_id: forkResult.conversationId as Id<"conversations">, content, client_id: clientId });
    } catch {
      toast.error("Failed to send message to fork");
    }
  }, [conversation, doFork, addOptimisticMsg, sendInlineMessage]);

  // Preload branch from URL param
  const urlBranchPreloaded = useRef(false);
  useWatchEffect(() => {
    if (urlBranchPreloaded.current || !conversation?.fork_children) return;
    const url = new URL(window.location.href);
    const branchId = url.searchParams.get('branch');
    if (!branchId) return;
    const fork = conversation.fork_children.find(f => f._id === branchId);
    if (fork?.parent_message_uuid) {
      forkSwitchBranch(fork.parent_message_uuid, branchId);
      urlBranchPreloaded.current = true;
    }
  }, [conversation?.fork_children, forkSwitchBranch]);

  // Activate fork branch when navigated from sidebar (pendingForkActivation)
  const pendingForkActivation = useInboxStore((s) => s.pendingForkActivation);
  const setPendingForkActivation = useInboxStore((s) => s.setPendingForkActivation);
  const setActiveForkHighlight = useInboxStore((s) => s.setActiveForkHighlight);
  const pendingForkConsumed = useRef<string | null>(null);
  useWatchEffect(() => {
    if (!pendingForkActivation || !conversation?.fork_children) return;
    if (pendingForkConsumed.current === pendingForkActivation) return;
    const fork = conversation.fork_children.find(f => f._id === pendingForkActivation);
    if (fork?.parent_message_uuid) {
      forkSwitchBranch(fork.parent_message_uuid, pendingForkActivation);
      setActiveForkHighlight(pendingForkActivation);
      pendingForkConsumed.current = pendingForkActivation;
      setPendingForkActivation(null);
    }
  }, [pendingForkActivation, conversation?.fork_children, forkSwitchBranch, setPendingForkActivation, setActiveForkHighlight]);

  const { isLoading: isForkLoading } = useForkMessages(firstActiveForkId);
  const [loadingBranchId, setLoadingBranchId] = useState<string | null>(null);

  // Merge messages, commits, and PRs into a single timeline (with fork branch support)
  type TimelineItem =
    | { type: 'message'; data: Message; timestamp: number }
    | { type: 'commit'; data: Commit; timestamp: number }
    | { type: 'pull_request'; data: PullRequest; timestamp: number };

  // Pending messages: read directly so they ALWAYS render, regardless of what
  // setMessages/mergeMessages/buildCompositeTimeline do to the server message arrays.
  const pendingConvId = effectiveConversationId || conversation?._id || '';
  const pendingMsgs = useInboxStore((s) => s.pendingMessages[pendingConvId] ?? EMPTY_PENDING);

  const timeline: TimelineItem[] = useMemo(() => {
    const base = buildCompositeTimeline(
      messages,
      commits,
      pullRequests,
      activeBranches,
      inboxMessages,
    ) as TimelineItem[];
    if (pendingMsgs.length === 0) return base;
    // Guaranteed render: append any pending messages not already in the timeline.
    // This is the ONLY merge point — the store never mixes pending into messages[].
    const seen = new Set<string>();
    for (const item of base) {
      if (item.type === 'message') {
        const m = item.data as any;
        seen.add(m._id);
        if (m.client_id) seen.add(m.client_id);
      }
    }
    const toAdd = pendingMsgs.filter((m: any) =>
      !seen.has(m._id) && (!m._clientId || !seen.has(m._clientId))
    );
    if (toAdd.length === 0) return base;
    return [...base, ...toAdd.map((m: any) => ({ type: 'message' as const, data: m, timestamp: m.timestamp }))];
  }, [messages, commits, pullRequests, activeBranches, inboxMessages, pendingMsgs]);
  timelineRef.current = timeline;
  scrollCtxRef.current = { messageCount: conversation?.message_count || messages.length, messagesLen: messages.length, timelineLen: timeline.length, loadedStartIndex: conversation?.loaded_start_index ?? 0 };

  const [navigatorOpen, setNavigatorOpen] = useState(false);
  const populateInputRef = useRef<((text: string) => void) | null>(null);
  const dropFilesRef = useRef<((files: File[]) => void) | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes("Files")) setIsDragging(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
    if (files.length > 0 && dropFilesRef.current) {
      dropFilesRef.current(files);
    } else if (files.length === 0 && e.dataTransfer.files.length > 0) {
      toast.error("Only image files are supported");
    }
  }, []);

  const navigatorUserMessages = useQuery(
    api.conversations.getUserMessages,
    conversation && isOwner && conversation.status === "active" && effectiveConversationId && isConvexId(effectiveConversationId)
      ? { conversation_id: effectiveConversationId as Id<"conversations"> }
      : "skip"
  );

  const handleSendEscape = useCallback(() => {
    if (!conversation || !effectiveIsOwner || conversation.status !== "active" || !effectiveConversationId) return;
    sendEscape({ conversation_id: effectiveConversationId as Id<"conversations"> });
    toast.info("Escape sent to session");
  }, [conversation, effectiveIsOwner, sendEscape, effectiveConversationId]);

  const handleMessageSent = useCallback(() => {
    setUserScrolled(false);
    requestAnimationFrame(() => scrollToBottomFnRef.current());
  }, [setUserScrolled]);

  const handleOpenNavigator = useCallback(() => {
    if (navigatorUserMessages && navigatorUserMessages.length > 0) {
      setNavigatorOpen(true);
    }
  }, [navigatorUserMessages]);

  const handleNavigatorRewind = useCallback((msg: NavUserMessage, indexFromEnd: number) => {
    if (!msg.message_uuid || !conversation) return;
    setNavigatorOpen(false);
    handleForkFromMessage(msg.message_uuid);
    if (effectiveIsOwner && conversation.status === "active") {
      rewindSession({ conversation_id: (effectiveConversationId || conversation._id) as Id<"conversations">, steps_back: indexFromEnd + 1 });
    }
  }, [handleForkFromMessage, conversation, effectiveIsOwner, rewindSession, effectiveConversationId]);

  const handleNavigatorFork = useCallback((msg: NavUserMessage) => {
    if (!msg.message_uuid) return;
    setNavigatorOpen(false);
    handleForkFromMessage(msg.message_uuid);
  }, [handleForkFromMessage]);

  const handleNavigatorClose = useCallback((selectedMsg?: { content: string }) => {
    setNavigatorOpen(false);
    if (selectedMsg?.content && populateInputRef.current) {
      populateInputRef.current(selectedMsg.content);
    }
  }, []);

  const userMsgKindMap = useMemo(() => {
    const map = new Map<string, UserMessageKind>();
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if (item.type !== 'message') continue;
      const msg = item.data as Message;
      if (msg.role !== 'user') continue;
      let immediatePrev: Message | null = null;
      for (let j = i - 1; j >= 0; j--) {
        if (timeline[j].type === 'message') { immediatePrev = timeline[j].data as Message; break; }
      }
      let contextPrev: Message | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const p = timeline[j];
        if (p.type !== 'message') continue;
        const pm = p.data as Message;
        if (pm.role === 'user' && pm.tool_results?.length && (!pm.content || !pm.content.trim())) continue;
        if (pm.role === 'user' && pm.content && isCommandMessage(pm.content)) continue;
        contextPrev = pm;
        break;
      }
      map.set(msg._id, classifyUserMessage(msg, conversation?.agent_type, immediatePrev, contextPrev));
    }
    return map;
  }, [timeline, conversation?.agent_type]);

  const sessionSkills = useMemo(() => {
    let extracted: Array<{ name: string; description: string }> = [];
    // Resolve skills from user-level data + project path (avoids storing per-conversation)
    const rawSkills = (currentUser as any)?.available_skills;
    if (rawSkills) {
      try {
        const parsed = JSON.parse(rawSkills);
        if (Array.isArray(parsed)) {
          extracted = parsed;
        } else {
          const global: Array<{ name: string; description: string }> = parsed["global"] || [];
          const project: Array<{ name: string; description: string }> = conversation?.project_path ? (parsed[conversation.project_path] || []) : [];
          const seen = new Set<string>();
          for (const s of [...global, ...project]) {
            if (!seen.has(s.name)) { seen.add(s.name); extracted.push(s); }
          }
        }
      } catch {}
    }
    if (!extracted.length && conversation?.messages) {
      extracted = extractSkillsFromMessages(conversation.messages);
    }
    const builtins = getBuiltinCommands(conversation?.agent_type);
    const names = new Set(extracted.map(s => s.name.toLowerCase()));
    return [...extracted, ...builtins.filter(b => !names.has(b.name.toLowerCase()))];
  }, [currentUser, conversation?.project_path, conversation?.messages, conversation?.agent_type]);

  const sessionFilePaths = useMemo(() => {
    if (!conversation?.messages) return [];
    return extractFilePaths(conversation.messages);
  }, [conversation?.messages]);

  const storeSessions = useInboxStore((s) => s.sessions);
  const storeDismissed = useInboxStore((s) => s.dismissedSessions);
  const storeTasks = useInboxStore((s) => s.tasks);
  const storePlans = useInboxStore((s) => s.plans);
  const storeDocs = useInboxStore((s) => s.docs);
  const storeMembers = useInboxStore((s) => s.teamMembers);
  const mentionItemsRef = useRef<MentionItem[]>([]);
  const mentionItems = useMemo(() => {
    const PER_TYPE = 30;
    const byRecency = (a: { updatedAt?: number }, b: { updatedAt?: number }) => (b.updatedAt || 0) - (a.updatedAt || 0);
    const persons: MentionItem[] = storeMembers.map((m: any) => ({ id: String(m._id || m.id), type: "person", label: m.name || m.github_username || "Unknown", sublabel: m.github_username ? `@${m.github_username}` : m.email, image: m.image || m.github_avatar_url }));
    const tasks: MentionItem[] = Object.values(storeTasks)
      .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)).slice(0, PER_TYPE)
      .map(t => ({ id: t._id, type: "task", label: t.title, sublabel: t.short_id, shortId: t.short_id, status: t.status, priority: t.priority, updatedAt: t.updated_at }));
    const docs: MentionItem[] = Object.values(storeDocs)
      .filter(d => d.doc_type !== "plan")
      .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)).slice(0, PER_TYPE)
      .map(d => ({ id: d._id, type: "doc", label: d.title, sublabel: d.doc_type, docType: d.doc_type, updatedAt: d.updated_at }));
    const plans: MentionItem[] = Object.values(storePlans)
      .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)).slice(0, PER_TYPE)
      .map(p => ({ id: p._id, type: "plan", label: p.title, sublabel: p.short_id, shortId: p.short_id, status: p.status, goal: p.goal, updatedAt: p.updated_at }));
    const allSessions = { ...storeSessions, ...storeDismissed };
    const sessions: MentionItem[] = Object.values(allSessions)
      .filter(s => !s.is_subagent)
      .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)).slice(0, PER_TYPE)
      .map(s => ({ id: s._id, type: "session", label: s.title || "Untitled Session", sublabel: s.idle_summary?.slice(0, 80) || s.session_id, shortId: s.session_id, messageCount: s.message_count, projectPath: s.project_path, agentType: s.agent_type, updatedAt: s.updated_at, idleSummary: s.idle_summary }));
    const all = [...persons, ...tasks, ...docs, ...plans, ...sessions];
    all.sort(byRecency);
    return all;
  }, [storeMembers, storeTasks, storeDocs, storePlans, storeSessions, storeDismissed]);
  mentionItemsRef.current = mentionItems;
  const handleMentionQuery = useCallback((_q: string) => {}, []);

  const isWaitingForResponse = useMemo(() => {
    if (!conversation || conversation.status !== "active" || timeline.length === 0 || hasMoreBelow) return false;
    const last = timeline[timeline.length - 1];
    if (last.type !== 'message') return false;
    const msg = last.data as Message;
    if (msg.role !== 'user') return false;
    const kind = userMsgKindMap.get(msg._id);
    if (kind?.kind === 'interrupt') return false;
    return true;
  }, [conversation, timeline, hasMoreBelow, userMsgKindMap]);

  const isThinking = useMemo(() => {
    if (!conversation || conversation.status !== "active" || timeline.length === 0 || hasMoreBelow) return false;
    const last = timeline[timeline.length - 1];
    if (last.type !== 'message') return false;
    const msg = last.data as Message;
    if (msg.role !== 'assistant') return false;
    const hasThinkingContent = msg.thinking && msg.thinking.trim().length > 0;
    const hasVisibleContent = (msg.content && stripSystemTags(msg.content).trim().length > 0) || (msg.tool_calls && msg.tool_calls.length > 0);
    return !!(hasThinkingContent && !hasVisibleContent);
  }, [conversation, timeline, hasMoreBelow]);

  const serverUserMessages = useQuery(
    api.conversations.getUserMessages,
    conversation?._id && isConvexId(conversation._id)
      ? { conversation_id: conversation._id as Id<"conversations"> }
      : "skip"
  );

  const processedServerMsgIds = useMemo(() => {
    if (!serverUserMessages) return new Set<string>();
    const ids = new Set<string>();
    for (const m of serverUserMessages) {
      const display = cleanContent(m.content);
      if (display.length > 0 && !isSystemMessage(display)) ids.add(m._id);
    }
    return ids;
  }, [serverUserMessages]);

  const stickyUserMsgIndices = useMemo(() => {
    const useServer = processedServerMsgIds.size > 0;
    const indices: number[] = [];
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if (item.type !== 'message') continue;
      const msg = item.data as Message;
      if (msg.role !== 'user') continue;
      if (useServer) {
        if (processedServerMsgIds.has(msg._id)) indices.push(i);
      } else {
        const kind = userMsgKindMap.get(msg._id);
        if (kind && isStickyWorthy(kind)) indices.push(i);
      }
    }
    return indices;
  }, [timeline, processedServerMsgIds, userMsgKindMap]);

  const serverStickyFallback = useMemo(() => {
    if (!serverUserMessages || serverUserMessages.length === 0 || !hasMoreAbove) return null;
    const localIds = new Set<string>();
    for (const item of timeline) {
      if (item.type === 'message') localIds.add((item.data as Message)._id);
    }
    for (let i = 0; i < serverUserMessages.length; i++) {
      const msg = serverUserMessages[i];
      if (!localIds.has(msg._id) && processedServerMsgIds.has(msg._id)) {
        return { id: msg._id, content: msg.content };
      }
    }
    return null;
  }, [serverUserMessages, timeline, hasMoreAbove, processedServerMsgIds]);

  const [activeStickyMsg, setActiveStickyMsgRaw] = useState<{ index: number; content: string; id: string } | null>(null);
  const setActiveStickyMsg = useCallback((val: { index: number; content: string; id: string } | null) => {
    setActiveStickyMsgRaw(prev => {
      if (prev === val) return prev;
      if (prev === null || val === null) return val;
      if (prev.index === val.index && prev.id === val.id && prev.content === val.content) return prev;
      return val;
    });
  }, []);

  useWatchEffect(() => {
    const currentIds = new Set(timeline.map(item => {
      if (item.type === 'message') return (item.data as Message)._id;
      if (item.type === 'commit') return `commit-${(item.data as any).sha || (item.data as any)._id}`;
      return `pr-${(item.data as any)._id}`;
    }));

    // Suppress animation during initial hydration — IDB delivers cached messages first,
    // then Convex syncs the latest. Without this window, the Convex delta would
    // trigger slide-in animations for messages that aren't actually new.
    const isSettling = Date.now() - mountTimeRef.current < 1500;

    if (knownItemIdsRef.current.size > 0 && !isPaginatingRef.current && !isSettling) {
      const fresh = new Set<string>();
      for (const id of currentIds) {
        if (!knownItemIdsRef.current.has(id)) {
          if (!id.startsWith("optimistic_")) {
            const item = timeline.find(i => {
              if (i.type === 'message') return (i.data as Message)._id === id;
              if (i.type === 'commit') return `commit-${(i.data as any).sha || (i.data as any)._id}` === id;
              return `pr-${(i.data as any)._id}` === id;
            });
            if (item?.type === 'message' && (item.data as Message).role === 'user') continue;
          }
          fresh.add(id);
        }
      }
      if (fresh.size > 0 && fresh.size <= 20) {
        newItemIdsRef.current = fresh;
        knownItemIdsRef.current = currentIds;
        const timer = setTimeout(() => { newItemIdsRef.current = new Set(); }, 400);
        return () => clearTimeout(timer);
      }
    }

    knownItemIdsRef.current = currentIds;
  }, [timeline]);

  // Track if we've already scrolled for this highlight query
  const hasScrolledToHighlight = useRef(false);

  // Fetch ALL matches across the whole conversation (not just loaded messages).
  // Without this, a match in a message outside the current pagination window is invisible.
  const cleanedHighlight = highlightQuery?.trim();
  const globalMatches = useQuery(
    api.messages.findAllMessagesByContent,
    convexConvId && cleanedHighlight
      ? { conversation_id: convexConvId, search_term: cleanedHighlight }
      : "skip"
  );

  // Build match instances from the global list so the counter and next/prev
  // work across unloaded messages too.
  useWatchEffect(() => {
    if (!highlightQuery) {
      setHighlightedMessageId(null);
      setAllMatchingMessageIds(EMPTY_MATCH_IDS);
      setMatchInstances(EMPTY_MATCH_INSTANCES);
      setCurrentMatchIndex(0);
      hasScrolledToHighlight.current = false;
      return;
    }
    if (!globalMatches) return;

    const matchingIds: string[] = [];
    const instances: { messageId: string; localIndex: number; timestamp: number }[] = [];
    for (const m of globalMatches) {
      matchingIds.push(m.message_id);
      for (let i = 0; i < m.match_count; i++) {
        instances.push({ messageId: m.message_id, localIndex: i, timestamp: m.timestamp });
      }
    }

    setAllMatchingMessageIds(matchingIds);
    setMatchInstances(instances);
    if (instances.length > 0) {
      setHighlightedMessageId(instances[0].messageId);
      setCurrentMatchIndex(prev => (prev < instances.length ? prev : 0));
    } else {
      setHighlightedMessageId(null);
      setCurrentMatchIndex(0);
    }
  }, [highlightQuery, globalMatches]);

  // Ref of loaded message IDs for fast membership checks during navigation.
  const loadedIdsRef = useRef<Set<string>>(new Set());
  loadedIdsRef.current = useMemo(() => new Set(messages.map((m: Message) => m._id)), [messages]);

  const navigateToMatch = useCallback((index: number) => {
    if (matchInstances.length === 0) return;
    const target = matchInstances[index];
    setCurrentMatchIndex(index);
    setHighlightedMessageId(target.messageId);
    hasScrolledToHighlight.current = false;
    setNavTrigger(t => t + 1);
  }, [matchInstances]);

  const goToNextMatch = useCallback(() => {
    if (matchInstances.length === 0) return;
    navigateToMatch((currentMatchIndex + 1) % matchInstances.length);
  }, [matchInstances, currentMatchIndex, navigateToMatch]);

  const goToPrevMatch = useCallback(() => {
    if (matchInstances.length === 0) return;
    navigateToMatch(currentMatchIndex === 0 ? matchInstances.length - 1 : currentMatchIndex - 1);
  }, [matchInstances, currentMatchIndex, navigateToMatch]);

  // Activate the specific mark in the DOM after navigation
  // Track pending scroll target; survives until the target message renders so that
  // navigating to an unloaded match still scrolls once the jump loads the messages.
  const pendingScrollRef = useRef<{ messageId: string; localIndex: number } | null>(null);

  useWatchEffect(() => {
    void navTrigger;
    if (matchInstances.length === 0 || !containerRef.current) return;
    const instance = matchInstances[currentMatchIndex];
    if (!instance) return;
    pendingScrollRef.current = { messageId: instance.messageId, localIndex: instance.localIndex };
    const isLoaded = loadedIdsRef.current.has(instance.messageId);
    // If the target message is outside the current pagination window, trigger
    // a server jump so the activation effect can scroll to it once it loads.
    if (!isLoaded && onJumpToTimestamp) {
      onJumpToTimestamp(instance.timestamp);
    }
  }, [currentMatchIndex, matchInstances, navTrigger, onJumpToTimestamp]);

  // Activate the pending mark whenever the DOM for the target message is ready.
  // Messages are virtualized: the wrapper may render before its text/marks do.
  // Scroll the wrapper in first (triggers virtualizer to render content), then
  // retry finding marks. Runs on navigation AND when `messages` changes (post-jump).
  useWatchEffect(() => {
    const pending = pendingScrollRef.current;
    if (!pending || !containerRef.current) return;
    if (!loadedIdsRef.current.has(pending.messageId)) return;
    let scrolledWrapper = false;
    const activate = () => {
      if (!containerRef.current || !pendingScrollRef.current) return;
      const p = pendingScrollRef.current;
      containerRef.current.querySelectorAll('mark[data-search-active]').forEach(m => {
        m.removeAttribute('data-search-active');
        (m as HTMLElement).style.cssText = '';
      });
      const msgEl = containerRef.current.querySelector(`#msg-${CSS.escape(p.messageId)}`);
      if (!msgEl) return;
      const marks = Array.from(msgEl.querySelectorAll('mark[data-search-highlight]'));
      if (marks.length === 0) {
        // Virtualizer hasn't rendered the message content yet — scroll the wrapper
        // so it mounts; a later retry (50/200/500/1000ms) will find the marks.
        if (!scrolledWrapper) {
          msgEl.scrollIntoView({ block: 'center', behavior: 'auto' });
          scrolledWrapper = true;
        }
        return;
      }
      const target = marks[p.localIndex] ?? marks[0];
      if (target) {
        target.setAttribute('data-search-active', 'true');
        (target as HTMLElement).style.backgroundColor = 'rgb(245 158 11)';
        (target as HTMLElement).style.borderRadius = '2px';
        (target as HTMLElement).style.boxShadow = '0 0 0 1px rgb(245 158 11)';
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        pendingScrollRef.current = null;
      }
    };
    const t1 = setTimeout(activate, 50);
    const t2 = setTimeout(activate, 200);
    const t3 = setTimeout(activate, 500);
    const t4 = setTimeout(activate, 1000);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); };
  }, [navTrigger, messages, highlightedMessageId]);

  const handleCopyAll = async () => {
    if (!convexConvId) {
      toast.error("No messages to copy");
      return;
    }

    try {
      toast.info("Loading all messages...");
      const allMessages = await convex.query(api.conversations.copyAllMessages, { conversation_id: convexConvId });
      if (!allMessages || allMessages.length === 0) {
        toast.error("No messages to copy");
        return;
      }

      const formatted = allMessages
        .filter((msg: any) => msg.role !== "system" && msg.subtype !== "compact_boundary")
        .map((msg: any) => {
          const ts = new Date(msg.timestamp).toLocaleString();
          const label = msg.role === "user" ? "User" : "Assistant";
          const text = formatMessagePartsForCopy(msg.content, msg.tool_calls, msg.tool_results);
          if (!text) return null;
          return `[${ts}] ${label}:\n${text}\n`;
        })
        .filter(Boolean)
        .join("\n");

      await copyToClipboard(formatted);
      toast.success("Conversation copied to clipboard");
    } catch (err) {
      toast.error("Failed to copy to clipboard");
    }
  };

  const buildResumeCommand = useCallback((targetAgent: "claude" | "codex"): string | null => {
    const sessionId = managedSession?.session_id || conversation?.session_id;
    if (!sessionId || !conversation) return null;
    const projectDir = conversation.project_path || conversation.git_root;
    const cdPrefix = projectDir ? `cd ${projectDir} && ` : "";
    const sourceAgent = conversation.agent_type === "codex" ? "codex" : "claude";
    if (targetAgent === sourceAgent && targetAgent === "codex") {
      return `${cdPrefix}codex resume ${sessionId}`;
    }
    return `${cdPrefix}cast resume ${sessionId}${targetAgent !== sourceAgent ? ` --as ${targetAgent}` : ""}`;
  }, [managedSession?.session_id, conversation?.session_id, conversation?.agent_type, conversation?.project_path, conversation?.git_root]);

  const handleCopyResumeCommand = useCallback(async (targetAgent: "claude" | "codex") => {
    try {
      const cmd = buildResumeCommand(targetAgent);
      if (!cmd) {
        toast.error("No session to resume");
        return;
      }
      await copyToClipboard(cmd);
      toast.success(`Resume command copied (${targetAgent})`);
    } catch {
      toast.error("Failed to copy");
    }
  }, [buildResumeCommand]);

  // Extract usage from loaded messages (local)
  const latestUsage = useMemo(() => {
    if (!messages || messages.length === 0) return undefined;
    const state = createReducer();
    reducer(state, messages);
    return state.latestUsage;
  }, [messages]);

  // Fetch tool stats from backend (scans ALL messages, not just loaded window)
  const toolStats = useQuery(
    api.conversations.getConversationToolStats,
    conversation?._id && isConvexId(conversation._id) ? { conversation_id: conversation._id } : "skip"
  );
  const taskStats = toolStats?.taskStats ?? null;

  const getItemKey = useCallback((index: number) => {
    const item = timeline[index];
    if (!item) return index;
    if (item.type === 'message') return (item.data as Message)._id;
    if (item.type === 'commit') return `commit-${(item.data as any).sha || (item.data as any)._id}`;
    return `pr-${(item.data as any)._id}`;
  }, [timeline]);

  const estimateSize = useCallback((index: number) => {
    const item = timeline[index];
    if (!item) return 100;

    if (item.type === 'commit') return 80;

    const msg = item.data as Message;
    if (collapsed) {
      if (msg.role === "system") return 0;
      if (msg.role === "user") {
        const kind = userMsgKindMap.get(msg._id);
        if (kind && kind.kind !== 'normal' && kind.kind !== 'plan' && kind.kind !== 'skill_expansion') return 0;
      }
      if (msg.role === "assistant") {
        const hasTextContent = msg.content && msg.content.trim().length > 0;
        if (!hasTextContent) return 0;
        for (let i = index - 1; i >= 0; i--) {
          const checkItem = timeline[i];
          if (checkItem.type !== 'message') continue;
          const checkMsg = checkItem.data as Message;
          if (checkMsg.role === "user") break;
          if (checkMsg.role === "assistant" && checkMsg.content && checkMsg.content.trim().length > 0) {
            return 0;
          }
        }
      }
      return 80;
    }

    if (msg.role === "system") return 8;
    if (msg.role === "user") {
      const kind = userMsgKindMap.get(msg._id);
      switch (kind?.kind) {
        case 'command': return 30;
        case 'interrupt': return 30;
        case 'continuation': return 30;
        case 'skill_expansion': return 44;
        case 'task_notification': return 40;
        case 'scheduled_task': return 56;
        case 'teammate_events': return 40;
        case 'task_prompt': return 0;
        case 'compaction_prompt': return 0;
        case 'compaction_summary': return 60;
        case 'noise': return 0;
        case 'tool_results_only': return 0;
        case 'empty': return 0;
        case 'poll_response': return 0;
      }
      return 100;
    }
    if (msg.role === "assistant") {
      const hasTextContent = msg.content && msg.content.trim().length > 0;
      const toolCount = msg.tool_calls?.length || 0;
      if (!hasTextContent && !msg.thinking && !msg.images?.length) return 8;
      if (!hasTextContent && toolCount > 0) return Math.min(toolCount * 30, 200);
      return 200;
    }
    return 40;
  }, [timeline, collapsed, userMsgKindMap]);

  const virtualizer = useVirtualizer({
    count: timeline.length,
    getScrollElement: () => containerRef.current,
    getItemKey,
    estimateSize,
    overscan: 10,
    paddingStart: 16,
    paddingEnd: 100,
    isScrollingResetDelay: 150,
  });

  // Hook into virtualizer's scroll correction to prevent the scroll handler
  // from falsely clearing userScrolled. When items above the viewport get
  // measured (e.g. large markdown files grow from 200px estimate to 3000px+),
  // TanStack adjusts scrollTop upward. The scroll handler sees this as
  // "scrolled down near bottom" (scrollTop increased, scrollHeight not yet
  // updated) and clears userScrolled — which lets the ResizeObserver auto-pin
  // snap to bottom. This flag blocks that false positive.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item: any, _delta: number) => {
    const sc = containerRef.current;
    const shouldAdjust = sc ? item.start < sc.scrollTop : false;
    if (shouldAdjust) {
      isVirtualizerCorrectingRef.current = true;
      if (correctingTimerRef.current) clearTimeout(correctingTimerRef.current);
      correctingTimerRef.current = setTimeout(() => { isVirtualizerCorrectingRef.current = false; }, 100);
    }
    return shouldAdjust;
  };

  scrollToBottomFnRef.current = () => {
    if (timeline.length > 0) virtualizer.scrollToIndex(timeline.length - 1, { align: "end" });
  };

  // Fork navigation: message selection (Option+j/k to navigate, Option+f to fork)
  const [selectedMessageContent, setSelectedMessageContent] = useState<string | null>(null);
  const [selectedMessageUuid, setSelectedMessageUuid] = useState<string | null>(null);
  const handleSelectMessage = useCallback((uuid: string | null, content: string | null) => {
    setSelectedMessageUuid(uuid);
    setSelectedMessageContent(content);
  }, []);
  const handleClearSelection = useCallback(() => {
    forkSetSelectedIndex(null);
    setSelectedMessageContent(null);
    setSelectedMessageUuid(null);
  }, [forkSetSelectedIndex]);
  const forkSelectionIdx = useForkNavigationStore((s) => s.selectedIndex);
  const { selectedIndex: _forkSelIdx } = useMessageSelection({
    timeline: timeline as any,
    virtualizer,
    onForkFromMessage: handleForkFromMessage,
    onSelectMessage: handleSelectMessage,
    enabled: isOwner,
  });

  // Fork navigation: handle branch switching
  const handleBranchSwitch = useCallback((messageUuid: string, convId: string | null) => {
    if (convId === null) {
      forkClearBranch(messageUuid);
      setLoadingBranchId(null);
      setActiveForkHighlight(null);
    } else {
      forkSwitchBranch(messageUuid, convId);
      if (!inboxMessages[convId]) {
        setLoadingBranchId(convId);
      }
      setActiveForkHighlight(convId);
    }
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (convId) {
        url.searchParams.set('branch', convId);
      } else {
        url.searchParams.delete('branch');
      }
      window.history.replaceState({}, '', url.toString());
    }
  }, [forkSwitchBranch, forkClearBranch, inboxMessages, setActiveForkHighlight]);

  // Clear loading state when fork messages arrive
  useWatchEffect(() => {
    if (loadingBranchId && inboxMessages[loadingBranchId]) {
      setLoadingBranchId(null);
    }
  }, [loadingBranchId, inboxMessages]);

  // Fork tree panel: handle switching to a different conversation
  const handleTreeSwitchConversation = useCallback((convId: string) => {
    if (convId === conversation?._id?.toString()) {
      Object.keys(activeBranches).forEach(uuid => forkClearBranch(uuid));
      return;
    }
    const forkChild = conversation?.fork_children?.find(f => f._id === convId);
    if (forkChild && forkChild.parent_message_uuid) {
      Object.keys(activeBranches).forEach(uuid => forkClearBranch(uuid));
      forkSwitchBranch(forkChild.parent_message_uuid, convId);
      if (!inboxMessages[convId]) {
        setLoadingBranchId(convId);
      }
      return;
    }
    window.location.href = `/conversation/${convId}`;
  }, [conversation?._id, conversation?.fork_children, activeBranches, forkClearBranch, forkSwitchBranch, inboxMessages]);

  // Active branch IDs for tree panel highlighting
  const activeBranchIdSet = useMemo(
    () => new Set(Object.values(activeBranches)),
    [activeBranches]
  );

  useShortcutContext('conversation');
  useShortcutAction('conv.toggleTree', useCallback(() => {
    if (!isOwner) return;
    if (forkSelectionIdx !== null) return;
    const hasForks = (conversation?.fork_children && conversation.fork_children.length > 0) || conversation?.forked_from;
    if (!hasForks) return;
    toggleTreePanel();
  }, [isOwner, forkSelectionIdx, toggleTreePanel, conversation?.fork_children, conversation?.forked_from]));

  useShortcutAction('conv.copyLink', useCallback(() => {
    const url = `${shareOrigin()}/conversation/${conversation?._id}`;
    copyToClipboard(url).then(() => toast.success("Link copied!"));
  }, [conversation?._id]));

  useShortcutAction('conv.toggleThinking', useCallback(() => {
    setShowThinking((s) => !s);
  }, []));

  useShortcutAction('conv.favorite', useCallback(() => {
    if (!conversation || !isOwner) return;
    toggleFavoriteMutation({ conversation_id: conversation._id })
      .then(() => toast.success(conversation.is_favorite ? "Removed from favorites" : "Added to favorites"))
      .catch(() => toast.error("Failed to update favorite"));
  }, [conversation, isOwner, toggleFavoriteMutation]));

  useShortcutAction('conv.toggleDiff', useCallback(() => {
    if (!conversation?.git_branch) return;
    setDiffExpanded((s) => !s);
  }, [conversation?.git_branch]));

  useMountEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeaderHeight(el.offsetHeight));
    setHeaderHeight(el.offsetHeight);
    ro.observe(el);
    return () => ro.disconnect();
  });

  const isZenMode = useInboxStore(s => s.clientState.ui?.zen_mode ?? false);
  const [deskClass, setDeskClass] = useState("");
  useMountEffect(() => {
    setDeskClass(desktopHeaderClass());
  });

  useWatchEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    return setupDesktopDrag(el);
  }, [deskClass]);

  useMountEffect(() => {
    const el = messageInputRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setMessageInputHeight(el.offsetHeight));
    setMessageInputHeight(el.offsetHeight);
    ro.observe(el);
    return () => ro.disconnect();
  });


  useWatchEffect(() => {
    const el = containerRef.current;
    if (!el) {
      if (stickyUserMsgIndices.length === 0 && !fallbackStickyContent) {
        setActiveStickyMsg(null);
        setStickyMsgVisible(false);
      }
      return;
    }
    let ticking = false;
    const check = () => {
      ticking = false;
      const scrollTop = el.scrollTop;
      if (scrollTop <= headerHeight + 40) {
        prevStickyMsgIdRef.current = null;
        prevStickyIdxRef.current = null;
        stickyGapRef.current = null;
        setActiveStickyMsg(null);
        setStickyMsgVisible(false);
        return;
      }
      if (stickyDisabled) {
        setActiveStickyMsg(null);
        setStickyMsgVisible(false);
        return;
      }
      const virtualItems = virtualizer.getVirtualItems();
      let bestIdx: number | null = null;
      let bestArrayIdx: number | null = null;
      for (let i = stickyUserMsgIndices.length - 1; i >= 0; i--) {
        const tlIdx = stickyUserMsgIndices[i];
        const item = timeline[tlIdx];
        if (item?.type === 'message') {
          const msgId = (item.data as Message)._id;
          if (dismissedStickyIdsRef.current.has(msgId)) continue;
        }
        const vItem = virtualItems.find(v => v.index === tlIdx);
        if (vItem) {
          const domEl = el.querySelector(`[data-index="${tlIdx}"]`);
          if (!domEl) continue;
          const msgBottom = domEl.getBoundingClientRect().bottom - el.getBoundingClientRect().top;
          if (msgBottom <= 0) {
            bestIdx = tlIdx;
            bestArrayIdx = i;
            break;
          }
        } else {
          if (tlIdx < (virtualItems[0]?.index ?? 0) && scrollTop > el.clientHeight) {
            bestIdx = tlIdx;
            bestArrayIdx = i;
            break;
          }
        }
      }
      if (bestIdx !== null) {
        let hideForNextMsg = false;
        const stickyBottom = headerHeight + (stickyElRef.current?.offsetHeight ?? 0);
        if (bestArrayIdx !== null) {
          const nextArrayIdx = bestArrayIdx + 1;
          if (nextArrayIdx < stickyUserMsgIndices.length) {
            const nextTlIdx = stickyUserMsgIndices[nextArrayIdx];
            const nextVItem = virtualItems.find(v => v.index === nextTlIdx);
            if (nextVItem) {
              const nextMsgTop = nextVItem.start - scrollTop;
              if (nextMsgTop < stickyBottom) {
                hideForNextMsg = true;
              }
            }
          }
        }
        const item = timeline[bestIdx];
        const msg = item.data as Message;
        const msgId = msg._id;
        const prevId = prevStickyMsgIdRef.current;
        if (msgId !== prevId) {
          if (prevId !== null && prevId !== '__fallback__' && prevStickyIdxRef.current !== null) {
            stickyGapRef.current = { prevIdx: prevStickyIdxRef.current };
          }
          prevStickyMsgIdRef.current = msgId;
          prevStickyIdxRef.current = bestIdx;
        }
        let inGap = false;
        if (stickyGapRef.current) {
          const gapVItem = virtualItems.find(v => v.index === stickyGapRef.current!.prevIdx);
          if (gapVItem) {
            const prevMsgTopVisual = gapVItem.start - scrollTop;
            if (prevMsgTopVisual < headerHeight + 200) {
              inGap = true;
            } else {
              stickyGapRef.current = null;
            }
          } else {
            stickyGapRef.current = null;
          }
        }
        setActiveStickyMsg({ index: bestIdx, content: msg.content!, id: msgId });
        setStickyMsgVisible(!inGap && !hideForNextMsg);
      } else if (serverStickyFallback && scrollTop > headerHeight + 40) {
        prevStickyMsgIdRef.current = serverStickyFallback.id;
        prevStickyIdxRef.current = null;
        stickyGapRef.current = null;
        setActiveStickyMsg({ index: -1, content: serverStickyFallback.content, id: serverStickyFallback.id });
        setStickyMsgVisible(true);
      } else if (fallbackStickyContent && scrollTop > el.clientHeight) {
        prevStickyMsgIdRef.current = '__fallback__';
        prevStickyIdxRef.current = null;
        stickyGapRef.current = null;
        setActiveStickyMsg({ index: -1, content: fallbackStickyContent, id: '__fallback__' });
        setStickyMsgVisible(true);
      } else {
        prevStickyMsgIdRef.current = null;
        prevStickyIdxRef.current = null;
        stickyGapRef.current = null;
        setActiveStickyMsg(null);
        setStickyMsgVisible(false);
      }
    };
    check();
    const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(check); } };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [stickyUserMsgIndices, virtualizer, timeline, fallbackStickyContent, serverStickyFallback, headerHeight, stickyDisabled]);

  useImperativeHandle(ref, () => ({
    scrollToMessage: (messageId: string) => {
      const itemIndex = timeline.findIndex(item => {
        if (item.type === 'message') {
          return item.data._id === messageId;
        }
        return false;
      });

      if (itemIndex >= 0) {
        setUserScrolled(true);
        virtualizer.scrollToIndex(itemIndex, { align: "center", behavior: "smooth" });
        setHighlightedMessageId(messageId);
        setTimeout(() => setHighlightedMessageId(null), 2000);
      }
    }
  }), [timeline, virtualizer]);

  useMountEffect(() => {
    const scrollContainer = containerRef.current;
    if (!scrollContainer) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
      isNearBottomRef.current = isNearBottom;

      setIsScrollable(scrollHeight > clientHeight + 10);
      setIsNearTop(scrollTop < 300);

      const scrolledDown = scrollTop > lastScrollTopRef.current + 2;
      const scrolledUp = scrollTop < lastScrollTopRef.current - 2;
      lastScrollTopRef.current = scrollTop;

      if (scrolledUp && !isNearBottom && !paginationCooldownRef.current) {
        setUserScrolled(true);
      }

      if (isNearBottom && scrolledDown && !isVirtualizerCorrectingRef.current) {
        setUserScrolled(false);
      }

      if (scrollProgressRef.current) {
        const ctx = scrollCtxRef.current;
        const totalMessages = ctx.messageCount;
        const isPaginated = totalMessages > 150;
        let progress: number;
        if (isPaginated) {
          const items = virtualizer.getVirtualItems();
          if (items.length > 0) {
            const centerIdx = items[Math.floor(items.length / 2)].index;
            const tLen = Math.max(ctx.timelineLen, 1);
            progress = totalMessages > 0 ? Math.max(0, Math.min(1, (ctx.loadedStartIndex + (centerIdx / tLen) * ctx.messagesLen) / totalMessages)) : 1;
          } else {
            progress = 0;
          }
        } else {
          const maxScroll = scrollHeight - clientHeight;
          progress = maxScroll > 0 ? scrollTop / maxScroll : 1;
        }
        scrollProgressRef.current.style.height = `${progress * 100}%`;
      }

      const pp = paginationPropsRef.current;
      if (scrollTop < 300 && pp.hasMoreAbove && !pp.isLoadingOlder && !pp.isLoadingNewer && !paginationCooldownRef.current && pp.onLoadOlder) {
        scrollAnchorRef.current = scrollHeight;
        isPaginatingRef.current = true;
        pp.onLoadOlder();
      }

      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      if (distanceFromBottom < 300 && pp.hasMoreBelow && !pp.isLoadingNewer && !pp.isLoadingOlder && !paginationCooldownRef.current && pp.onLoadNewer) {
        isPaginatingRef.current = true;
        pp.onLoadNewer();
      }
    };

    scrollContainer.addEventListener("scroll", handleScroll);
    requestAnimationFrame(handleScroll);

    return () => {
      scrollContainer.removeEventListener("scroll", handleScroll);
    };
  });

  const totalSize = virtualizer.getTotalSize();
  useWatchEffect(() => {
    if (!scrollProgressRef.current) return;
    const totalMessages = conversation?.message_count || messages.length;
    const isPaginated = totalMessages > 150;
    let progress: number;
    if (isPaginated) {
      const items = virtualizer.getVirtualItems();
      if (items.length === 0) return;
      const centerIdx = items[Math.floor(items.length / 2)].index;
      const loadedMessages = messages.length;
      const startOffset = conversation?.loaded_start_index ?? 0;
      const tLen = Math.max(timeline.length, 1);
      progress = totalMessages > 0 ? Math.max(0, Math.min(1, (startOffset + (centerIdx / tLen) * loadedMessages) / totalMessages)) : 1;
    } else {
      const scrollEl = containerRef.current;
      if (!scrollEl) return;
      const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
      progress = maxScroll > 0 ? scrollEl.scrollTop / maxScroll : 1;
    }
    scrollProgressRef.current.style.height = `${progress * 100}%`;
    setNavScrollProgress(progress);
  }, [conversation?.message_count, messages.length, timeline.length, conversation?.loaded_start_index, totalSize]);

  // Restore scroll position after loading older messages.
  // useLayoutEffect runs after DOM mutations but before paint, so the user never sees
  // the intermediate state. scrollHeight delta = exact size of prepended content.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (scrollAnchorRef.current === null) return;
    const scrollContainer = containerRef.current;
    if (!scrollContainer) return;
    const delta = scrollContainer.scrollHeight - scrollAnchorRef.current;
    scrollAnchorRef.current = null;
    if (delta <= 0) return;
    paginationCooldownRef.current = true;
    scrollContainer.scrollTop += delta; // += keeps current position, doesn't reset it
    requestAnimationFrame(() => {
      paginationCooldownRef.current = false;
    });
  }, [timeline.length]);

  const [initialScrollDone, setInitialScrollDone] = useState(false);

  // New messages auto-scroll (only after initial scroll is done)
  useWatchEffect(() => {
    const hasNewMessages = timeline.length > prevTimelineLengthRef.current;
    prevTimelineLengthRef.current = timeline.length;

    if (!initialScrollDone) return;

    if (hasNewMessages && isPaginatingRef.current) {
      isPaginatingRef.current = false;
      return;
    }

    if (hasNewMessages && timeline.length > 0 && !highlightQuery && !targetMessageId && !window.location.hash && !hasMoreBelow && !userScrolledRef.current) {
      const el = containerRef.current;
      if (el) {
        el.style.scrollBehavior = "smooth";
        virtualizer.scrollToIndex(timeline.length - 1, { align: "end" });
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
          lastScrollTopRef.current = el.scrollTop;
          setTimeout(() => { el.style.scrollBehavior = ""; }, 500);
        });
      }
      setUserScrolled(false);
    }
  }, [timeline.length, virtualizer, highlightQuery, targetMessageId, hasMoreBelow, initialScrollDone]);

  useWatchEffect(() => {
    if (isWaitingForResponse && containerRef.current && isNearBottomRef.current && !userScrolledRef.current) {
      virtualizer.scrollToIndex(timeline.length - 1, { align: "end" });
      requestAnimationFrame(() => {
        if (containerRef.current) {
          lastScrollTopRef.current = containerRef.current.scrollTop;
        }
      });
    }
  }, [isWaitingForResponse, virtualizer, timeline.length]);

  // Initial scroll: snap to bottom using virtualizer (not raw scrollHeight which desyncs with estimates)
  useLayoutEffect(() => {
    if (timeline.length === 0 || initialScrollDone) return;
    if (window.location.hash || highlightQuery) {
      setInitialScrollDone(true);
      return;
    }
    const sc = containerRef.current;
    if (sc) {
      paginationCooldownRef.current = true;
      virtualizer.scrollToIndex(timeline.length - 1, { align: "end" });
      lastScrollTopRef.current = sc.scrollTop;
      // Fallback: clear cooldown after virtualizer has had time to measure
      setTimeout(() => { paginationCooldownRef.current = false; }, 1000);
    }
    setInitialScrollDone(true);
  }, [timeline.length, highlightQuery, initialScrollDone, virtualizer]);

  // Detect user scroll-up via wheel events (fires synchronously, no race condition
  // with the async scroll event). This ensures userScrolledRef is set before any
  // re-render or auto-correct effect can run.
  useWatchEffect(() => {
    const sc = containerRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) setUserScrolled(true);
    };
    sc.addEventListener('wheel', onWheel, { passive: true });
    return () => sc.removeEventListener('wheel', onWheel);
  }, [setUserScrolled]);

  // Auto-pin: observe scroll container size changes and pin to bottom.
  // Uses ResizeObserver instead of rAF loop to avoid fighting with the
  // virtualizer's item measurement or triggering spurious pagination.
  useWatchEffect(() => {
    if (!initialScrollDone) return;
    if (window.location.hash || highlightQuery) return;
    const sc = containerRef.current;
    if (!sc) return;
    let lastHeight = sc.scrollHeight;
    let cooldownTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (userScrolledRef.current) return;
      const newHeight = sc.scrollHeight;
      if (newHeight !== lastHeight) {
        lastHeight = newHeight;
        sc.scrollTop = sc.scrollHeight - sc.clientHeight;
        lastScrollTopRef.current = sc.scrollTop;
      }
      if (paginationCooldownRef.current) {
        if (cooldownTimer) clearTimeout(cooldownTimer);
        cooldownTimer = setTimeout(() => { paginationCooldownRef.current = false; }, 300);
      }
    });
    if (sc.firstElementChild) {
      observer.observe(sc.firstElementChild);
    }
    observer.observe(sc);
    return () => { observer.disconnect(); if (cooldownTimer) clearTimeout(cooldownTimer); };
  }, [initialScrollDone, highlightQuery]);

  // Scroll after jump to start/end
  useWatchEffect(() => {
    if (jumpDirectionRef.current && timeline.length > 0) {
      const dir = jumpDirectionRef.current;
      jumpDirectionRef.current = null;
      paginationCooldownRef.current = true;
      setTimeout(() => {
        if (dir === 'start') {
          virtualizer.scrollToIndex(0, { align: "start" });
          setUserScrolled(true);
        } else {
          virtualizer.scrollToIndex(timeline.length - 1, { align: "end" });
          setUserScrolled(false);
        }
        requestAnimationFrame(() => {
          paginationCooldownRef.current = false;
        });
      }, 50);
    }
  }, [timeline, virtualizer]);

  const scrollToHash = useCallback(() => {
    if (!timeline.length || targetMessageId || !window.location.hash) return;
    const targetId = window.location.hash.slice(1);
    const itemIndex = timeline.findIndex(item => {
      if (item.type === 'message') {
        return `msg-${item.data._id}` === targetId;
      } else if (item.type === 'commit') {
        return `commit-${item.data.sha}` === targetId;
      }
      return false;
    });
    if (itemIndex >= 0) {
      setUserScrolled(true);
      setTimeout(() => {
        virtualizer.scrollToIndex(itemIndex, { align: "center", behavior: "smooth" });
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }, 100);
    }
  }, [timeline, virtualizer, targetMessageId]);

  useWatchEffect(() => {
    scrollToHash();
  }, [timeline.length, virtualizer, targetMessageId]);

  useEventListener("hashchange", () => scrollToHash());

  // Scroll to highlighted message from search
  useWatchEffect(() => {
    if (highlightedMessageId && timeline.length > 0 && !hasScrolledToHighlight.current) {
      const itemIndex = timeline.findIndex(item => {
        if (item.type === 'message') {
          return item.data._id === highlightedMessageId;
        }
        return false;
      });
      if (itemIndex >= 0) {
        hasScrolledToHighlight.current = true;
        setUserScrolled(true);
        // react-virtual's scrollToIndex assigns scrollTop but relies on the
        // scroll event to recompute its visible range. Programmatic scrollTop
        // writes don't always emit that event reliably (same-value writes,
        // batching), so we nudge the range ourselves. Retries handle the case
        // where item-size estimates for unmeasured items above shift the
        // target offset — once those items render and measure, the next
        // scrollToIndex corrects onto the real position.
        const align = { align: "center" as const, behavior: "auto" as const };
        const retry = () => {
          virtualizer.scrollToIndex(itemIndex, align);
          containerRef.current?.dispatchEvent(new Event('scroll', { bubbles: true }));
        };
        setTimeout(retry, 150);
        setTimeout(retry, 300);
        setTimeout(retry, 500);
        setTimeout(retry, 900);
      }
    }
  }, [highlightedMessageId, timeline, virtualizer]);

  useWatchEffect(() => {
    if (!targetMessageId || timeline.length === 0 || hasScrolledToTarget.current) {
      return;
    }

    const itemIndex = timeline.findIndex(item => {
      if (item.type === 'message') {
        return item.data._id === targetMessageId;
      }
      return false;
    });

    if (itemIndex >= 0) {
      hasScrolledToTarget.current = true;
      setUserScrolled(true);
      const container = containerRef.current;
      if (!container) return;

      virtualizer.scrollToIndex(itemIndex, { align: "start" });

      const stickyOffset = 50;
      const scrollElToTop = (el: Element) => {
        const elRect = el.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        container.scrollTop += elRect.top - containerRect.top - stickyOffset;
      };
      let findAttempts = 0;
      const scrollToElement = () => {
        findAttempts++;
        const el = container.querySelector(`[data-index="${itemIndex}"]`);
        if (el) {
          scrollElToTop(el);
          let settleCount = 0;
          const settle = () => {
            settleCount++;
            const freshEl = container.querySelector(`[data-index="${itemIndex}"]`);
            if (freshEl) {
              const rect = freshEl.getBoundingClientRect();
              const containerRect = container.getBoundingClientRect();
              const off = rect.top - containerRect.top - stickyOffset;
              if (Math.abs(off) > 2) scrollElToTop(freshEl);
              if (Math.abs(off) <= 2 || settleCount >= 15) {
                setHighlightedMessageId(targetMessageId);
                setTimeout(() => setHighlightedMessageId(null), 3000);
                if (window.location.hash) {
                  history.replaceState(null, "", window.location.pathname + window.location.search);
                }
                return;
              }
            }
            requestAnimationFrame(settle);
          };
          requestAnimationFrame(settle);
        } else if (findAttempts < 20) {
          virtualizer.scrollToIndex(itemIndex, { align: "start" });
          requestAnimationFrame(() => setTimeout(scrollToElement, 100));
        }
      };
      setTimeout(scrollToElement, 300);
    }
  }, [targetMessageId, timeline, virtualizer]);

  useEventListener("keydown", (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "c") {
      e.preventDefault();
      setCollapsed((c) => !c);
    }
  });

  const title = cleanTitle(conversation?.title || "New Session");
  const truncatedTitle = title.length > 60 ? title.slice(0, 57) + "..." : title;
  const latestMessageTimestamp = useMemo(() => {
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i];
      if (item.type === 'message' && (item.data as Message).role !== 'system') {
        return item.timestamp;
      }
    }
    return undefined;
  }, [timeline]);
  const lastActivityAt = latestMessageTimestamp ?? conversation?.updated_at ?? conversation?.started_at ?? 0;
  const lastMessageRole = useMemo(() => {
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i];
      if (item.type === 'message' && (item.data as Message).role !== 'system') {
        return (item.data as Message).role;
      }
    }
    return undefined;
  }, [timeline]);
  const [now, setNow] = useState(Date.now());
  useMountEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  });
  const isSessionConnected = !!conversation && (conversation.status === "active" || !!firstActiveForkId) && (now - lastActivityAt) < 5 * 60 * 1000;
  const isWorking = isSessionConnected && (now - lastActivityAt) < 45 * 1000 && lastMessageRole === "assistant";
  const isConversationLive = isWorking;
  const isSessionDisconnected = !!conversation && (conversation.status === "active" || !!firstActiveForkId) && managedSession !== undefined && managedSession.managed === false && !isSessionConnected;
  const sessionAge = now - (conversation?.started_at ?? 0);
  const isNewEmptySession = !!conversation && conversation.status === "active" && (conversation.message_count ?? 0) === 0;
  const isSessionStarting = isNewEmptySession && !managedSession?.managed && sessionAge < 30_000;
  const isSessionReady = isNewEmptySession && !isSessionStarting && (managedSession?.managed === true || sessionAge >= 30_000) && sessionAge < 120_000;

  useWatchEffect(() => {
    if (conversation) {
      document.title = `codecast | ${truncatedTitle}`;
    }
    return () => {
      document.title = "codecast";
    };
  }, [truncatedTitle, conversation]);

  const forkMessages = firstActiveForkId ? inboxMessages[firstActiveForkId] : undefined;

  const toolCallMap = useMemo(() => {
    const map: Record<string, string> = {};
    const sources = [conversation?.messages, forkMessages].filter(Boolean) as Message[][];
    for (const msgs of sources) {
      for (const msg of msgs) {
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            map[tc.id] = tc.name;
          }
        }
      }
    }
    return map;
  }, [conversation?.messages, forkMessages]);

  const globalToolResultMap = useMemo(() => {
    const map: Record<string, ToolResult> = {};
    const sources = [conversation?.messages, forkMessages].filter(Boolean) as Message[][];
    for (const msgs of sources) {
      for (const msg of msgs) {
        if (msg.tool_results) {
          for (const tr of msg.tool_results) {
            map[tr.tool_use_id] = tr;
          }
        }
      }
    }
    return map;
  }, [conversation?.messages, forkMessages]);

  const globalImageMap = useMemo(() => {
    const map: Record<string, ImageData> = {};
    const sources = [conversation?.messages, forkMessages].filter(Boolean) as Message[][];
    for (const msgs of sources) {
      for (const msg of msgs) {
        if (msg.images) {
          for (const img of msg.images) {
            if (img.tool_use_id) {
              map[img.tool_use_id] = img;
            }
          }
        }
      }
    }
    return map;
  }, [conversation?.messages, forkMessages]);

  const taskSubjectMap = useMemo(() => {
    const createInputs: Record<string, string> = {};
    const idMap: Record<string, string> = {};
    if (conversation?.messages) {
      for (const msg of conversation.messages) {
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            if (tc.name === "TaskCreate") {
              try {
                const inp = JSON.parse(tc.input);
                if (inp.subject) createInputs[tc.id] = String(inp.subject);
              } catch {}
            }
          }
        }
        if (msg.tool_results) {
          for (const tr of msg.tool_results) {
            if (createInputs[tr.tool_use_id]) {
              const m = tr.content.match(/Task #(\d+)/);
              if (m) idMap[m[1]] = createInputs[tr.tool_use_id];
            }
          }
        }
      }
    }
    return idMap;
  }, [conversation?.messages]);

  const conversationTasks = useQuery(
    api.tasks.webListByConversation,
    conversation?._id && isConvexId(conversation._id) ? { conversationId: conversation._id } : "skip"
  );

  const taskRecordMap = useMemo(() => {
    const byTitle: Record<string, TaskRecord> = {};
    const byLocalId: Record<string, TaskRecord> = {};
    if (conversationTasks) {
      for (const t of conversationTasks) {
        byTitle[t.title] = t;
      }
    }
    if (taskSubjectMap) {
      for (const [localId, title] of Object.entries(taskSubjectMap)) {
        if (byTitle[title]) byLocalId[localId] = byTitle[title];
      }
    }
    return { byTitle, byLocalId };
  }, [conversationTasks, taskSubjectMap]);

  const getPreviousNonToolResultMessage = (index: number): Message | null => {
    for (let i = index - 1; i >= 0; i--) {
      const prevItem = timeline[i];
      if (!prevItem || prevItem.type !== "message") continue;
      const prevMsg = prevItem.data as Message;
      if (prevMsg.role === "user") {
        const kind = userMsgKindMap.get(prevMsg._id);
        if (kind?.kind === 'tool_results_only' || kind?.kind === 'command') continue;
      }
      return prevMsg;
    }
    return null;
  };

  const renderItem = (item: TimelineItem, index: number) => {
    if (!item || index < 0 || index >= timeline.length) return null;
    if (item.type === 'commit') {
      const commit = item.data;
      return (
        <CommitCard
          key={commit._id}
          sha={commit.sha}
          message={commit.message}
          timestamp={commit.timestamp}
          filesChanged={commit.files_changed}
          insertions={commit.insertions}
          deletions={commit.deletions}
          authorName={commit.author_name}
          authorEmail={commit.author_email}
          repository={commit.repository}
          files={commit.files}
        />
      );
    }

    if (item.type === 'pull_request') {
      const pr = item.data;
      return (
        <PRCard
          key={pr._id}
          _id={pr._id}
          number={pr.number}
          title={pr.title}
          body={pr.body}
          state={pr.state}
          repository={pr.repository}
          author_github_username={pr.author_github_username}
          head_ref={pr.head_ref}
          base_ref={pr.base_ref}
          additions={pr.additions}
          deletions={pr.deletions}
          changed_files={pr.changed_files}
          commits_count={pr.commits_count}
          files={pr.files}
          created_at={pr.created_at}
          updated_at={pr.updated_at}
          merged_at={pr.merged_at}
        />
      );
    }

    const msg = item.data as Message;
    if (msg.role === "system") {
      if (collapsed) return null;
      return <SystemBlock key={msg._id} content={msg.content || ""} subtype={msg.subtype} timestamp={msg.timestamp} messageUuid={msg.message_uuid} messageId={msg._id} conversationId={conversation?._id} onOpenComments={() => setCommentMessageId(msg._id as Id<"messages">)} onStartShareSelection={handleStartShareSelection} />;
    }

    if (msg.role === "user") {
      const kind = userMsgKindMap.get(msg._id) ?? { kind: 'normal' as const };
      switch (kind.kind) {
        case 'tool_results_only':
        case 'compaction_prompt':
        case 'noise':
        case 'empty':
        case 'poll_response':
          return null;
        case 'command': {
          if (collapsed) return null;
          const cmdType = getCommandType(msg.content!);
          if (cmdType === "output" || cmdType === "error" || cmdType === "caveat") {
            return <CommandStatusLine key={msg._id} content={msg.content!} timestamp={msg.timestamp} />;
          }
          const cmdNameMatch = msg.content!.match(/<command-(?:name|message)>([^<]*)<\/command-(?:name|message)>/);
          const cmdN = cmdNameMatch?.[1]?.replace(/^\//, "");
          const cmdRest = cleanContent(msg.content!);
          const cmdDisplay = cmdN ? (cmdRest ? `/${cmdN} ${cmdRest}` : `/${cmdN}`) : (cmdRest || msg.content!);
          const cmdUserName = conversation?.user?.name || conversation?.user?.email?.split("@")[0];
          return <UserPrompt key={msg._id} content={cmdDisplay} images={msg.images} timestamp={msg.timestamp} messageId={msg._id} messageUuid={msg.message_uuid} conversationId={conversation?._id} collapsed={collapsed} userName={cmdUserName} avatarUrl={conversation?.user?.avatar_url} onOpenComments={() => setCommentMessageId(msg._id as Id<"messages">)} isHighlighted={highlightedMessageId === msg._id} shareSelectionMode={shareSelectionMode} isSelectedForShare={selectedMessageIds.has(msg._id)} onToggleShareSelection={() => handleToggleMessageSelection(msg._id)} onStartShareSelection={handleStartShareSelection} onForkFromMessage={handleForkFromMessage} forkChildren={msg.message_uuid ? forkPointMap[msg.message_uuid] : undefined} onBranchSwitch={msg.message_uuid ? (convId) => handleBranchSwitch(msg.message_uuid!, convId) : undefined} activeBranchId={msg.message_uuid ? activeBranches[msg.message_uuid] : undefined} loadingBranchId={loadingBranchId} isPending={!!msg._isOptimistic} isQueued={!!msg._isQueued} mainMessageCount={msg.message_uuid ? conversation?.main_message_counts_by_fork?.[msg.message_uuid] : undefined} />;
        }
        case 'interrupt':
          if (collapsed) return null;
          return <InterruptStatusLine key={msg._id} label={kind.tone === 'amber' ? "turn aborted" : undefined} tone={kind.tone} />;
        case 'continuation':
          if (collapsed) return null;
          return <InterruptStatusLine key={msg._id} label="session continued" tone="sky" />;
        case 'skill_expansion':
          return <SkillExpansionBlock key={msg._id} content={msg.content!} timestamp={msg.timestamp} cmdName={kind.cmdName} collapsed={collapsed} />;
        case 'task_notification':
          if (collapsed) return null;
          return <TaskNotificationLine key={msg._id} content={msg.content!} timestamp={msg.timestamp} agentNameToChildMap={agentNameToChildMap} />;
        case 'scheduled_task':
          if (collapsed) return null;
          return <ScheduledTaskBlock key={msg._id} content={msg.content!} timestamp={msg.timestamp} />;
        case 'task_prompt':
          return null;
        case 'compaction_summary':
          return <CompactionSummaryBlock key={msg._id} content={msg.content!} />;
        case 'plan':
          return <PlanBlock key={msg._id} content={kind.planContent} timestamp={msg.timestamp} collapsed={collapsed} messageId={msg._id} conversationId={conversation?._id} onOpenComments={() => setCommentMessageId(msg._id as Id<"messages">)} onStartShareSelection={handleStartShareSelection} />;
        case 'teammate_events':
          return <TeammateEventsBlock key={msg._id} content={msg.content || ""} timestamp={msg.timestamp} />;
        case 'normal': {
          if (!msg.content?.trim() && !msg.images?.some(img => !img.tool_use_id)) return null;
          const userName = conversation?.user?.name || conversation?.user?.email?.split("@")[0];
          return <UserPrompt key={msg._id} content={msg.content || ""} images={msg.images} timestamp={msg.timestamp} messageId={msg._id} messageUuid={msg.message_uuid} conversationId={conversation?._id} collapsed={collapsed} userName={userName} avatarUrl={conversation?.user?.avatar_url} onOpenComments={() => setCommentMessageId(msg._id as Id<"messages">)} isHighlighted={highlightedMessageId === msg._id} shareSelectionMode={shareSelectionMode} isSelectedForShare={selectedMessageIds.has(msg._id)} onToggleShareSelection={() => handleToggleMessageSelection(msg._id)} onStartShareSelection={handleStartShareSelection} onForkFromMessage={handleForkFromMessage} forkChildren={msg.message_uuid ? forkPointMap[msg.message_uuid] : undefined} onBranchSwitch={msg.message_uuid ? (convId) => handleBranchSwitch(msg.message_uuid!, convId) : undefined} activeBranchId={msg.message_uuid ? activeBranches[msg.message_uuid] : undefined} loadingBranchId={loadingBranchId} isPending={!!msg._isOptimistic} isQueued={!!msg._isQueued} mainMessageCount={msg.message_uuid ? conversation?.main_message_counts_by_fork?.[msg.message_uuid] : undefined} />;
        }
      }
    }

    if (msg.role === "assistant") {
      if (msg.subtype === "workflow_event") {
        return <WorkflowEventBlock key={msg._id} content={msg.content || ""} workflowRun={workflowRun as any} onGateChoice={handleGateChoice} gateResponding={gateResponding} />;
      }

      const prevMsgForCompaction = getPreviousNonToolResultMessage(index);
      if (prevMsgForCompaction?.role === "user" && userMsgKindMap.get(prevMsgForCompaction._id)?.kind === 'compaction_prompt') {
        const summaryContent = extractCompactionSummaryContent(msg.content || "");
        if (!summaryContent) return null;
        return <CompactionSummaryBlock key={msg._id} content={summaryContent} />;
      }

      // Skip empty "No response requested." messages
      if (stripSystemTags(msg.content || "").trim() === "No response requested.") return null;

      // Find previous VISIBLE non-commit assistant item to determine if this is first in assistant sequence
      // Skip invisible assistant messages (those whose content is only system tags with no tool calls/thinking/images)
      let prevIdx = index - 1;
      while (prevIdx >= 0) {
        const checkItem = timeline[prevIdx];
        if (checkItem.type === 'commit') { prevIdx--; continue; }
        if (checkItem.type !== 'message') break;
        const checkMsg = checkItem.data as Message;
        if (checkMsg.role !== 'assistant') break;
        const hasVisibleContent = (checkMsg.content && stripSystemTags(checkMsg.content).trim().length > 0)
          || (checkMsg.tool_calls && checkMsg.tool_calls.length > 0)
          || (showThinking && checkMsg.thinking && checkMsg.thinking.trim().length > 0)
          || (checkMsg.images && checkMsg.images.length > 0);
        if (hasVisibleContent) break;
        prevIdx--;
      }
      const prevItem = prevIdx >= 0 ? timeline[prevIdx] : null;
      const prevMsg = prevItem?.type === 'message' ? (prevItem.data as Message) : null;
      const isFirstInSequence = !prevMsg || prevMsg.role !== "assistant";

      // Find the sequence start ID (first assistant message with text in this sequence)
      let sequenceStartId = msg._id;
      for (let i = index - 1; i >= 0; i--) {
        const checkItem = timeline[i];
        if (checkItem.type !== 'message') continue;
        const checkMsg = checkItem.data as Message;
        if (checkMsg.role === "user") break;
        if (checkMsg.role === "assistant" && checkMsg.content && checkMsg.content.trim().length > 0) {
          sequenceStartId = checkMsg._id;
        }
      }

      const isSequenceExpanded = expandedSequences.has(sequenceStartId);

      // Compute all message IDs in the current run (for sharing)
      const runMessageIds: string[] = [];
      for (let i = index; i >= 0; i--) {
        const checkItem = timeline[i];
        if (!checkItem) break;
        if (checkItem.type !== 'message') continue;
        const checkMsg = checkItem.data as Message;
        if (checkMsg.role === "user") break;
        if (checkMsg.role === "assistant") runMessageIds.unshift(checkMsg._id);
      }
      for (let i = index + 1; i < timeline.length; i++) {
        const checkItem = timeline[i];
        if (!checkItem) break;
        if (checkItem.type !== 'message') continue;
        const checkMsg = checkItem.data as Message;
        if (checkMsg.role === "user") break;
        if (checkMsg.role === "assistant") runMessageIds.push(checkMsg._id);
      }

      // In collapsed mode, only render messages if sequence is expanded OR this is the first with text
      if (collapsed && !isSequenceExpanded) {
        const hasMsgPlanWrite = msg.tool_calls?.some(isPlanWriteToolCall);
        if (!hasMsgPlanWrite) {
          const hasTextContent = msg.content && msg.content.trim().length > 0;

          // Check if there's an earlier assistant message with text content in this sequence
          let hasEarlierTextContent = false;
          for (let i = index - 1; i >= 0; i--) {
            const checkItem = timeline[i];
            if (checkItem.type !== 'message') continue;
            const checkMsg = checkItem.data as Message;
            if (checkMsg.role === "user") break;
            if (checkMsg.role === "assistant" && checkMsg.content && checkMsg.content.trim().length > 0) {
              hasEarlierTextContent = true;
              break;
            }
          }

          // Skip this message if: no text content, or there's earlier text content in sequence
          if (!hasTextContent || hasEarlierTextContent) {
            return null;
          }
        }
      }

      const relevantToolResults = msg.tool_calls
        ?.map(tc => msg.tool_results?.find((tr) => tr.tool_use_id === tc.id) || globalToolResultMap[tc.id])
        .filter((tr): tr is ToolResult => tr !== undefined);

      // Determine effective collapsed state for this message
      const effectiveCollapsed = collapsed && !isSequenceExpanded;

      return (
        <AssistantBlock
          key={msg._id}
          content={msg.content}
          timestamp={msg.timestamp}
          thinking={msg.thinking}
          showThinking={showThinking}
          toolCalls={msg.tool_calls}
          toolResults={relevantToolResults}
          images={msg.images}
          messageId={msg._id}
          messageUuid={msg.message_uuid}
          conversationId={conversation?._id}
          collapsed={effectiveCollapsed}
          childConversationMap={conversation?.child_conversation_map}
          childConversations={conversation?.child_conversations}
          agentNameToChildMap={agentNameToChildMap}
          showHeader={effectiveCollapsed ? true : (isFirstInSequence || (collapsed && msg._id === sequenceStartId))}
          onOpenComments={() => setCommentMessageId(msg._id as Id<"messages">)}
          toolCallChangeSelectionMap={toolCallChangeSelectionMap}
          isHighlighted={highlightedMessageId === msg._id}
          isSequenceExpanded={isSequenceExpanded}
          runMessageIds={runMessageIds}
          onToggleCollapsed={collapsed ? () => {
            setExpandedSequences(prev => {
              const next = new Set(prev);
              if (next.has(sequenceStartId)) {
                next.delete(sequenceStartId);
              } else {
                next.add(sequenceStartId);
              }
              return next;
            });
          } : undefined}
          showCollapseButton={collapsed && isSequenceExpanded && isFirstInSequence}
          shareSelectionMode={shareSelectionMode}
          isSelectedForShare={selectedMessageIds.has(msg._id)}
          onToggleShareSelection={() => handleToggleMessageSelection(msg._id)}
          onStartShareSelection={handleStartShareSelection}
          agentType={conversation?.agent_type}
          taskSubjectMap={taskSubjectMap}
          taskRecordMap={taskRecordMap}
          onForkFromMessage={handleForkFromMessage}
          forkChildren={msg.message_uuid ? forkPointMap[msg.message_uuid] : undefined}
          onBranchSwitch={msg.message_uuid ? (convId) => handleBranchSwitch(msg.message_uuid!, convId) : undefined}
          activeBranchId={msg.message_uuid ? activeBranches[msg.message_uuid] : undefined}
          loadingBranchId={loadingBranchId}
          mainMessageCount={msg.message_uuid ? conversation?.main_message_counts_by_fork?.[msg.message_uuid] : undefined}
          model={conversation?.model}
          onSendInlineMessage={handleSendInlineMessage}
          isConversationActive={conversation?.status === "active"}
          globalImageMap={globalImageMap}
        />
      );
    }

    return null;
  };

  return (
    <HighlightContext.Provider value={highlightQuery}>
    <ImageGalleryProvider>
    <main className="relative flex flex-col bg-sol-bg h-full" onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-sol-bg/80 backdrop-blur-sm" style={{ animation: "fadeIn 150ms ease-out" }}>
          <div className="border-2 border-dashed border-sol-cyan rounded-xl p-12 text-center">
            <svg className="w-10 h-10 mx-auto mb-3 text-sol-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
            <p className="text-sol-cyan text-sm font-medium">Drop images to attach</p>
          </div>
        </div>
      )}
      <header ref={headerRef} className={`border-b border-black/10 bg-sol-bg-alt shrink-0 relative ${embedded ? "sticky top-0 z-20 bg-sol-bg-alt" : ""} ${!embedded || isZenMode ? deskClass : ""} ${isImageLightboxActive ? "invisible" : ""} ${hideHeader ? "hidden" : ""}`}>
        <div className="px-2 py-0.5 sm:py-1">
          <div className="flex items-center gap-2 min-w-0 select-none">
            <div className="flex items-center gap-2 min-w-0 overflow-hidden flex-1">
            {isZenMode && (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => useInboxStore.getState().updateClientUI({ zen_mode: false })}
                      className="p-1 rounded text-sol-text-dim/20 hover:text-sol-text-dim/50 transition-colors"
                    >
                      <Maximize2 className="w-3 h-3 -scale-x-100" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Exit zen mode ({formatShortcutLabel('ui.zenToggle')})</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {headerLeft}
            {isRenaming ? (
              <input
                ref={renameInputRef}
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={() => {
                  const trimmed = renameDraft.trim();
                  if (trimmed && trimmed !== cleanTitle(conversation?.title || "")) {
                    useInboxStore.getState().renameSession(conversation!._id, trimmed);
                  }
                  useInboxStore.setState({ renamingSessionId: null });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.currentTarget.blur(); }
                  if (e.key === "Escape") { useInboxStore.setState({ renamingSessionId: null }); }
                }}
                className="text-xs sm:text-sm font-medium text-sol-text-secondary min-w-0 bg-transparent border-b border-sol-cyan focus:outline-none"
              />
            ) : (
              <h1
                className="text-xs sm:text-sm font-medium text-sol-text-secondary truncate min-w-0 cursor-default"
                title={conversation?.messages?.[0]?.content ? cleanContent(conversation.messages[0].content)?.slice(0, 200) ?? undefined : undefined}
                onDoubleClick={() => { if (isOwner) useInboxStore.setState({ renamingSessionId: conversation!._id }); }}
              >
                {truncatedTitle}
              </h1>
            )}

            {isSessionDisconnected && (managedSession?.agent_status === "starting" || managedSession?.agent_status === "resuming" || managedSession?.agent_status === "connected") ? (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] flex-shrink-0 bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/30">
                <span className="w-1.5 h-1.5 rounded-full bg-sol-cyan animate-pulse" />
                <span className="hidden sm:inline">{managedSession?.agent_status === "starting" ? "Starting" : managedSession?.agent_status === "resuming" ? "Resuming" : "Delivering"}</span>
                <span className="sm:hidden">{managedSession?.agent_status === "starting" ? "Start" : managedSession?.agent_status === "resuming" ? "Rsum" : "Dlvr"}</span>
              </span>
            ) : isSessionDisconnected ? (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] flex-shrink-0 bg-sol-text-dim/5 text-sol-text-dim/50 border border-sol-text-dim/10">
                <span className="w-1.5 h-1.5 rounded-full bg-sol-text-dim/30" />
                <span className="hidden sm:inline">Disconnected</span>
                <span className="sm:hidden">Disc</span>
              </span>
            ) : null}

            {!isSessionDisconnected && (managedSession?.agent_status === "working" || managedSession?.agent_status === "thinking" || managedSession?.agent_status === "compacting" || managedSession?.agent_status === "permission_blocked" || managedSession?.agent_status === "connected" || managedSession?.agent_status === "starting" || managedSession?.agent_status === "resuming" || (!managedSession?.agent_status && isConversationLive)) && (
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] flex-shrink-0 ${
                managedSession?.agent_status === "thinking" ? "bg-sol-violet/10 text-sol-violet border border-sol-violet/30" :
                managedSession?.agent_status === "compacting" ? "bg-amber-500/10 text-amber-400 border border-amber-500/30" :
                managedSession?.agent_status === "permission_blocked" ? "bg-sol-orange/10 text-sol-orange border border-sol-orange/30" :
                managedSession?.agent_status === "connected" || managedSession?.agent_status === "starting" || managedSession?.agent_status === "resuming" ? "bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/30" :
                "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${
                  managedSession?.agent_status === "thinking" ? "bg-sol-violet" :
                  managedSession?.agent_status === "compacting" ? "bg-amber-400" :
                  managedSession?.agent_status === "permission_blocked" ? "bg-sol-orange" :
                  managedSession?.agent_status === "connected" || managedSession?.agent_status === "starting" || managedSession?.agent_status === "resuming" ? "bg-sol-cyan" :
                  "bg-emerald-400"
                }`} />
                <span className="hidden sm:inline">{managedSession?.agent_status === "thinking" ? "Thinking" :
                 managedSession?.agent_status === "compacting" ? "Compacting" :
                 managedSession?.agent_status === "permission_blocked" ? "Needs Input" :
                 managedSession?.agent_status === "starting" ? "Starting" :
                 managedSession?.agent_status === "resuming" ? "Resuming" :
                 managedSession?.agent_status === "connected" ? "Connected" :
                 "Working"}</span>
                <span className="sm:hidden">{managedSession?.agent_status === "thinking" ? "Think" :
                 managedSession?.agent_status === "compacting" ? "Compact" :
                 managedSession?.agent_status === "permission_blocked" ? "Input" :
                 managedSession?.agent_status === "starting" ? "Start" :
                 managedSession?.agent_status === "resuming" ? "Rsum" :
                 managedSession?.agent_status === "connected" ? "Conn" :
                 "Work"}</span>
              </span>
            )}

            {conversation && (
              <ConversationMetadata
                agentType={conversation.agent_type}
                model={conversation.model}
                startedAt={conversation.started_at}
                messageCount={conversation.message_count}
                shortId={conversation.short_id}
                conversationId={conversation._id}
              />
            )}

            {(conversation as any)?.active_plan && (
              <PlanBadge plan={(conversation as any).active_plan} />
            )}
            {(conversation as any)?.active_task && (
              <TaskBadge task={(conversation as any).active_task} />
            )}

            {conversation && (
              <TooltipProvider delayDuration={300}>
              <div className="flex items-center gap-1 flex-shrink-0 overflow-hidden ml-auto">

                {conversation.parent_conversation_id && (
                  <Link
                    href={convLink(conversation.parent_conversation_id)}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/30 hover:bg-sol-cyan/20 transition-colors"
                    title="View parent conversation"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                    </svg>
                    Parent
                  </Link>
                )}

                {conversation.git_branch && (
                  <span
                    className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/5 text-emerald-400/80 border border-emerald-500/20 max-w-[150px] cursor-default"
                    title={conversation.git_branch}
                    onClick={() => {
                      if (conversation.git_remote_url) {
                        const match = conversation.git_remote_url.match(/github\.com[:/](.+?)(?:\.git)?$/);
                        if (match) {
                          window.open(`https://github.com/${match[1]}/tree/${conversation.git_branch}`, '_blank');
                        }
                      }
                    }}
                    style={conversation.git_remote_url ? { cursor: 'pointer' } : undefined}
                  >
                    <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
                    </svg>
                    <span className="truncate">{conversation.git_branch}</span>
                  </span>
                )}

                {!isOwner && conversation.user && (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-sol-violet/10 text-sol-violet border border-sol-violet/30">
                    {conversation.user.avatar_url ? (
                      <img
                        src={conversation.user.avatar_url}
                        alt={conversation.user.name || "User"}
                        className="w-4 h-4 rounded-full"
                      />
                    ) : (
                      <span className="w-4 h-4 rounded-full bg-sol-violet/20 flex items-center justify-center text-[8px]">
                        {(conversation.user.name || conversation.user.email || "?").charAt(0).toUpperCase()}
                      </span>
                    )}
                    {conversation.user.name || conversation.user.email?.split("@")[0] || "Teammate"}
                  </span>
                )}

                {headerExtra}

                {(highlightQuery || isLocalSearchOpen) && (
                  <div className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-amber-200/50 dark:bg-amber-800/30 text-amber-800 dark:text-amber-200">
                    <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    {isLocalSearchOpen ? (
                      <input
                        ref={localSearchInputRef}
                        type="text"
                        value={localSearchQuery}
                        onChange={(e) => setLocalSearchQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") onClearHighlight();
                          if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? goToPrevMatch() : goToNextMatch(); }
                        }}
                        placeholder="Search messages..."
                        className="bg-transparent border-none outline-none text-xs w-24 sm:w-32 placeholder:text-amber-600/50 dark:placeholder:text-amber-400/50"
                        autoFocus
                      />
                    ) : (
                      <span className="max-w-[100px] truncate">{highlightQuery}</span>
                    )}
                    {matchInstances.length > 0 && (
                      <>
                        <span className="text-[10px] opacity-70 ml-1">
                          {currentMatchIndex + 1}/{matchInstances.length}
                        </span>
                        <button
                          onClick={goToPrevMatch}
                          className="p-0.5 hover:bg-amber-300/50 dark:hover:bg-amber-700/40 rounded transition-colors"
                          title="Previous match (Shift+Enter)"
                        >
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                          </svg>
                        </button>
                        <button
                          onClick={goToNextMatch}
                          className="p-0.5 hover:bg-amber-300/50 dark:hover:bg-amber-700/40 rounded transition-colors"
                          title="Next match (Enter)"
                        >
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </button>
                      </>
                    )}
                    {matchInstances.length === 0 && highlightQuery && (
                      <span className="text-[10px] opacity-70 ml-1">0 matches</span>
                    )}
                    <button
                      onClick={onClearHighlight}
                      className="p-0.5 hover:bg-amber-300/50 dark:hover:bg-amber-700/40 rounded transition-colors ml-1"
                      title="Clear search"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                )}

                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => {
                        if (isLocalSearchOpen) {
                          onClearHighlight();
                        } else {
                          if (propHighlightQuery) propClearHighlight?.();
                          setIsLocalSearchOpen(true);
                          setLocalSearchQuery("");
                          setTimeout(() => localSearchInputRef.current?.focus(), 0);
                        }
                      }}
                      className={`p-1 rounded hover:bg-sol-bg-alt transition-colors ${isLocalSearchOpen ? "text-sol-cyan" : "text-sol-text-dim hover:text-sol-text-secondary"}`}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                      </svg>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Search in conversation</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => { setCollapsed((c) => !c); setExpandedSequences(new Set()); }}
                      className={`p-1 rounded hover:bg-sol-bg-alt transition-colors ${collapsed ? "text-sol-cyan" : "text-sol-text-dim hover:text-sol-text-secondary"}`}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                        {collapsed
                          ? <><path d="M15 3h6v6M14 10l6.1-6.1M9 21H3v-6M10 14l-6.1 6.1" /></>
                          : <><path d="M4 14h6v6M3 21l6.1-6.1M20 10h-6V4M21 3l-6.1 6.1" /></>
                        }
                      </svg>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{collapsed ? "Expand messages" : "Collapse messages"} ({formatShortcutLabel('conv.collapseAll')})</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => { copyToClipboard(window.location.href).then(() => toast.success("Link copied")).catch(() => toast.error("Failed to copy")); }}
                      className="p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                      </svg>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Copy link{firstActiveForkId ? " (includes branch)" : ""}</TooltipContent>
                </Tooltip>

                {managedSession?.tmux_session && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => { copyToClipboard(`tmux attach -t '${managedSession.tmux_session}'`).then(() => toast.success("tmux attach copied")).catch(() => toast.error("Failed to copy")); }}
                        className="p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Copy tmux attach</TooltipContent>
                  </Tooltip>
                )}

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                      </svg>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {effectiveIsOwner && conversation?.session_id && (
                      <>
                        <DropdownMenuItem onSelect={() => {
                          setTimeout(async () => {
                            try {
                              await restartSession({ conversation_id: (effectiveConversationId || conversation._id) as Id<"conversations"> });
                              toast.success("Restarting session, retrying pending messages...");
                            } catch { toast.error("Failed to restart session"); }
                          });
                        }}>
                          <svg className="w-3 h-3 mr-1.5 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                          Kill & restart
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => {
                          setTimeout(async () => {
                            try {
                              await repairSession({ conversation_id: (effectiveConversationId || conversation._id) as Id<"conversations"> });
                              toast.success("Repairing session, retrying pending messages...");
                            } catch { toast.error("Failed to repair session"); }
                          });
                        }}>
                          <svg className="w-3 h-3 mr-1.5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          </svg>
                          Repair session
                        </DropdownMenuItem>
                      </>
                    )}
                    {conversation?.short_id && (
                      <DropdownMenuItem onSelect={() => { setTimeout(() => { copyToClipboard(conversation.short_id!).then(() => toast.success("ID copied")).catch(() => toast.error("Failed to copy")); }); }}>
                        <svg className="w-3 h-3 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
                        </svg>
                        Copy ID ({conversation.short_id})
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => setTimeout(handleCopyAll)}>
                      <svg className="w-3 h-3 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      Copy all messages
                    </DropdownMenuItem>
                    {isOwner && (
                      <DropdownMenuItem onSelect={() => setTimeout(() => useInboxStore.setState({ renamingSessionId: conversation._id }))}>
                        <svg className="w-3 h-3 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                        Rename
                        <MenuKeyCaps action="session.rename" />
                      </DropdownMenuItem>
                    )}
                    {conversation?.session_id && (
                      <>
                        <DropdownMenuItem onSelect={() => setTimeout(() => handleCopyResumeCommand("claude"))}>
                          <svg className="w-3 h-3 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                          Copy Claude resume
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setTimeout(() => handleCopyResumeCommand("codex"))}>
                          <svg className="w-3 h-3 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                          Copy Codex resume
                        </DropdownMenuItem>
                      </>
                    )}
                    {isOwner && (
                      <DropdownMenuItem onSelect={() => {
                        setTimeout(async () => {
                          try {
                            await toggleFavoriteMutation({ conversation_id: conversation._id });
                            toast.success(conversation.is_favorite ? "Removed from favorites" : "Added to favorites");
                          } catch { toast.error("Failed to update favorite"); }
                        });
                      }}>
                        <svg className={`w-3 h-3 mr-1.5 ${conversation.is_favorite ? "text-amber-400" : ""}`} fill={conversation.is_favorite ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                        </svg>
                        {conversation.is_favorite ? "Remove from favorites" : "Add to favorites"}
                        <MenuKeyCaps action="conv.favorite" />
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setShowThinking((s) => !s)}>
                      {showThinking ? "Hide thinking" : "Show thinking"}
                      <MenuKeyCaps action="conv.toggleThinking" />
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => {
                      const next = !stickyDisabled;
                      updateUI({ sticky_headers_disabled: next });
                      if (next) { setStickyMsgVisible(false); setActiveStickyMsg(null); }
                    }}>
                      {stickyDisabled ? "Enable sticky headers" : "Disable sticky headers"}
                    </DropdownMenuItem>
                    {conversation.git_branch && (
                      <DropdownMenuItem onClick={() => setDiffExpanded(!diffExpanded)}>
                        {diffExpanded ? "Hide git diff" : "Show git diff"}
                        <MenuKeyCaps action="conv.toggleDiff" />
                      </DropdownMenuItem>
                    )}
                    {conversation.parent_conversation_id && (
                      <DropdownMenuItem asChild>
                        <Link href={convLink(conversation.parent_conversation_id)}>
                          View parent conversation
                        </Link>
                      </DropdownMenuItem>
                    )}
                    {conversation.forked_from_details && (
                      <DropdownMenuItem asChild>
                        <Link href={conversation.forked_from_details.share_token ? `/share/${conversation.forked_from_details.share_token}` : convLink(conversation.forked_from_details.conversation_id)}>
                          <svg className="w-3 h-3 mr-1.5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
                          </svg>
                          Forked from @{conversation.forked_from_details.username}
                        </Link>
                      </DropdownMenuItem>
                    )}
                    {isOwner && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>
                            <svg className="w-3 h-3 mr-1.5 text-sol-violet" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 5H4m0 0l4 4m-4-4l4-4" />
                            </svg>
                            Switch agent
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            {(["claude_code", "codex", "cursor", "gemini"] as const)
                              .filter((t) => t !== conversation.agent_type)
                              .map((t) => (
                                <DropdownMenuItem
                                  key={t}
                                  onClick={() => {
                                    const sessionId = useInboxStore.getState().switchAgent(conversation._id.toString(), t);
                                    if (!sessionId) return;
                                    forkFromMessage({
                                      conversation_id: conversation._id.toString(),
                                      target_agent_type: t,
                                      session_id: sessionId,
                                    }).catch((err) => {
                                      toast.error(err instanceof Error ? err.message : "Failed to switch agent");
                                    });
                                  }}
                                >
                                  <AgentTypeIcon agentType={t} />
                                  <span className="ml-1.5">{formatAgentType(t)}</span>
                                </DropdownMenuItem>
                              ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      </>
                    )}
                    {((conversation.fork_children && conversation.fork_children.length > 0) || conversation.forked_from) && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => toggleTreePanel()}>
                          <svg className="w-3 h-3 mr-1.5 text-sol-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                          </svg>
                          Fork tree
                          <MenuKeyCaps action="conv.toggleTree" />
                        </DropdownMenuItem>
                      </>
                    )}
                    {((conversation.fork_count ?? 0) > 0 || (conversation.fork_children?.length ?? 0) > 0) && (
                      <DropdownMenuItem disabled>
                        <svg className="w-3 h-3 mr-1.5 text-sol-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                        </svg>
                        {conversation.fork_count || conversation.fork_children?.length || 0} fork{(conversation.fork_count || conversation.fork_children?.length || 0) === 1 ? '' : 's'}
                      </DropdownMenuItem>
                    )}
                    {(conversation.compaction_count ?? 0) > 0 && (
                      <DropdownMenuItem disabled>
                        <svg className="w-3 h-3 mr-1.5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                        </svg>
                        {conversation.compaction_count} compaction{conversation.compaction_count === 1 ? '' : 's'}
                      </DropdownMenuItem>
                    )}
                    {conversation.child_conversations && conversation.child_conversations.filter(c => c.is_subagent).length > 0 && (
                      <>
                        <DropdownMenuItem disabled className="text-[10px] uppercase tracking-wider text-sol-text-dim">
                          Subagents ({conversation.child_conversations.filter(c => c.is_subagent).length})
                        </DropdownMenuItem>
                        {conversation.child_conversations.filter(c => c.is_subagent).map((child) => (
                          <DropdownMenuItem key={child._id} asChild>
                            <Link href={convLink(child._id)} className="text-xs">
                              <svg className="w-3 h-3 mr-1.5 text-sol-cyan flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                              </svg>
                              <span className="truncate">{child.title}</span>
                            </Link>
                          </DropdownMenuItem>
                        ))}
                      </>
                    )}
                    {taskStats && (
                      <DropdownMenuItem disabled>
                        Tasks: {taskStats.done}/{taskStats.total}
                      </DropdownMenuItem>
                    )}
                    {latestUsage && (
                      <>
                        <DropdownMenuSeparator />
                        <div className="px-2 py-1.5">
                          <UsageDisplay usage={latestUsage} />
                        </div>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              </TooltipProvider>
            )}
            </div>
            {headerEnd && <div className="flex-shrink-0">{headerEnd}</div>}
          </div>
          {taskStats && <TaskProgressRow taskStats={taskStats} />}
        </div>
        {conversation && (
          <div className="absolute top-full right-3 mt-12 z-30">
            <MessageNavButton
              conversationId={conversation._id}
              currentMessageId={activeStickyMsg?.id ?? null}
              scrollProgress={navScrollProgress}
              onScrollToMessage={(messageId) => {
                const itemIndex = timeline.findIndex(item =>
                  item.type === 'message' && item.data._id === messageId
                );
                if (itemIndex >= 0) {
                  setUserScrolled(true);
                  virtualizer.scrollToIndex(itemIndex, { align: "center", behavior: "smooth" });
                  setHighlightedMessageId(messageId);
                  setTimeout(() => setHighlightedMessageId(null), 2000);
                }
              }}
            />
          </div>
        )}
        {subHeaderContent}
      </header>

      {stickyMsgVisible && activeStickyMsg && (
        <div
          ref={stickyElRef}
          className="absolute left-0 right-0 z-[15] px-2 sm:px-3 md:px-4 pt-1 cursor-pointer"
          style={{ top: headerHeight }}
          onClick={() => {
            if (activeStickyMsg.index >= 0) {
              virtualizer.scrollToIndex(activeStickyMsg.index, { align: 'start' });
            } else if (activeStickyMsg.id && activeStickyMsg.id !== '__fallback__' && conversation?._id) {
              useInboxStore.setState({
                pendingNavigateId: conversation._id,
                pendingScrollToMessageId: activeStickyMsg.id,
              });
            } else if (onJumpToStart) {
              onJumpToStart();
            }
          }}
        >
          <div className="max-w-7xl mx-auto">
            <div className="bg-sol-blue/10 px-4 py-3 rounded-b-lg border border-sol-blue/30 backdrop-blur-md shadow-lg relative group">
              <button
                className="absolute top-1.5 right-1.5 p-0.5 rounded hover:bg-sol-blue/20 text-sol-text-dim hover:text-sol-text opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={(e) => {
                  e.stopPropagation();
                  dismissedStickyIdsRef.current.add(activeStickyMsg!.id);
                  setStickyMsgVisible(false);
                  setActiveStickyMsg(null);
                }}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <div className="flex items-center gap-2 mb-1">
                <UserIcon avatarUrl={conversation?.user?.avatar_url} />
                <span className="text-sol-blue text-xs font-medium">{conversation?.user?.name || conversation?.user?.email?.split("@")[0] || "You"}</span>
              </div>
              <div className="text-sm text-sol-text whitespace-pre-wrap break-words line-clamp-3 pl-8 pr-4">{activeStickyMsg.content.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "").replace(/<teammate-message\s+[^>]*>[\s\S]*?<\/teammate-message>/g, "").replace(/\[Image[:\s][^\]]*\]/gi, "").replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, "").trim()}</div>
            </div>
          </div>
        </div>
      )}

      {diffExpanded && gitDiffData && (gitDiffData.git_diff?.trim() || gitDiffData.git_diff_staged?.trim()) && (
        <GitDiffPanel
          gitDiff={gitDiffData.git_diff}
          gitDiffStaged={gitDiffData.git_diff_staged}
        />
      )}

      <div className={`flex-1 min-h-0 relative flex ${isImageLightboxActive ? "invisible" : ""}`}>
      <div ref={containerRef} className="flex-1 min-h-0 overflow-y-auto" style={{ overflowAnchor: "none" }}>
        <div className="flex flex-col">
        {(!conversation || timeline.length === 0) ? (
          <div className={`flex-1 flex flex-col items-center gap-3 ${hideHeader ? "justify-start pt-6" : "justify-start pt-16"}`}>
            {conversation && (
              <ErrorBoundary name="ProjectSwitcher" level="inline">
                <ProjectSwitcher conversation={conversation} />
              </ErrorBoundary>
            )}
          </div>
        ) : (
          <>
          {conversation?.parent_conversation_id && !hasMoreAbove && (
            <div className="max-w-7xl mx-auto px-2 sm:px-3 md:px-4 pt-2 pb-1">
              <Link
                href={convLink(conversation.parent_conversation_id)}
                className="inline-flex items-center gap-1.5 text-xs text-sol-cyan/70 hover:text-sol-cyan transition-colors"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                </svg>
                Spawned from parent session
              </Link>
            </div>
          )}
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: "100%",
              position: "relative",
            }}
          >
            {/* Earlier messages indicator at top */}
            {hasMoreAbove && !isLoadingOlder && (
              <div className="sticky top-0 z-10 flex justify-center py-1 sm:py-2 pointer-events-none">
                <div className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-0.5 sm:py-1 rounded-full bg-sol-bg border border-sol-border text-sol-text-muted0 text-[10px] sm:text-xs shadow-sm pointer-events-auto">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                  </svg>
                  {conversation?.message_count && messages.length < conversation.message_count
                    ? `${conversation.message_count - messages.length} earlier messages`
                    : "Scroll up to load more"}
                </div>
              </div>
            )}
            {/* Loading indicator at top */}
            {isLoadingOlder && (
              <div className="sticky top-0 z-10 flex justify-center py-1 sm:py-2 pointer-events-none">
                <div className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1 sm:py-1.5 rounded-full bg-sol-bg-alt/90 border border-sol-border text-sol-text-muted text-[10px] sm:text-xs pointer-events-auto">
                  <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Loading older messages...
                </div>
              </div>
            )}
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const item = timeline[virtualItem.index];
              const content = renderItem(item, virtualItem.index);
              const isSearchDimmed = highlightQuery && allMatchingMessageIds.length > 0 && item.type === 'message' && !allMatchingMessageIds.includes((item.data as Message)._id);
              const itemId = item.type === 'message' ? (item.data as Message)._id : item.type === 'commit' ? `commit-${(item.data as any).sha || (item.data as any)._id}` : `pr-${(item.data as any)._id}`;
              const isNew = newItemIdsRef.current.has(itemId);
              const isForkSelected = forkSelectionIdx !== null && forkSelectionIdx === virtualItem.index;
              const isBelowForkSelection = forkSelectionIdx !== null && virtualItem.index > forkSelectionIdx;
              return (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualItem.start}px)`,
                    ...(content ? {} : { height: 0, overflow: "hidden" }),
                  }}
                >
                  {content && (
                    <div className={`max-w-7xl mx-auto px-4 sm:px-5 md:px-6 ${collapsed ? "py-0.5" : "py-0.5 sm:py-1"} ${isNew ? "animate-message-in" : ""} ${isForkSelected ? "ring-2 ring-sol-cyan/60 bg-sol-cyan/5 rounded-lg" : ""} ${isBelowForkSelection ? "opacity-30 pointer-events-none" : ""} transition-opacity`}>
                      {content}
                      {virtualItem.index === timeline.length - 1 && !hasMoreBelow && (now - lastActivityAt) > 5 * 60 * 1000 && (
                        <div className="flex items-center gap-3 mt-5 mb-1">
                          <div className="flex-1 h-px opacity-40" style={{ background: 'linear-gradient(to right, transparent, var(--sol-border))' }} />
                          <span className="text-[11px] text-sol-text-dim/60">{formatRelativeTime(lastActivityAt)}</span>
                          <div className="flex-1 h-px opacity-40" style={{ background: 'linear-gradient(to left, transparent, var(--sol-border))' }} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {/* Loading indicator at bottom */}
            {isLoadingNewer && (
              <div className="sticky bottom-0 z-10 flex justify-center py-2 pointer-events-none">
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-sol-bg-alt/90 border border-sol-border text-sol-text-muted text-xs pointer-events-auto">
                  <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Loading newer messages...
                </div>
              </div>
            )}
            {/* Later messages indicator at bottom - hide when near top to avoid confusing placement */}
            {hasMoreBelow && !isLoadingNewer && !isNearTop && (
              <div className="sticky bottom-0 z-10 flex justify-center py-2 pointer-events-none">
                <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-sol-bg border border-sol-border text-sol-text-muted0 text-xs shadow-sm pointer-events-auto">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                  Scroll down to load more
                </div>
              </div>
            )}
          </div>
          {conversation?.child_conversations && conversation.child_conversations.length > 0 && !hasMoreBelow && (() => {
            const childMap = conversation.child_conversation_map || {};
            const messageUuids = new Set(messages.map(m => m.message_uuid).filter(Boolean));
            const renderedInlineIds = new Set(
              Object.entries(childMap)
                .filter(([uuid]) => messageUuids.has(uuid))
                .map(([, childId]) => childId)
            );
            const continuationChildren = conversation.child_conversations.filter(c => !renderedInlineIds.has(c._id) && !c.is_subagent && c._id !== conversation._id);
            if (continuationChildren.length === 0) return null;
            return (
              <div className="max-w-7xl mx-auto px-2 sm:px-3 md:px-4 pt-3 pb-8">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-sol-text-secondary uppercase tracking-wider font-medium">Continued in</span>
                  {continuationChildren.map((child) => (
                    <Link
                      key={child._id}
                      href={convLink(child._id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs bg-sol-cyan/15 text-sol-text-secondary border border-sol-cyan/30 hover:bg-sol-cyan/25 hover:text-sol-text transition-colors truncate max-w-[400px]"
                    >
                      <svg className="w-2.5 h-2.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                      </svg>
                      {child.title}
                    </Link>
                  ))}
                </div>
              </div>
            );
          })()}
          </>
        )}

        </div>
      </div>

      {conversation && (
        <ForkTreePanel
          conversationId={conversation._id.toString()}
          open={forkTreePanelOpen}
          onClose={toggleTreePanel}
          activeBranchIds={activeBranchIdSet}
          onSwitchToConversation={handleTreeSwitchConversation}
        />
      )}
      </div>

      {showMessageInput && conversation && !(pendingPermissions && pendingPermissions.length > 0) && (
        <div ref={messageInputRef} className="relative">
          {!effectiveIsOwner ? (
            <NonOwnerMessageInput
              conversation={conversation}
              onForkReply={handleForkReply}
              autoFocusInput={autoFocusInput}
            />
          ) : (
            <>
              {workflowRun?.status === "paused" && workflowRun.gate_prompt ? (
                <div className="absolute left-0 right-0 bottom-full flex items-center gap-2 px-4 py-1.5 bg-sol-bg border-t border-sol-magenta/20 text-xs">
                  <span className="text-sol-magenta font-semibold shrink-0">Gate</span>
                  <span className="text-sol-text-muted truncate flex-1">{workflowRun.gate_prompt}</span>
                  {workflowRun.gate_choices?.map(choice => (
                    <button
                      key={choice.key}
                      onClick={() => handleGateRespond(choice.key)}
                      disabled={gateResponding}
                      className="shrink-0 px-1.5 py-0.5 text-[10px] font-mono font-medium text-sol-magenta border border-sol-magenta/30 rounded hover:bg-sol-magenta/10 transition-colors disabled:opacity-40"
                    >
                      [{choice.key}] {choice.label.replace(/^\[.\]\s*/, "")}
                    </button>
                  ))}
                </div>
              ) : (
                conversation.status === "active" && (conversation.message_count ?? 0) === 0 && (!conversation.messages || conversation.messages.length === 0) && isOwner && (
                  <div className="absolute left-0 right-0 bottom-full">
                    <AgentSwitcher
                      conversation={conversation}
                      showWorkflow={showWorkflow}
                      onToggleWorkflow={() => setShowWorkflow(v => !v)}
                      selectedWorkflowId={selectedWorkflowId}
                      onSelectWorkflow={setSelectedWorkflowId}
                      workflows={workflows as any}
                    />
                  </div>
                )
              )}
              <MessageInput key={conversation.session_id || conversation._id} conversationId={firstActiveForkId || conversation._id} status={conversation.status} embedded={embedded} onSendAndAdvance={onSendAndAdvance} onSendAndDismiss={onSendAndDismiss} autoFocusInput={autoFocusInput} initialDraft={conversation.draft_message} isWaitingForResponse={isWaitingForResponse} isThinking={isThinking} isConversationLive={isConversationLive} isSessionDisconnected={conversation.is_workflow_primary ? false : isSessionDisconnected} isSessionStarting={isSessionStarting} isSessionReady={isSessionReady} sessionId={conversation.session_id} agentType={conversation.agent_type} agentStatus={isSessionDisconnected || conversation.status !== "active" ? undefined : managedSession?.agent_status as any} deliveryStatus={managedSession?.agent_status as any} pendingPermissionsCount={pendingPermissions?.length ?? 0} hasAskUserQuestion={hasAskUserQuestion} selectedMessageContent={selectedMessageContent} selectedMessageUuid={selectedMessageUuid} onClearSelection={handleClearSelection} onForkFromMessage={handleForkFromMessage} onSendEscape={handleSendEscape} onOpenNavigator={handleOpenNavigator} onPopulateInput={populateInputRef} permissionMode={effectiveMode} onCycleMode={handleCycleMode} onMessageSent={handleMessageSent} onLightboxChange={setIsImageLightboxActive} onDropFiles={dropFilesRef} onWorkflowLaunch={showWorkflow && selectedWorkflowId ? handleWorkflowLaunch : undefined} onGateSend={workflowRun?.status === "paused" ? handleGateRespond : undefined} skills={sessionSkills} filePaths={sessionFilePaths} mentionItemsRef={mentionItemsRef} onMentionQuery={handleMentionQuery} />
            </>
          )}
          {navigatorOpen && navigatorUserMessages && navigatorUserMessages.length > 0 && (
            <MessageNavigator
              userMessages={navigatorUserMessages}
              onRewind={handleNavigatorRewind}
              onFork={handleNavigatorFork}
              onClose={handleNavigatorClose}
              forkPointMap={forkPointMap}
              onBranchSwitch={handleBranchSwitch}
              activeBranches={activeBranches}
            />
          )}
        </div>
      )}

      {timeline.length > 0 && (
        <div className="absolute right-3 sm:right-8 z-30 flex items-stretch gap-2.5" style={{ bottom: Math.max(messageInputHeight + 16, 115) }}>
          <div className="flex flex-col gap-2">
              <button
                onClick={() => {
                  if (hasMoreAbove && onJumpToStart) {
                    jumpDirectionRef.current = 'start';
                    onJumpToStart();
                  } else {
                    virtualizer.scrollToIndex(0, { align: "start" });
                    requestAnimationFrame(() => {
                      if (containerRef.current) containerRef.current.scrollTop = 0;
                    });
                  }
                }}
                className={`p-1.5 sm:p-2 rounded-full bg-sol-bg-alt border border-sol-border shadow-lg hover:bg-sol-cyan hover:text-white transition-all ${((!isNearTop && isScrollable) || hasMoreAbove) ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                aria-label="Scroll to top"
              >
                {isLoadingOlder ? (
                  <svg className="w-4 h-4 sm:w-5 sm:h-5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                  </svg>
                )}
              </button>
              <button
                onClick={() => {
                  if (hasMoreBelow && onJumpToEnd) {
                    jumpDirectionRef.current = 'end';
                    onJumpToEnd();
                  } else {
                    virtualizer.scrollToIndex(timeline.length - 1, { align: "end" });
                    requestAnimationFrame(() => {
                      if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight;
                    });
                  }
                  setUserScrolled(false);
                }}
                className={`p-1.5 sm:p-2 rounded-full bg-sol-bg-alt border border-sol-border shadow-lg hover:bg-sol-cyan hover:text-white transition-all ${((userScrolled && isScrollable) || hasMoreBelow) ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                aria-label="Scroll to bottom"
              >
                {isLoadingNewer ? (
                  <svg className="w-4 h-4 sm:w-5 sm:h-5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                  </svg>
                )}
              </button>
          </div>
          {(isScrollable || hasMoreAbove || hasMoreBelow) && (
            <div className="hidden sm:block w-2 self-stretch bg-sol-base02 rounded-full overflow-hidden">
              <div
                ref={scrollProgressRef}
                className="w-full bg-sol-green/80 rounded-full"
                style={{ height: '0%', transition: 'height 0.15s ease-out' }}
              />
            </div>
          )}
        </div>
      )}

      {pendingPermissions && pendingPermissions.length > 0 && (
        <div className={`border-t border-sol-border/40 shrink-0 ${embedded ? "-mx-[9999px] px-[9999px]" : ""}`}>
          <div className="max-w-7xl mx-auto px-2 sm:px-3 md:px-4 py-1.5">
            <PermissionStack
              permissions={pendingPermissions as any}
              onAllowAll={
                (conversation?.agent_type ?? "claude_code") === "claude_code" &&
                effectiveIsOwner &&
                conversation?.status === "active" &&
                effectiveMode !== "bypassPermissions"
                  ? handleEnableBypass
                  : undefined
              }
            />
          </div>
        </div>
      )}

      {commentMessageId && conversation && (
        <CommentPanel
          conversationId={conversation._id as Id<"conversations">}
          messageId={commentMessageId}
          onClose={() => setCommentMessageId(null)}
        />
      )}

      {shareSelectionMode && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-sol-bg-alt border border-sol-border rounded-lg shadow-xl px-4 py-3">
          <span className="text-sm text-sol-text-secondary">
            {selectedMessageIds.size} message{selectedMessageIds.size !== 1 ? "s" : ""} selected
          </span>
          <button
            onClick={handleCancelShareSelection}
            className="px-3 py-1.5 text-sm text-sol-text-dim hover:text-sol-text-secondary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirmShare}
            disabled={selectedMessageIds.size === 0 || isCreatingShareLink}
            className="px-4 py-1.5 text-sm bg-sol-cyan hover:bg-sol-cyan/80 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isCreatingShareLink ? "Creating..." : "Copy share link"}
          </button>
        </div>
      )}
    </main>
    </ImageGalleryProvider>
    </HighlightContext.Provider>
  );
});
