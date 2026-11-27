// The name a run's message to a session goes out under when the run has no session of its own to send from: the
// runner's own sends (runner.ts sendToSubject) and the server's word that a later deploy took it live
// (convex deployCarries.ts) read the same.
export const runSenderName = (flow: string, task?: string | null) => `the ${flow} run${task ? ` on ${task}` : ""}`;
