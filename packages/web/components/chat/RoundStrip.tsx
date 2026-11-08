"use client";

import Link from "next/link";
import { Check, CircleSlash, Clock, Minus, Pause, SkipForward } from "lucide-react";
import { roundStrip, type ChatRound, type RoundMember, type RoundMemberState } from "@codecast/shared/chat";
import { useInboxStore } from "../../store/inboxStore";
import { objectHref } from "../../lib/entityLinks";
import "./chat.css";

// The room's agents taking turns on a thread (docs/architecture/agent-channels.md
// C6): one chip per member in turn order, its state carried by the chip, and the
// two controls a person needs while it runs: move past the member holding the
// floor, or stop the round.

const STATE: Record<RoundMemberState, { word: string; tone: string }> = {
  floor: { word: "answering", tone: "ch-round-floor" },
  waiting: { word: "next", tone: "ch-round-waiting" },
  spoke: { word: "answered", tone: "ch-round-spoke" },
  passed: { word: "passed", tone: "ch-round-quiet" },
  busy: { word: "busy, later", tone: "ch-round-busy" },
  no_answer: { word: "no answer", tone: "ch-round-quiet" },
  skipped: { word: "skipped", tone: "ch-round-quiet" },
  unreachable: { word: "not running", tone: "ch-round-off" },
  out: { word: "not asked", tone: "ch-round-quiet" },
};

function StateMark({ state }: { state: RoundMemberState }) {
  const cls = "w-3 h-3 shrink-0";
  switch (state) {
    case "floor": return <span className="ch-round-dot" aria-hidden="true" />;
    case "spoke": return <Check className={cls} aria-hidden="true" />;
    case "busy": return <Pause className={cls} aria-hidden="true" />;
    case "no_answer": return <Clock className={cls} aria-hidden="true" />;
    case "skipped": return <SkipForward className={cls} aria-hidden="true" />;
    case "unreachable": return <CircleSlash className={cls} aria-hidden="true" />;
    case "passed": return <Minus className={cls} aria-hidden="true" />;
    default: return <span className="ch-round-ring" aria-hidden="true" />;
  }
}

const memberHref = (m: RoundMember) => (m.kind === "role" ? objectHref("role", m.short_id) : `/conversation/${m.key}`);

/** `openOnly` hides a finished round (the channel view); the thread shows its record. */
export function RoundStrip({ rootId, round, openOnly = false }: { rootId: string; round: ChatRound | undefined; openOnly?: boolean }) {
  const skip = useInboxStore((st) => st.skipChatRoundFloor);
  const end = useInboxStore((st) => st.endChatRound);
  if (!round || (openOnly && round.status !== "open")) return null;
  const open = round.status === "open";
  const members = roundStrip(round);
  if (members.length === 0) return null;

  return (
    <div className={`ch-round ${open ? "" : "ch-round-closed"}`} role="group" aria-label="Agents taking turns">
      {members.map((m) => {
        const st = STATE[m.state];
        return (
          <Link key={m.key} href={memberHref(m)} className={`ch-round-chip ${st.tone}`} title={`${m.name}: ${st.word}`}>
            <StateMark state={m.state} />
            <span className="ch-round-name">{m.name}</span>
          </Link>
        );
      })}
      {open && (
        <span className="ch-round-actions">
          {round.floor_key && (
            <button type="button" className="ch-round-btn" onClick={() => skip(rootId)}>Skip</button>
          )}
          <button type="button" className="ch-round-btn" onClick={() => end(rootId)}>End</button>
        </span>
      )}
    </div>
  );
}
