// What a person's press asks a session to do with flows (docs/architecture/flows.md FL4, FL5): the words the
// session receives, kept beside the other flow libs so the components that send them stay components.

/** What the session is asked: run its change through the flow, named after what the change does, and say how it ended. */
export function runThroughMessage(flow: { slug: string; label: string }): string {
  return `Run your change through the ${flow.label} flow: \`cast flow run ${flow.slug} --title "<what your change does>"\`. It takes every file this session changed here, so when you changed files that are not part of this change, name the ones that are with --only (check with --dry-run). When it ends, tell me where it stopped or that it passed.`;
}

/** What the session that ran a workflow is asked: make its shape a flow of the pool, its prompts free of this one task. */
export function addToFlowsMessage(name: string, runId: string): string {
  return `Add the ${name} workflow you ran (${runId}) to the pool of flows: \`cast flow import ${runId}\`. It starts as your draft. Make it general (its name, step names, description and prompts say what it does for any change, not this one task), then \`cast flow publish\` it. Tell me what the flow does and when to use it.`;
}

/** Whether a message is a Ship press: the session asked to run its change through a flow. */
export function isRunThroughPress(raw: string): boolean {
  const t = raw.trimStart();
  return t.startsWith("Run your change through the ") && t.includes("`cast flow run ");
}

/** Whether a message is one of these presses rather than something typed. */
export function isFlowPressMessage(raw: string): boolean {
  const t = raw.trimStart();
  return (t.startsWith("Run your change through the ") && t.includes("`cast flow run ")) ||
    (t.startsWith("Add the ") && t.includes("`cast flow import "));
}

export type PressMsg = { _id?: string; role?: string; content?: string; timestamp?: number };
/** A Ship press no run has answered yet: when it was sent, its message, and the session's last words since (none yet: null). */
export type Press = { at: number; id: string; reply: { id: string; text: string } | null };

/** The first paragraph of an answer, short enough to read at a glance. */
const gist = (text: string) => {
  const first = text.trim().split(/\n\s*\n/)[0]!.replace(/\s+/g, " ").replace(/[*_`]/g, "");
  return first.length > 220 ? `${first.slice(0, 220).replace(/\s+\S*$/, "")}…` : first;
};

/** The newest Ship press sent to this session since its newest run started, as a string so the subscription wakes only when it changes. */
const pressMemo = new WeakMap<ReadonlyArray<PressMsg>, { after: number; sig: string }>();
export function pressSig(msgs: ReadonlyArray<PressMsg>, newestRunAt: number): string {
  const hit = pressMemo.get(msgs);
  if (hit && hit.after === newestRunAt) return hit.sig;
  const sig = scanPress(msgs, newestRunAt);
  pressMemo.set(msgs, { after: newestRunAt, sig });
  return sig;
}

function scanPress(msgs: ReadonlyArray<PressMsg>, newestRunAt: number): string {
  let reply: PressMsg | null = null;
  // Far enough back for a session that did a long stretch of tool work after the press.
  for (let i = msgs.length - 1; i >= 0 && i >= msgs.length - 400; i--) {
    const m = msgs[i]!;
    if (!reply && m.role === "assistant" && typeof m.content === "string" && m.content.trim()) reply = m;
    if (m.role === "user" && typeof m.content === "string" && isRunThroughPress(m.content)) {
      return (m.timestamp ?? 0) > newestRunAt ? [m.timestamp ?? 0, m._id ?? "", reply?._id ?? "", reply ? gist(reply.content!) : ""].join("\u0000") : "";
    }
  }
  return "";
}

/** The press a signature from pressSig spells, or null for "". */
export function pressFromSig(sig: string): Press | null {
  if (!sig) return null;
  const [at, id, replyId, text] = sig.split("\u0000");
  return { at: Number(at), id: id!, reply: replyId ? { id: replyId, text: text! } : null };
}
