"use client";
import { useState, useRef, useCallback } from "react";
import { ArrowUp } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { isParkedDispatchError } from "../store/mutativeMiddleware";
import { useOpenLinkedSession } from "../hooks/useOpenLinkedSession";
import { soundNewSession } from "../lib/sounds";
import { AgentTypeIcon } from "./AgentTypeIcon";
import { fromConvexAgentType, type AgentClientId } from "@codecast/shared/contracts";

type AgentKey = AgentClientId;
const escapeContext = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
// Preserve exact prose and command examples in the context body (notably doc
// edit strings) while preventing body content from closing the envelope.
const protectContextBody = (value: string) =>
  value.replace(/<\/context>/gi, "<\\/context>");
const AGENT_TYPES: { key: AgentKey; convex: string; label: string; active: string }[] = [
  { key: "claude", convex: "claude_code", label: "Claude", active: "bg-sol-yellow/20 text-sol-yellow border-sol-yellow/50" },
  { key: "codex", convex: "codex", label: "Codex", active: "bg-emerald-500/20 text-emerald-400 border-emerald-500/50" },
  { key: "cursor", convex: "cursor", label: "Cursor", active: "bg-purple-500/20 text-purple-400 border-purple-500/50" },
  { key: "gemini", convex: "gemini", label: "Gemini", active: "bg-blue-500/20 text-blue-400 border-blue-500/50" },
  { key: "opencode", convex: "opencode", label: "OpenCode", active: "bg-orange-500/20 text-orange-400 border-orange-500/50" },
  { key: "pi", convex: "pi", label: "pi", active: "bg-teal-500/20 text-teal-400 border-teal-500/50" },
  { key: "grok", convex: "grok", label: "Grok", active: "bg-sol-text/15 text-sol-text border-sol-text/40" },
];

interface ContextChatInputProps {
  contextType: string;
  contextTitle: string;
  getContextBody: () => string;
  placeholder?: string;
  linkedObjectId?: string;
  projectPath?: string;
  conversationId?: string;
}

export function ContextChatInput({
  contextType,
  contextTitle,
  getContextBody,
  placeholder,
  linkedObjectId,
  projectPath: projectPathProp,
  conversationId,
}: ContextChatInputProps) {
  const [message, setMessage] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const currentAgent = useInboxStore((s) => s.currentConversation.agentType || "claude_code");
  const [selectedAgent, setSelectedAgent] = useState<AgentKey | null>(null);
  // Same gesture as clicking a card in the object's "Sessions" list: on a
  // working page (task/doc) the session opens as the split companion beside
  // the page, immediately and from the local stub; elsewhere it routes.
  const openLinkedSession = useOpenLinkedSession();

  // Registry chokepoint, never a hand-rolled ternary: a client missing from a
  // ternary silently collapses to the fallback branch.
  const agentKey: AgentKey = selectedAgent || fromConvexAgentType(currentAgent);
  const isExpanded = isFocused || message.length > 0;

  const resetHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, []);

  const handleSubmit = useCallback(() => {
    const text = message.trim();
    if (!text) return;

    const body = getContextBody();
    const idAttr = linkedObjectId ? ` id="${escapeContext(linkedObjectId)}"` : "";
    let contextBody = body || "";
    // Prepend editing instructions for docs so the model knows how to modify them
    if (contextType === "doc" && linkedObjectId && body) {
      contextBody = `[Document ID: ${linkedObjectId}]\nTo edit this document use: cast doc edit ${linkedObjectId} --old "text to find" --new "replacement text"\nTo update title: cast doc edit ${linkedObjectId} --title "New Title"\nDo not use file Read/Write/Edit tools — this document lives in the database, not the filesystem.\n\n${body}`;
    }
    const contextBlock = contextBody
      ? `<context type="${escapeContext(contextType)}" title="${escapeContext(contextTitle)}"${idAttr}>\n${protectContextBody(contextBody)}\n</context>\n\n`
      : `[Viewing ${contextType}: ${contextTitle}]\n\n`;
    const fullMessage = contextBlock + text;

    const store = useInboxStore.getState();
    if (conversationId) {
      const clientId = store.addOptimisticMessage(conversationId, fullMessage);
      store.sendMessage(conversationId, fullMessage, undefined, clientId);
      openLinkedSession({ _id: conversationId });
      setMessage("");
      setSelectedAgent(null);
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      return;
    }
    const { projectPath, gitRoot } = store.currentConversation;
    const convexAgentType = AGENT_TYPES.find(a => a.key === agentKey)?.convex || "claude_code";

    soundNewSession();

    // Resolve linked object for optimistic rendering (task badge in header/sidebar).
    // Task's own project_path is preferred over the viewer's currentConversation, which may belong
    // to an unrelated repo (~/src etc). The server will further resolve via team directory mappings
    // if neither is set, so the daemon command always gets the right cwd.
    let activeTask: { _id: string; short_id: string; title: string; status: string } | undefined;
    let taskDerivedPath: string | undefined;
    if (contextType === "task" && linkedObjectId) {
      const t = store.tasks[linkedObjectId] as any;
      if (t) {
        activeTask = { _id: t._id, short_id: t.short_id, title: t.title, status: t.status };
        if (t.project_path) taskDerivedPath = t.project_path;
      }
    }
    const contextPath = projectPathProp || taskDerivedPath;
    const path = contextPath || projectPath || gitRoot;
    // The viewer's gitRoot describes currentConversation's repo and only
    // applies when the path came from there too. Sent alongside a task-derived
    // path it routes the daemon into whatever repo the viewer had open — the
    // daemon prefers git_root over project_path when resolving a cwd.
    const resolvedGitRoot = contextPath || gitRoot || path;
    const { stubId: sid } = store.beginOptimisticSession({
      agentType: convexAgentType,
      projectPath: path,
      gitRoot: resolvedGitRoot,
      create: (stubId) => store.createSession({
        agent_type: convexAgentType,
        project_path: path,
        git_root: resolvedGitRoot,
        session_id: stubId,
        ...(linkedObjectId
          ? { linked_object: { type: contextType, id: linkedObjectId } }
          : {}),
      }),
    });

    // beginOptimisticSession owns the stub shape and rekey lifecycle. Enrich its
    // task row only for immediate header/sidebar rendering; createSession links
    // task/doc/plan context atomically on the server.
    if (activeTask) {
      store.syncRecord("conversations", sid, {
        active_task_id: linkedObjectId,
        active_task: activeTask,
      });
      store.syncRecord("sessions", sid, { active_task: activeTask });
    }
    const clientId = store.addOptimisticMessage(sid, fullMessage);

    setMessage("");
    setSelectedAgent(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    // The stub row already exists (beginOptimisticSession wrote it), so this
    // paints the new session with its optimistic message before any server
    // round-trip; the companion follows the stub→convex rekey via the
    // attended-conversation mirror in DashboardLayout.
    openLinkedSession({ _id: sid });

    // Resolve through the shared tracked-create/by_session_id lifecycle, then
    // issue the durable send with the SAME client id as the optimistic bubble.
    // If the create remains parked past the resolver window, leave the message
    // pending: the stranded-stub sweep re-creates and re-sends it idempotently.
    void store.awaitConvexId(sid)
      .then((convexId) => {
        store.sendMessage(convexId, fullMessage, undefined, clientId);
      })
      .catch((error) => {
        if (isParkedDispatchError(error)) return;
        store.markOptimisticAsFailed(sid, clientId);
        console.error("Failed to create context session", error);
      });
  }, [message, contextType, contextTitle, getContextBody, agentKey, linkedObjectId, projectPathProp, conversationId, openLinkedSession]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  const defaultPlaceholder = `Discuss or work on this ${contextType} with an agent...`;
  const hasText = message.trim().length > 0;

  return (
    <div className="shrink-0 pointer-events-none sticky bottom-0 z-10">
      <div className="h-16 bg-gradient-to-t from-sol-bg via-[color-mix(in_srgb,var(--sol-bg)_80%,transparent)] to-transparent -mt-16 relative" />
      <div className={`pb-4 pointer-events-auto bg-sol-bg`}>
      <div className={`mx-auto px-2 sm:px-4 transition-all duration-200 ease-out ${isExpanded ? "conv-col" : "max-w-sm"}`}>
      {isExpanded && (
        <div className={`mx-auto px-4 mb-1 flex justify-between items-center ${isExpanded ? "conv-col" : "max-w-md"}`}>
          <div className="flex items-center gap-1">
            {AGENT_TYPES.map((agent) => (
              <button
                key={agent.key}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setSelectedAgent(agent.key)}
                className={`px-2 py-0.5 text-[11px] font-medium rounded-md border transition-colors flex items-center gap-1 ${
                  agentKey === agent.key
                    ? agent.active
                    : "bg-transparent text-sol-text-dim border-transparent hover:text-sol-text-muted"
                }`}
              >
                <AgentTypeIcon agentType={agent.convex} className="w-3 h-3" />
                {agent.label}
              </button>
            ))}
          </div>
          <span className="text-[10px] text-sol-text-dim/50">
            {contextType}
          </span>
        </div>
      )}
      <div className={`flex flex-col border shadow-lg transition-all duration-200 ${isExpanded ? "px-4 py-2 rounded-2xl" : "px-3 py-1.5 rounded-full"} bg-sol-bg-alt ${isFocused ? "border-sol-border" : "border-sol-border/50"}`}>
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            data-chat-input
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              resetHeight();
            }}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => {
              if (!message.trim()) setIsFocused(false);
            }}
            placeholder={placeholder || defaultPlaceholder}
            rows={1}
            className={`flex-1 bg-transparent text-sol-text placeholder:text-sol-text-dim focus:outline-none resize-none overflow-hidden leading-relaxed ${isExpanded ? "text-sm py-1" : "text-xs py-0.5"}`}
          />
          <div className="shrink-0">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!hasText}
              className={`${isExpanded ? "w-8 h-8" : "w-6 h-6"} rounded-full transition-colors flex items-center justify-center border ${
                !hasText
                  ? "border-sol-border/30 text-sol-text-dim/25 cursor-not-allowed"
                  : "border-sol-blue/50 bg-sol-blue/20 text-sol-blue hover:bg-sol-blue/30 hover:border-sol-blue"
              }`}
            >
              <ArrowUp className={isExpanded ? "w-4 h-4" : "w-3 h-3"} />
            </button>
          </div>
        </div>
      </div>
    </div>
    </div>
    </div>
  );
}
