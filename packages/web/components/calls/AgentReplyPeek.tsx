import { useRef, useState } from "react";
import { SessionFace } from "../identity";
import { cleanNotificationBody } from "../../lib/notificationText";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import type { ThreadRow } from "./roomThreadModel";
import "./arrival.css";

/** How long a peek stays when nobody touches it, and after the pointer leaves. */
const SHOW_MS = 7000;
const LINGER_MS = 2500;
const LEAVE_MS = 160;

/** Each answer peeks once per window, however often the stage remounts. */
const peeked = new Set<string>();

/**
 * An agent answered in the call's chat while the thread was closed: who, and
 * how the answer begins, in a small card hung under the thread button. It
 * leaves on its own (held while hovered), never stacks (a newer answer takes
 * its place), and a click opens the thread. `row` is the newest unread line;
 * a person's line or none at all shows nothing.
 */
export function AgentReplyPeek({ row, onOpen }: { row: ThreadRow | null; onOpen: () => void }) {
  const [shown, setShown] = useState<ThreadRow | null>(null);
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const leaveIn = (ms: number) => {
    clear();
    timer.current = setTimeout(() => {
      setLeaving(true);
      timer.current = setTimeout(() => setShown(null), LEAVE_MS);
    }, ms);
  };

  const id = row?.agent ? String(row._id) : null;
  useWatchEffect(() => {
    // Read or superseded by a person's line: the peek has nothing left to say.
    if (!id || !row) {
      clear();
      setShown(null);
      return;
    }
    if (peeked.has(id)) return;
    peeked.add(id);
    setLeaving(false);
    setShown(row);
    leaveIn(SHOW_MS);
  }, [id]);
  useWatchEffect(() => clear, []);

  if (!shown?.agent) return null;
  const agent = shown.agent;
  const name = agent.name ?? agent.title;
  const text = cleanNotificationBody(shown.text, 160);
  return (
    <button
      type="button"
      className="agent-peek"
      data-leaving={leaving || undefined}
      onClick={() => {
        clear();
        setShown(null);
        onOpen();
      }}
      onPointerEnter={clear}
      onPointerLeave={() => leaveIn(LINGER_MS)}
      aria-label={`${name} replied in the chat: ${text}. Open the thread`}
    >
      <SessionFace
        row={{
          _id: agent.conversation_id,
          title: agent.title,
          character_avatar: agent.character_avatar ?? null,
          character_name: agent.character_name ?? null,
        }}
        size={18}
        className="mt-px shrink-0"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="agent-peek-name">{name} replied</span>
        {text && <span className="agent-peek-text">{text}</span>}
      </span>
    </button>
  );
}
