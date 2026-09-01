import { useEffect, useMemo } from "react";
import { PanelRight, Wrench } from "lucide-react";
import { useInboxStore, type InboxSession } from "../../../store/inboxStore";
import { summaryCount, type ThreadCardModel } from "../../../lib/threadCards";
import { threadStateView } from "../../../lib/threadState";
import { sessionLabel } from "../../../lib/notificationTypes";
import { classifyFeedMessage } from "../../../lib/conversationProcessor";
import { useConversationMessages, type Message } from "../../../hooks/useConversationMessages";
import { parseInboundSessionMessage, isSessionMessage } from "../../sessionMessage";
import { openConversationBeside } from "../../../hooks/useOpenLinkedSession";
import { AgentIcon } from "../../ConversationList";
import { MessageInput } from "../../ConversationView";
import { MarkdownRenderer } from "../../tools/MarkdownRenderer";
import { EntityIdPill } from "../../EntityIdPill";
import { useTailPin } from "../cardWindow";
import { useThreadsPage } from "../threadsContext";
import "../../chat/chat.css";

// The session kind: the viewer's own inbox sessions, shown as cards only when
// the Sessions toggle is on (off by default — their queue already lives in
// the Inbox). Membership is the Inbox's own: placeInboxRows over
// filterInboxScope, derived in hooks/useSessionThreadCards. Expanded, a card
// is the DM kind's shape: the newest messages of the session inline and the
// app's own composer sending into it; the side panel is a secondary button.

/** How many of the session's newest visible messages an expanded card shows. */
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

export function SessionRoot({ card, expanded }: { card: ThreadCardModel; expanded: boolean }) {
  const session = sessionOf(card);
  const { now, toggle } = useThreadsPage();
  const state = threadStateView(session as any, session.message_count ?? 0, now);
  const line = state?.cardLine ?? session.subtitle ?? "";
  const count = session.message_count ?? 0;
  return (
    <>
      {line && <div className="th-card-root th-card-session-line">{line}</div>}
      {!expanded && (
        <button type="button" className="th-card-summary" onClick={() => toggle(card)}>
          <span className="th-card-count">{summaryCount(count, "message")}</span>
          {session.idle_summary && <span className="th-card-preview">{session.idle_summary}</span>}
        </button>
      )}
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
      if (isSessionMessage(m.content)) {
        const parsed = parseInboundSessionMessage(m.content);
        const text = parsed?.body || (m.content ?? "").trim();
        if (text) rows.push({ key, role: "user", text, from: parsed?.from || undefined, mine: false });
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
  // The rows live in the card's capped scroll region (.th-card-replies),
  // pinned to the tail (cardWindow.useTailPin — every kind's scroller pins
  // the same way): the newest message is the one the card is about, and the
  // read law below assumes it is the one on screen.
  const newestKey = rows.length ? rows[rows.length - 1].key : "";
  const ref = useTailPin(`${newestKey}|${rows.length}`);
  return (
    <div ref={ref} className="th-card-replies th-session-rows">
      {rows.map((row) => (
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
            <div className="th-session-row-body">
              <MarkdownRenderer content={row.text} className="text-[12.5px] !prose-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />
            </div>
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
  const { now } = useThreadsPage();
  // The conversation view's own feeder: store-first, live tail query, the
  // same rows the side panel and the main view paint.
  const { conversation } = useConversationMessages(sessionId);
  const all: Message[] = conversation?.messages ?? [];
  const rows = useMemo(() => {
    const r = toRows(all);
    return r.length > SESSION_WINDOW ? r.slice(-SESSION_WINDOW) : r;
  }, [all]);
  const newestId = all.length ? all[all.length - 1]._id : undefined;

  // The DM law: present + the newest message actually on screen (`seen`, the
  // shell's tail sentinel). Re-marks as messages land (newestId moves) and
  // when the meta row's count catches up — the stamp reads message_count,
  // which can bump after the message itself.
  useEffect(() => {
    if (!seen || !newestId) return;
    useInboxStore.getState().markSessionSeen(sessionId);
  }, [seen, sessionId, newestId, session.message_count]);

  const state = threadStateView(session as any, session.message_count ?? 0, now);
  return (
    <div className="th-card-open th-card-open-session">
      {rows.length === 0 ? (
        <div className="th-card-note">{conversation ? "Nothing to show yet." : "Loading…"}</div>
      ) : (
        <SessionRows rows={rows} agentType={session.agent_type} />
      )}
      <div className="ch-composer th-session-composer">
        <MessageInput
          key={sessionId}
          conversationId={sessionId}
          sessionId={session.session_id}
          agentType={session.agent_type}
          status={conversation?.status ?? "active"}
          bareComposer
          embedded
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
