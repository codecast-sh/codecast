"use client";
import { useState, useRef, useCallback } from "react";
import { ArrowUp, Sparkles } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useOpenLinkedSession } from "../hooks/useOpenLinkedSession";
import { resolveContextRow, resolveContextProjectPath } from "../lib/contextProjectPath";
import { soundNewSession } from "../lib/sounds";
import { AgentTypeIcon } from "./AgentTypeIcon";
import { usePinnedPickerOptions } from "../hooks/usePinnedAgents";
import { agentAccent } from "../lib/agentColors";
import { newConversationAgentType } from "../lib/defaultAgent";
import { startHostedConversation } from "../lib/startHostedConversation";
import { fromConvexAgentType, isHostedAgentType, type AgentClientId } from "@codecast/shared/contracts";

type AgentKey = AgentClientId;
const escapeContext = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
// Preserve exact prose and command examples in the context body (notably doc
// edit strings) while preventing body content from closing the envelope.
const protectContextBody = (value: string) =>
  value.replace(/<\/context>/gi, "<\\/context>");

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
  // The conversation on screen's agent carries over; the default
  // (lib/defaultAgent) fills in, the hosted assistant in hosted mode.
  const currentAgent = useInboxStore((s) => newConversationAgentType(s, s.currentConversation.agentType));
  const [selectedAgent, setSelectedAgent] = useState<AgentKey | null>(null);
  // Same gesture as clicking a card in the object's "Sessions" list: the
  // conversation takes the stage (routed to /conversation → the inbox); a
  // side-by-side arrangement is a drag onto the stage, never a click.
  const openLinkedSession = useOpenLinkedSession();

  // Registry chokepoint, never a hand-rolled ternary: a client missing from a
  // ternary silently collapses to the fallback branch.
  const agentKey: AgentKey = selectedAgent || fromConvexAgentType(currentAgent);
  const agentOptions = usePinnedPickerOptions(agentKey);
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

    const convexAgentType = agentOptions.find((a) => a.id === agentKey)?.convexType ?? currentAgent;
    const hosted = isHostedAgentType(convexAgentType);
    const body = getContextBody();
    const idAttr = linkedObjectId ? ` id="${escapeContext(linkedObjectId)}"` : "";
    let contextBody = body || "";
    // Prepend editing instructions for docs so the model knows how to modify
    // them. The hosted assistant has no `cast` to run, so it reads the body only.
    if (contextType === "doc" && linkedObjectId && body && !hosted) {
      contextBody = `[Document ID: ${linkedObjectId}]\nTo edit this document use: cast doc edit ${linkedObjectId} --old "text to find" --new "replacement text"\nTo update title: cast doc edit ${linkedObjectId} --title "New Title"\nTo offer the writer choices instead of replacing their words: cast doc alt (versions they flip between), cast doc ghost (dim text that could go), cast doc overflow --stash (move text aside), cast doc lab (trims and marks). cast doc drafts ${linkedObjectId} lists what is already there.\nDo not use file Read/Write/Edit tools — this document lives in the database, not the filesystem.\n\n${body}`;
    }
    const contextBlock = contextBody
      ? `<context type="${escapeContext(contextType)}" title="${escapeContext(contextTitle)}"${idAttr}>\n${protectContextBody(contextBody)}\n</context>\n\n`
      : `[Viewing ${contextType}: ${contextTitle}]\n\n`;
    const fullMessage = contextBlock + text;

    // Every branch ends the same way: empty the composer and open the
    // conversation the message went to.
    const finish = (sid: string) => {
      setMessage("");
      setSelectedAgent(null);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        // A grown textarea keeps its scroll offset after the reset; in a narrow
        // column that shows the placeholder's wrapped tail instead of its start.
        textareaRef.current.scrollTop = 0;
      }
      openLinkedSession({ _id: sid });
    };

    const store = useInboxStore.getState();
    if (conversationId) {
      const clientId = store.addOptimisticMessage(conversationId, fullMessage);
      store.sendMessage(conversationId, fullMessage, undefined, clientId);
      finish(conversationId);
      return;
    }
    const { projectPath, gitRoot } = store.currentConversation;

    soundNewSession();

    // The hosted assistant starts with its first message on the create and
    // no folder or machine; the context block rides that first message.
    if (hosted) {
      finish(startHostedConversation(fullMessage));
      return;
    }

    // The linked object's OWN project wins over the viewer's
    // currentConversation, which may belong to an unrelated repo (~/src etc) —
    // resolution chain in lib/contextProjectPath. When the object pins nothing
    // the viewer's path still rides along as a last resort, and the server
    // (resolveTaskGitContext) overrides it with the task's team directory
    // unless it already sits inside that team. activeTask is a side product
    // for optimistic rendering (task badge in header/sidebar).
    let activeTask: { _id: string; short_id: string; title: string; status: string } | undefined;
    let contextDerivedPath: string | undefined;
    if (linkedObjectId) {
      const row = resolveContextRow(store, contextType, linkedObjectId);
      contextDerivedPath = resolveContextProjectPath(store, row);
      if (contextType === "task" && row) {
        activeTask = { _id: row._id, short_id: row.short_id, title: row.title, status: row.status };
      }
    }
    const contextPath = projectPathProp || contextDerivedPath;
    const path = contextPath || projectPath || gitRoot;
    // The viewer's gitRoot describes currentConversation's repo and only
    // applies when the path came from there too. Sent alongside a context-derived
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

    // The stub row already exists (beginOptimisticSession wrote it), so this
    // paints the new session with its optimistic message before any server
    // round-trip; the /conversation/<stub> route resolves through
    // navigateToSession + the inbox's ?s= param, both of which follow the
    // stub→convex rekey.
    finish(sid);

    store.sendMessageWhenReady(sid, fullMessage, undefined, clientId);
  }, [message, contextType, contextTitle, getContextBody, agentKey, agentOptions, currentAgent, linkedObjectId, projectPathProp, conversationId, openLinkedSession]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  const defaultPlaceholder = `Work on this ${contextType} with an agent...`;
  const hasText = message.trim().length > 0;

  // At rest the composer is a small pill out of the reading line; a click
  // opens the full input (agent picker, textarea) and focuses it, and it
  // folds back when it loses focus empty.
  if (!isExpanded) {
    return (
      <div data-context-composer className="shrink-0 pointer-events-none sticky bottom-0 z-10 flex justify-end px-4 pb-3">
        <button
          type="button"
          onClick={() => setIsFocused(true)}
          title={placeholder || defaultPlaceholder}
          className="pointer-events-auto inline-flex items-center gap-1.5 h-7 px-3 rounded-full border border-sol-border/60 bg-sol-bg-alt text-[11px] text-sol-text-muted shadow-md transition-colors hover:text-sol-text hover:border-sol-border"
        >
          <Sparkles className="w-3 h-3 text-sol-cyan" />
          Ask an agent
        </button>
      </div>
    );
  }

  return (
    <div data-context-composer className="shrink-0 pointer-events-none sticky bottom-0 z-10">
      <div className="h-16 bg-gradient-to-t from-sol-bg via-[color-mix(in_srgb,var(--sol-bg)_80%,transparent)] to-transparent -mt-16 relative" />
      <div className="pb-4 pointer-events-auto bg-sol-bg">
      <div className="mx-auto px-2 sm:px-4 conv-col">
        <div className="mx-auto px-4 mb-1 flex justify-between items-center conv-col">
          <div className="flex items-center gap-1">
            {agentOptions.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setSelectedAgent(agent.id)}
                className={`px-2 py-0.5 text-[11px] font-medium rounded-md border transition-colors flex items-center gap-1 ${
                  agentKey === agent.id
                    ? agentAccent(agent.convexType).chip
                    : "bg-transparent text-sol-text-dim border-transparent hover:text-sol-text-muted"
                }`}
              >
                <AgentTypeIcon agentType={agent.convexType} className="w-3 h-3" />
                {agent.label}
              </button>
            ))}
          </div>
          <span className="text-[10px] text-sol-text-dim/50">
            {contextType}
          </span>
        </div>
      <div className={`flex flex-col border shadow-lg px-4 py-2 rounded-2xl bg-sol-bg-alt ${isFocused ? "border-sol-border" : "border-sol-border/50"}`}>
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            data-chat-input
            autoFocus
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
            className="flex-1 bg-transparent text-sol-text placeholder:text-sol-text-dim focus:outline-none resize-none overflow-hidden leading-relaxed text-sm py-1"
          />
          <div className="shrink-0">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!hasText}
              className={`w-8 h-8 rounded-full transition-colors flex items-center justify-center border ${
                !hasText
                  ? "border-sol-border/30 text-sol-text-dim/25 cursor-not-allowed"
                  : "border-sol-blue/50 bg-sol-blue/20 text-sol-blue hover:bg-sol-blue/30 hover:border-sol-blue"
              }`}
            >
              <ArrowUp className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
    </div>
    </div>
  );
}
