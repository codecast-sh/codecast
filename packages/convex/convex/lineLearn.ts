// Learn (docs/architecture/the-line-end-to-end.md LE12): what an answered card
// gate leaves behind. Every answer is written to the recorded decisions log
// with its rationale; a Revise or Drop with a note also proposes a
// countermeasure as its own small signal (source "lesson", kind "cohesion"),
// filed through the signal door like any finder's.
//
// It runs inside the one settle path every resolution takes
// (sessionDecisions.settleResolution), so the web, the CLI and the run panel
// all learn the same way and no second answer path exists.
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { insertDecision } from "./decisions";
import { parseWorkspaceKey } from "./lib/access";
import { CARD_GATE_NODE_ID, verdictLabel, verdictOfOption } from "@codecast/shared/contracts/changeCard";
import { fnv1a32 } from "@codecast/shared/contracts";

type Answer = { status: string; answer_index?: number; answer_text?: string };

/** Whether this decision is the card's gate on a line run (LE11). */
export function isCardGate(row: Pick<Doc<"session_decisions">, "workflow_run_id" | "gate_node_id">): boolean {
  return !!row.workflow_run_id && row.gate_node_id === CARD_GATE_NODE_ID;
}

/**
 * The person's note beside the chosen option. The run panel's text carries
 * the gate key in front ("R: add a test", "[R] add a test") and a card answer
 * may repeat the option's word; neither is part of the note.
 */
export function gateNote(text: string | undefined, key: string | undefined, label: string | undefined): string {
  let note = (text ?? "").trim();
  const strip = (word: string | undefined) => {
    if (!word) return;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    note = note.replace(new RegExp(`^\\[?${escaped}\\]?(?=[:\\s.,-]|$)[:\\s.,-]*`, "i"), "").trim();
  };
  strip(key);
  strip(label?.replace(/^\[[^\]]*\]\s*/, ""));
  return note;
}

/** The lesson's fingerprint: one per task and note, so a repeated answer files nothing new. */
export function lessonFingerprint(taskShortId: string, note: string): string {
  const normal = note.toLowerCase().replace(/\s+/g, " ").trim();
  return `lesson:${taskShortId}:${fnv1a32(normal).toString(16).padStart(8, "0")}`;
}

const firstLine = (text: string, max: number) => {
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? text.trim();
  return line.length > max ? `${line.slice(0, max - 3).trimEnd()}...` : line;
};

/**
 * The card gate's answer, learned from (LE12). A no-op for any other
 * decision, and for a dismissal: only an answer carries a verdict.
 */
export async function learnFromCardGate(ctx: any, row: Doc<"session_decisions">, answer: Answer, answeredBy: Id<"users"> | undefined): Promise<void> {
  if (!isCardGate(row) || answer.status !== "answered" || answer.answer_index === undefined) return;
  const option = row.options[answer.answer_index]?.label;
  const verdict = verdictOfOption(option);
  if (!verdict) return;
  const run = await ctx.db.get(row.workflow_run_id!);
  const key: string | undefined = run?.gate_choices?.[answer.answer_index]?.key;
  const note = gateNote(answer.answer_text, key, option);
  const task: Doc<"tasks"> | null = row.task_id ? await ctx.db.get(row.task_id) : null;
  const conversation: Doc<"conversations"> | null = await ctx.db.get(row.conversation_id);
  const userId = answeredBy ?? row.user_id;
  const chosen = verdictLabel(verdict);

  const others = row.options.map((o) => o.label).filter((_, i) => i !== answer.answer_index);
  await insertDecision(ctx, userId, {
    title: row.question,
    rationale: [`${chosen}${note ? `: ${note}` : "."}`, task ? `Task ${task.short_id}.` : null].filter(Boolean).join(" "),
    alternatives: others.length ? others : undefined,
    tags: ["line", `card:${verdict}`, ...(task ? [task.short_id] : [])],
    project_path: conversation?.project_path ?? undefined,
  }, conversation);

  if (verdict === "ship" || !note || !task) return;
  // The lesson is filed where its cause lives. A personal cause files as its
  // owner, because a personal workspace is only ever its owner's.
  const ws = parseWorkspaceKey(task.workspace);
  const scope = ws?.type === "team"
    ? { workspace: "team" as const, team_id: ws.teamId }
    : { workspace: "personal" as const };
  const filer = ws?.type === "personal" ? ws.userId : userId;
  await ctx.scheduler.runAfter(0, internal.signals.ingestAs, {
    user_id: filer,
    ...scope,
    source: "lesson",
    kind: "cohesion",
    fingerprint: lessonFingerprint(task.short_id, note),
    title: `Prevent what ${chosen} on ${task.short_id} caught: ${firstLine(note, 160)}`,
    detail_md: `${note}\n\nFrom the card on ${task.short_id} (${task.title}), answered ${chosen}.`,
    subject: task.short_id,
  });
}
