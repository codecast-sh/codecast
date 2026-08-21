// `cast task start` claims a task. Who the claim belongs to depends on who ran
// it. A person at a terminal is the assignee. An agent inside a session runs
// under the owner's token, so "me" would resolve to the owner: the task would
// land on the human board, enroll the owner in the thread, and notify the
// owner that they assigned themselves. The agent's claim is the session
// binding (conversation_id) alone, never an assignee.
//
// The session detector is the same one that stamps source:"agent" on create,
// so the two decisions can never disagree.

export function buildTaskStartBody(shortId: string, sessionId: string | null): Record<string, any> {
  const body: Record<string, any> = { short_id: shortId, status: "in_progress" };
  if (sessionId) body.conversation_id = sessionId;
  else body.assignee = "me";
  return body;
}
