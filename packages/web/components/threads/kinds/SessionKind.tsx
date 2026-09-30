import { useCallback, useMemo } from "react";
import { PanelRight, Wrench } from "lucide-react";
import { useInboxStore, type InboxSession } from "../../../store/inboxStore";
import { summaryCount, type ThreadCardModel } from "../../../lib/threadCards";
import { threadStateView } from "../../../lib/threadState";
import { sessionLabel } from "../../../lib/notificationTypes";
import { classifyFeedMessage } from "../../../lib/conversationProcessor";
import { useConversationMessages, type Message } from "../../../hooks/useConversationMessages";
import { parseAgentAuthoredMessage } from "../../sessionMessage";
import { openConversationBeside } from "../../../hooks/useOpenLinkedSession";
import { AgentIcon } from "../../ConversationList";
import { MessageInput } from "../../MessageInput";
import { composerAgentStatus, useManagedSessionFields, useSessionEscape } from "../../../hooks/useSessionComposerControls";
import { usePermissionModeSwitch } from "../../../hooks/usePermissionModeSwitch";
import { animatedHideSession } from "../../../store/undoActions";
import { MarkdownRenderer } from "../../tools/MarkdownRenderer";
import { EntityIdPill } from "../../EntityIdPill";
import { EarlierButton } from "../readerFold";
import { useReaderFold } from "../../../hooks/useReaderFold";
import { Clamp } from "../../tasks/TaskCommentStream";
import { useThreadsPage } from "../threadsContext";
import "../../chat/chat.css";

import { useWatchEffect } from "../../../hooks/useWatchEffect";
// The session kind: the viewer's own inbox sessions, shown as rows only when
// the Sessions toggle is on (off by default — their queue already lives in
// the Inbox). Membership is the Inbox's own: placeInboxRows over
// filterInboxScope, derived in hooks/useSessionThreadCards. Open, a row is
// the DM kind's shape: the newest messages of the session inline and the
// app's own composer sending into it; the side panel is a secondary button.

/** How many of the session's newest visible messages a row holds; the fold shows the last few. */
const SESSION_WINDOW = 20;

function sessionOf(card: ThreadCardModel): InboxSession {
  return card.source as InboxSession;
}

/** The label leads with the session's agent mark, the way an Inbox row does;
 *  the kind tile keeps the kind's own icon. */
export function SessionLabel({ card }: { card: ThreadCardModel }) {
  const session = sessionOf(card);
  return (
    <>
      <AgentIcon agentType={session.agent_type || "claude_code"} className="w-3 h-3" />
      {sessionLabel(session) ?? "Session"}
    </>
  );
}

// One message as the card shows it. The user side goes through the same
// classifier the activity feed uses, so wrappers (<task-notification>,
// command expansions, continuations) never reach the card; a message another
// session sent keeps its sender. The assistant side is its text, with a tool
// count where it only called tools.
type SessionRow =
  | { key: string; role: "user"; text: string; from?: string; mine: boolean }
  | { key: string; role: "assistant"; text: string; tools: number };

function toRows(messages: Message[]): SessionRow[] {
  const rows: SessionRow[] = [];
  for (const m of messages) {
    const key = m._id;
    if (m.role === "user") {
      // A `cast send` from another session and a subagent's report both name
      // their sender on the wire; either way the row is not the human's words.
      const envelope = parseAgentAuthoredMessage(m.content);
      if (envelope) {
        const text = envelope.body || (m.content ?? "").trim();
        if (text) rows.push({ key, role: "user", text, from: envelope.from || undefined, mine: false });
        continue;
      }
      const d = classifyFeedMessage(m.content);
      if (d.kind === "hidden") continue;
      rows.push({ key, role: "user", text: d.text, mine: true });
    } else if (m.role === "assistant") {
      const text = (m.content ?? "").trim();
      const tools = m.tool_calls?.length ?? 0;
      if (!text && !tools) continue;
      // A run of tool-only turns folds into one row: "12 tool calls" reads
      // as work done, twelve bare rows would push the text out of the window.
      const prev = rows[rows.length - 1];
      if (!text && prev && prev.role === "assistant" && !prev.text) {
        prev.tools += tools;
        continue;
      }
      rows.push({ key, role: "assistant", text, tools });
    }
  }
  return rows;
}

function SessionRows({ rows, agentType }: { rows: SessionRow[]; agentType?: string }) {
  // The newest few messages, the rest behind one button above: a session has
  // no read boundary here, so the fold keeps the tail the card is about.
  const fold = useReaderFold(rows, () => 0, 0);
  return (
    <div className="th-card-replies th-session-rows">
      <EarlierButton count={fold.hidden} noun="message" onClick={fold.showAll} />
      {fold.visible.map((row) => (
        <div key={row.key} className={`th-session-row th-session-row-${row.role}`}>
          <div className="th-session-row-head">
            {row.role === "assistant" ? (
              <>
                <AgentIcon agentType={agentType || "claude_code"} className="w-3 h-3" />
                <span>agent</span>
              </>
            ) : row.from ? (
              <>
                <span>from</span>
                <EntityIdPill shortId={row.from} />
              </>
            ) : (
              <span>you</span>
            )}
          </div>
          {row.text ? (
            <Clamp className="th-session-row-body">
              <MarkdownRenderer content={row.text} className="text-[12.5px] !prose-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />
            </Clamp>
          ) : null}
          {row.role === "assistant" && row.tools > 0 && (
            <div className="th-session-row-tools">
              <Wrench className="w-3 h-3" /> {summaryCount(row.tools, "tool call")}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function SessionExpanded({ card, seen, focusComposer }: { card: ThreadCardModel; present: boolean; seen: boolean; frozenReadAt: number; focusComposer: boolean }) {
  const session = sessionOf(card);
  const sessionId = session._id;
  const { now, viewerId } = useThreadsPage();
  // The conversation view's own feeder: store-first, live tail query, the
  // same rows the side panel and the main view paint.
  const { conversation } = useConversationMessages(sessionId);
  const all: Message[] = conversation?.messages ?? [];
  const rows = useMemo(() => {
    const r = toRows(all);
    return r.length > SESSION_WINDOW ? r.slice(-SESSION_WINDOW) : r;
  }, [all]);
  const newestId = all.length ? all[all.length - 1]._id : undefined;

  // The DM law: the row is open and the reader is here (`seen`). Re-marks as
  // messages land (newestId moves) and when the meta row's count catches up
  // — the stamp reads message_count, which can bump after the message itself.
  useWatchEffect(() => {
    if (!seen || !newestId) return;
    useInboxStore.getState().markSessionSeen(sessionId);
  }, [seen, sessionId, newestId, session.message_count]);

  // The conversation view's own composer controls (hooks/useSessionComposerControls,
  // usePermissionModeSwitch): status line, interrupt, permission mode, send
  // and stash, handoff, attachments.
  const managed = useManagedSessionFields(sessionId);
  const active = (conversation?.status ?? session.status) === "active";
  const isOwner = String(session.user_id) === String(viewerId);
  const mode = managed?.permission_mode || "default";
  const convCommand = useInboxStore((s) => s.convCommand);
  const { handleCycleMode, modeSwitching } = usePermissionModeSwitch({ effectiveMode: mode, conversation: conversation as any, effectiveIsOwner: isOwner, convexConvId: sessionId as any, convCommand });
  const sendEscape = useSessionEscape(sessionId, { active, isOwner });
  const onEscape = useCallback(() => { sendEscape(); }, [sendEscape]);
  const stash = useMemo(() => (isOwner ? () => animatedHideSession(sessionId, "stash") : undefined), [isOwner, sessionId]);

  const state = threadStateView(session as any, session.message_count ?? 0, now);
  return (
    <div className="th-card-open th-card-open-session">
      {rows.length === 0 ? (
        <div className="th-card-note">{conversation ? "Nothing to show yet." : "Loading…"}</div>
      ) : (
        <SessionRows rows={rows} agentType={session.agent_type} />
      )}
      <div className="th-session-composer">
        <MessageInput
          key={sessionId}
          conversationId={sessionId}
          sessionId={session.session_id}
          agentType={session.agent_type}
          status={conversation?.status ?? "active"}
          inline
          embedded
          initialDraft={(conversation as any)?.draft_message}
          agentStatus={composerAgentStatus(managed?.agent_status, { active, disconnected: managed?.is_connected === false })}
          deliveryStatus={managed?.agent_status}
          permissionMode={mode}
          permissionModePending={modeSwitching}
          onCycleMode={isOwner ? handleCycleMode : undefined}
          onSendEscape={onEscape}
          onSendAndDismiss={stash}
          composerPlaceholder="Reply to this session"
          autoFocusInput={focusComposer}
        />
      </div>
      <div className="th-session-foot">
        {state?.cardLine && <span className="th-session-state">{state.cardLine}</span>}
        <button
          type="button"
          className="th-session-openpanel"
          onClick={() => openConversationBeside(sessionId)}
        >
          <PanelRight className="w-3 h-3" /> Open beside
        </button>
      </div>
    </div>
  );
}
