// The lifecycle of an agent's (the anchor's) reply row in chat, shared by the
// server, web and mobile so the three cannot disagree about which rows a
// person should see.
//
//   thinking / streaming  a visible placeholder: someone addressed the anchor
//                         and an answer is being written.
//   done                  the answer landed.
//   error                 the turn failed, timed out or was stopped; the row
//                         carries the reason.
//   listening             a SILENT placeholder. Someone replied in a thread the
//                         anchor is part of without addressing it; the anchor
//                         reads the thread and decides whether to speak. Nobody
//                         sees this row.
//   passed                the anchor read the thread and chose to stay quiet.
//                         The row is kept (it is the idempotency record for the
//                         wake) but never rendered.
export type ChatAgentStatus =
  | "thinking"
  | "streaming"
  | "done"
  | "error"
  | "listening"
  | "passed";

/** A row that must not render anywhere and must not count as a reply. */
export function isSilentAgentRow(row: {
  author_kind?: string;
  agent_status?: string;
}): boolean {
  return row.author_kind === "agent"
    && (row.agent_status === "listening" || row.agent_status === "passed");
}

/** A turn the anchor is still working on, visible or not. */
export function isAgentTurnInFlight(status: string | undefined): boolean {
  return status === "thinking" || status === "streaming" || status === "listening";
}

/** A placeholder that shows a spinner to people in the thread. */
export function isVisibleAgentPending(status: string | undefined): boolean {
  return status === "thinking" || status === "streaming";
}
