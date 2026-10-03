"use client";

// The task face's view of its owning session: what it is doing now (its
// pinned state), the last few turns, and the session's own composer, so the
// work can be read and steered without leaving the task. The full transcript
// is the session face, one click away in the WorkUnitBar above.

import { useMemo } from "react";
import { Pin } from "lucide-react";
import { MessageInput } from "../MessageInput";
import { cleanUserMessage } from "../sessionMessage";
import { identityLine, identityRowOf } from "../../lib/sessionIdentity";
import { sessionLiveAt } from "../../lib/liveness";
import { compactAge, threadStateView, THREAD_STATE_PIN_CLASS, THREAD_STATE_STATUS_META } from "../../lib/threadState";
import { cleanTitle } from "../../lib/conversationProcessor";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useInboxStore } from "../../store/inboxStore";
import { usePersonifyAll } from "../../hooks/usePersonifyAll";
import type { WorkUnitSession } from "./WorkUnitBar";

type Turn = { _id?: string; role: string; content: string; timestamp?: number };

const TAIL = 3;

function turnText(t: Turn): string {
  const raw = t.role === "user" ? cleanUserMessage(t.content) || t.content : t.content;
  return String(raw || "").replace(/\s+/g, " ").trim();
}

/** The last few spoken turns: the store's loaded transcript when the session
 *  is open somewhere, else the detail snapshot's tail. Tool chatter and empty
 *  turns are skipped; the transcript is the place for those. */
function tailOf(stored: Turn[] | undefined, snapshot: Turn[] | undefined): Turn[] {
  const source = stored && stored.length ? stored : snapshot ?? [];
  const out: Turn[] = [];
  for (let i = source.length - 1; i >= 0 && out.length < TAIL; i--) {
    const t = source[i];
    if ((t.role === "user" || t.role === "assistant") && typeof t.content === "string" && turnText(t)) out.push(t);
  }
  return out.reverse();
}

function tailSig(msgs: Turn[] | undefined): string {
  const last = msgs?.at(-1);
  return last ? `${msgs!.length}:${last._id ?? ""}:${(last.content ?? "").length}` : "";
}

export function TaskWorkPanel({ session }: { session: WorkUnitSession & { recent_messages?: Turn[] } }) {
  const now = useCoarseNow(30_000);
  const personifyAll = usePersonifyAll();
  const sig = useInboxStore((s) => {
    const r: any = s.sessions[session._id];
    return [r?.thread_state, r?.thread_state_status, r?.thread_state_at, r?.is_idle, r?.updated_at, r?.message_count, tailSig(s.messages[session._id] as any)].join("\u0001");
  });
  const { row, turns } = useMemo(() => {
    const st = useInboxStore.getState();
    const merged: any = { ...session, ...(st.sessions[session._id] ?? {}) };
    return { row: merged, turns: tailOf(st.messages[session._id] as any, session.recent_messages) };
    // sig stands in for the churny store refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sig]);

  const name = identityLine(identityRowOf(row), cleanTitle(String(row.title || "")), personifyAll).name ?? "the session";
  // The agent's turns are labelled by its name when it has one.
  const speaker = name === "the session" ? "agent" : name.split(" ")[0];
  const stateView = threadStateView(row, row.message_count ?? 0, now);
  const live = sessionLiveAt(row, now);

  return (
    <section data-task-work className="mb-6 rounded-lg border border-sol-cyan/25 bg-sol-cyan/[0.03] overflow-hidden">
      <div className="px-3 pt-2.5 pb-1 flex items-center gap-2 text-[11px] text-sol-text-dim">
        <span className="font-medium text-sol-text-secondary">{live ? `${name} is on it` : `${name} owns this`}</span>
        {!live && row.updated_at && <span className="tabular-nums">last active {compactAge(now - row.updated_at)} ago</span>}
      </div>
      {stateView?.text && (
        <div className="px-3 pb-1.5 flex items-start gap-1.5 min-w-0" title={stateView.text}>
          <Pin
            className={`w-2.5 h-2.5 mt-[3px] shrink-0 ${stateView.status ? THREAD_STATE_STATUS_META[stateView.status].dot : THREAD_STATE_PIN_CLASS[stateView.freshness]}`}
            strokeWidth={2.4}
          />
          {stateView.status && stateView.status !== "working" && (
            <span className={`shrink-0 mt-px px-1 rounded border text-[9px] font-semibold uppercase tracking-wide ${THREAD_STATE_STATUS_META[stateView.status].chip}`}>
              {THREAD_STATE_STATUS_META[stateView.status].label}
            </span>
          )}
          <span className="text-xs text-sol-text-secondary leading-snug line-clamp-2">{stateView.text}</span>
        </div>
      )}
      {turns.length > 0 && (
        <ol className="px-3 pb-2 space-y-1.5">
          {turns.map((t, i) => (
            <li key={t._id ?? i} className="flex gap-2 min-w-0">
              <span className={`w-10 flex-shrink-0 text-[10px] pt-px ${t.role === "user" ? "text-sol-blue/80" : "text-sol-text-dim"}`}>
                {t.role === "user" ? "you" : speaker}
              </span>
              <p className={`min-w-0 text-xs leading-snug line-clamp-3 ${t.role === "user" ? "text-sol-text-muted" : "text-sol-text-secondary"}`}>{turnText(t)}</p>
            </li>
          ))}
        </ol>
      )}
      <div className="border-t border-sol-cyan/15 px-1 pt-1">
        <MessageInput
          conversationId={session._id}
          status="active"
          embedded
          inline
          isConversationLive={live}
          composerPlaceholder={`Message ${name}…`}
        />
      </div>
    </section>
  );
}
