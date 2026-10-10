// The line's chat as the workspace draws it (docs/architecture/line-workspace.md
// LW1 Chat; convex lineChat.ts): the server's row (who answers, each ask with
// its reply), the person's words still on their way, the opening line, and
// questions worth asking of this line, all read from the one model. Pure.
import type { LineIssue, LineModel } from "./lineModel";
import { discussionThread, type DiscussionEntry } from "../decisionDiscussion";

export type LineChatVia = "lead" | "line";

export type LineChatTurn = {
  client_id: string;
  text: string;
  at: number;
  graph: string | null;
  conversation_id: string;
  delivered: boolean;
  reply: { text: string; at: number } | null;
};

/** lineChat.thread's row, keyed by the project id. */
export type LineChatItem = {
  _id: string;
  project_id: string;
  owner: { conversation_id: string; short_id: string | null; name: string; via: LineChatVia } | null;
  turns: LineChatTurn[];
};

/** Words on their way: painted at once, retired when the row carries the same client id. */
export type LineChatSend = { client_id: string; text: string; at: number };

export type LineChatEntry = DiscussionEntry;

/** The thread as the chat draws it: the row's asks with their replies, then echoes still travelling, oldest first. */
export const lineChatThread = (row: LineChatItem | undefined, sends: readonly LineChatSend[] | undefined): LineChatEntry[] => discussionThread(row, sends);

/** Who the composer's words go to, in a person's words. */
export function answererWords(owner: LineChatItem["owner"] | undefined, ready: boolean): { name: string; why: string } {
  if (owner?.via === "lead") return { name: owner.name, why: "A session of its own answers for this line, under the project's lead, so your questions never mix with the lead's other work." };
  if (owner) return { name: owner.name, why: "A session of its own answers for this line." };
  if (!ready) return { name: "the line", why: "" };
  return { name: "a new line session", why: "Your first message starts a session briefed on the line, under the project's lead when it has one." };
}

/** The opening line: what the line is, in one sentence of its own numbers. */
export function greetingWords(model: LineModel): string {
  const steps = model.order.filter((id) => model.steps[id]?.kind !== "end");
  const agents = steps.filter((id) => model.steps[id].kind === "agent").length;
  const people = steps.filter((id) => model.steps[id].kind === "person").length;
  const runs = model.runs.length;
  const open = model.issues.filter((i) => i.status !== "done").length;
  const parts = [
    `${steps.length} steps`,
    agents ? `${agents} of them agents` : null,
    people ? `${people} ${people === 1 ? "asks you" : "ask you"}` : null,
  ].filter(Boolean).join(", ");
  const work = `${runs ? `${runs} ${runs === 1 ? "run" : "runs"} so far` : "no runs yet"}${open ? `; ${open} ${open === 1 ? "problem is" : "problems are"} open` : ""}`;
  return `${model.title}: ${parts}, ${work}. Ask about any step, run or decision, or say what a step should do differently.`;
}

/**
 * Questions worth asking of this line now, read from its own record: a
 * problem that came back after its fix, the step that fails most, a run that
 * just ended badly, what waits on the person. With a step open, about that
 * step. Each names real things, so a press asks something the record answers.
 */
export function suggestedQuestions(model: LineModel, focusStep: string | null, focusCase: LineIssue | null = null, max = 3): string[] {
  const out: string[] = [];
  const add = (q: string | null | undefined) => { if (q && !out.includes(q) && out.length < max) out.push(q); };
  const clip = (s: string, n = 64) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
  // The case in view leads: why it keeps happening, and what was already tried, so the next attempt does not repeat it.
  if (focusCase) {
    const name = focusCase.ref ?? `"${clip(focusCase.title, 40)}"`;
    const h = focusCase.history;
    add(h.regressed || h.recurrences.length || h.regressions.length ? `Why does ${name} keep coming back?` : `What causes ${name}?`);
    if (h.attempts.length) add("What did the earlier attempts try?");
  }
  const focus = focusStep ? model.steps[focusStep] : null;
  if (focus) {
    const top = [...focus.outcomes].sort((a, b) => b.count - a.count)[0];
    if (focus.kind === "agent" && focus.decisions.length) add(`Why does ${focus.label} ${top ? `say ${top.words}` : "decide what it does"} most often?`);
    if (focus.prompt) add(`Walk me through ${focus.label}'s prompt`);
    const wrong = focus.decisions.find((d) => d.label?.verdict === "wrong");
    if (wrong) add(`What would fix ${focus.label} on ${wrong.caseRef ?? clip(wrong.caseTitle, 30)}?`);
    if (focus.outcomes.length > 1) add(`Where does ${focus.label} send work, and how often?`);
  }
  const regressed = focusCase ? null : model.issues.find((i) => i.history.regressed);
  if (regressed) add(`Why did ${regressed.ref ?? `"${clip(regressed.title, 40)}"`} come back after its fix?`);
  const waiting = model.order.map((id) => model.steps[id]).find((s) => s?.kind === "person" && s.decisions.some((d) => d.status === "waiting"));
  if (waiting) add(`What is waiting for me at ${waiting.label}?`);
  const failing = [...model.graph.nodes].filter((n) => n.kind === "agent" && n.failed > 0).sort((a, b) => b.failed / Math.max(1, b.visits) - a.failed / Math.max(1, a.visits))[0];
  if (failing) add(`Why does ${failing.label} fail ${failing.failed === 1 ? "on one run" : `${failing.failed} times`}?`);
  const ended = focusCase ? null : model.runs.find((r) => !r.live && (r.outcome.tone === "failed" || r.outcome.tone === "stuck"));
  if (ended) add(`What happened on ${ended.caseRef ?? clip(ended.caseTitle, 36)}?`);
  add("Which path do most runs take?");
  return out;
}
