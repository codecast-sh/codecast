import { SESSION_STATUS, SESSION_STATUSES } from "../sessionStatus";
import type { MarkDef } from "./types";

// A session's state (components/inbox/SessionStatusMark), straight from the
// status vocabulary so the legend and the cards can never word it differently.
export const sessionMarks: MarkDef[] = SESSION_STATUSES.map((status) => ({
  id: `session.${status}`,
  name: SESSION_STATUS[status].word,
  meaning: SESSION_STATUS[status].meaning,
  group: "Sessions",
}));
