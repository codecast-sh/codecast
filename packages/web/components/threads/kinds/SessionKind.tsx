import { useCallback, useMemo } from "react";
import { PanelRight, Wrench } from "lucide-react";
import { useInboxStore, type InboxSession } from "../../../store/inboxStore";
import { summaryCount, type ThreadCardModel } from "../../../lib/threadCards";
import { threadStateView } from "../../../lib/threadState";
import { sessionLabel } from "../../../lib/notificationTypes";
import { useConversationMessages, type Message } from "../../../hooks/useConversationMessages";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { classifyUserMessage, stripSystemTags } from "../../conversation/classify";
import type { Message as ConvMessage, UserMessageKind } from "../../conversation/types";
import { AssistantBlock, UserPrompt } from "../../conversation/blocks/turnBlocks";
import { SessionMessageBlock } from "../../conversation/blocks/systemBlocks";
import { openConversationBeside } from "../../../hooks/useOpenLinkedSession";
import { SessionIdentityLine, SessionMark } from "../../identity";
import { MessageInput } from "../../MessageInput";
import { composerAgentStatus, useManagedSessionFields, useSessionEscape } from "../../../hooks/useSessionComposerControls";
import { usePermissionModeSwitch } from "../../../hooks/usePermissionModeSwitch";
import { animatedHideSession } from "../../../store/undoActions";
import { EarlierButton } from "../readerFold";
import { useReaderFold } from "../../../hooks/useReaderFold";
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
/** An agent message taller than this opens folded under the conversation's own Expand control. */
const SESSION_COLLAPSE_PX = 320;

function sessionOf(card: ThreadCardModel): InboxSession {
  return card.source as InboxSession;
}

/** The label leads with the session's agent mark, the way an Inbox row does;
 *  the kind tile keeps the kind's own icon. */
export function SessionLabel({ card }: { card: ThreadCardModel }) {
  const session = sessionOf(card);
  return (
    <>
      <SessionMark session={session as any} size={14} iconClassName="w-3 h-3" />
      <SessionIdentityLine row={session as any} title={sessionLabel(session) ?? "Session"} />
    </>
  );
}

// One message as the card shows it, through the conversation view's own
// classifier and blocks (components/conversation): a person's words are the
// same blue UserPrompt bubble, another session's send the same
// SessionMessageBlock, the agent's text the same AssistantBlock with its
// collapse and fullscreen controls. Rows the conversation draws as chrome
// (commands, dividers, notifications) stay out of the card; a run of
// tool-only turns folds into one count.
type SessionRow =
  | { key: string; role: "user"; msg: ConvMessage; kind: UserMessageKind }
  | { key: string; role: "assistant"; msg?: ConvMessage; tools: number; first: boolean };

function toRows(messages: Message[], agentType?: string): SessionRow[] {
  const rows: SessionRow[] = [];
  let prev: ConvMessage | null = null;
  for (const raw of messages) {
    const m = raw as ConvMessage;
    const immediatePrev = prev;
    prev = m;
    const key = m._id;
    if (m.role === "user") {
      const kind = classifyUserMessage(m, agentType, immediatePrev);
      if (kind.kind === "normal" || kind.kind === "direct_user" || kind.kind === "decision_answer" || kind.kind === "session_message") {
        rows.push({ key, role: "user", msg: m, kind });
      }
    } else if (m.role === "assistant") {
      const hasText = !!stripSystemTags(m.content ?? "").trim();
      const tools = m.tool_calls?.length ?? 0;
      if (!hasText && !tools) continue;
      const last = rows[rows.length - 1];
      // "12 tool calls" reads as work done; twelve bare rows would push the
      // text out of the window.
      if (!hasText && last && last.role === "assistant" && !last.msg) {
        last.tools += tools;
        continue;
      }
      rows.push({ key, role: "assistant", msg: hasText ? m : undefined, tools, first: !last || last.role !== "assistant" });
    }
  }
  return rows;
}

function SessionUserRow({ row, conversationId }: { row: Extract<SessionRow, { role: "user" }>; conversationId: string }) {
  const { msg, kind } = row;
  if (kind.kind === "session_message") {
    return <SessionMessageBlock variant={kind.variant === "agent" ? "agent" : "session"} from={kind.from} name={kind.name} body={kind.body} timestamp={msg.timestamp} />;
  }
  const decision = kind.kind === "decision_answer" ? kind.decision : undefined;
  return (
    <UserPrompt
      content={kind.kind === "direct_user" ? kind.body : decision ? decision.answer : (msg.content || "")}
      decision={decision}
      images={msg.images}
      timestamp={msg.timestamp}
      messageId={msg._id}
      messageUuid={msg.message_uuid}
      conversationId={conversationId as Id<"conversations">}
      collapsed={false}
      userName={kind.kind === "direct_user" ? kind.from : undefined}
      isPending={!!msg._isOptimistic}
      isQueued={!!msg._isQueued}
    />
  );
}

function SessionRows({ rows, agentType, conversationId }: { rows: SessionRow[]; agentType?: string; conversationId: string }) {
  // The newest few messages, the rest behind one button above: a session has
  // no read boundary here, so the fold keeps the tail the card is about.
  const fold = useReaderFold(rows, () => 0, 0);
  return (
    <div className="th-card-replies th-session-rows">
      <EarlierButton fold={fold} noun="message" />
      {fold.visible.map((row, i) =>
        row.role === "user" ? (
          <SessionUserRow key={row.key} row={row} conversationId={conversationId} />
        ) : (
          <div key={row.key} className="th-session-assistant">
            {row.msg ? (
              <AssistantBlock
                content={row.msg.content}
                timestamp={row.msg.timestamp}
                images={row.msg.images}
                messageId={row.msg._id}
                messageUuid={row.msg.message_uuid}
                conversationId={conversationId as Id<"conversations">}
                density="condensed"
                showHeader={row.first || i === 0}
                agentType={agentType}
                model={row.msg.model}
                collapseAbove={SESSION_COLLAPSE_PX}
              />
            ) : null}
            {row.tools > 0 && (
              <div className="th-session-row-tools">
                <Wrench className="w-3 h-3" /> {summaryCount(row.tools, "tool call")}
              </div>
            )}
          </div>
        ),
      )}
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
    const r = toRows(all, session.agent_type);
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
        <SessionRows rows={rows} agentType={session.agent_type} conversationId={sessionId} />
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
