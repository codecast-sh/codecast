"use client";
// Ask an agent (line-workspace.md LW4): the person says what is wrong with the
// step; the labeled decisions go with it as examples, and an unsaved edit as
// the change they propose. It is filed as a cause against the line (LX6) and
// the project's line starts on it at once: an agent edits the prompt, replays
// the step on the labeled cases, and returns a card with before and after.
import { useMemo, useState } from "react";
import { askAgentFields, labeledCases } from "../../../../lib/line/lineActions";
import { useInboxStore } from "../../../../store/inboxStore";
import { taskStubId } from "../../../../store/taskStub";
import { useLineNav } from "../parts";
import type { AskSlotProps } from "../actionSlots";
import "./actions.css";

const newClientKey = () => `ask_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

type Sent = { key: string; result?: { task_short_id?: string; started: boolean; reason?: string; role_handle?: string }; error?: string };

export function AskPanel({ model, step, draft }: AskSlotProps) {
  const nav = useLineNav();
  const projectId = nav.projectId ?? null;
  const cases = useMemo(() => labeledCases(step), [step]);
  const [words, setWords] = useState("");
  const [sent, setSent] = useState<Sent | null>(null);
  // The cause as the store paints it, then as the server row supersedes it.
  const task = useInboxStore((s) => {
    if (!sent) return null;
    const stub = (s as any).tasks?.[taskStubId(sent.key)];
    if (stub) return stub;
    for (const id in (s as any).tasks ?? {}) if ((s as any).tasks[id]?.client_key === sent.key) return (s as any).tasks[id];
    return null;
  });
  const wrong = cases.filter((c) => c.verdict === "wrong").length;
  const can = !!projectId && (!!words.trim() || !!draft);

  const ask = async () => {
    if (!projectId) return;
    const fields = askAgentFields({ graphTitle: model.title, step, words, draft, cases });
    if (!fields) return;
    const key = newClientKey();
    setSent({ key });
    try {
      const result = await useInboxStore.getState().askLineAgent(key, projectId, fields);
      setSent({ key, result: result ?? undefined });
      setWords("");
    } catch (err) {
      setSent({ key, error: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="lw-ask" data-line-ask={step.id}>
      <label className="lw-ask-field">
        <span>What should change about {step.label}?</span>
        <textarea
          value={words}
          onChange={(e) => setWords(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && can) { e.preventDefault(); void ask(); } }}
          rows={4}
          placeholder="It keeps calling a stale lock a new mechanism when the cluster already names one."
        />
      </label>
      <div className="lw-ask-goes">
        {cases.length > 0
          ? <span>Goes with {cases.length} labeled {cases.length === 1 ? "case" : "cases"}{wrong ? `, ${wrong} marked wrong` : ""}: the agent checks its change against each.</span>
          : <span>No labeled cases yet. Mark decisions right or wrong and they go with the ask as examples.</span>}
        {draft && <span>Your unsaved edit goes as the change you propose.</span>}
      </div>
      {cases.length > 0 && (
        <div className="lw-ask-cases">
          {cases.map((c) => (
            <span key={c.runId} className="lw-ask-case" title={c.note ?? c.decided}>
              <span className="lw-labelmark" data-verdict={c.verdict}>{c.verdict === "right" ? "Right" : "Wrong"}</span>
              {c.caseRef ?? c.caseTitle}
            </span>
          ))}
        </div>
      )}
      <div className="lw-try-go">
        <button type="button" className="lw-act" data-primary="" onClick={ask} disabled={!can || (!!sent && !sent.result && !sent.error)}>
          Ask an agent
        </button>
        {!projectId && <span className="lw-try-fine">Open this step in its project's line to ask.</span>}
      </div>
      {sent && (
        <div className="lw-save-note" data-tone={sent.error || (sent.result && !sent.result.started) ? "warn" : "ok"} aria-live="polite">
          {sent.error ? `Not filed: ${sent.error}`
            : !sent.result ? `Filing ${task?.short_id && task.short_id !== "ct-…" ? task.short_id : "the ask"}…`
            : sent.result.started ? `Filed ${task?.short_id ?? sent.result.task_short_id}${sent.result.role_handle ? `; @${sent.result.role_handle}'s line is on it` : "; the line is on it"}. Its card comes back with before and after.`
            : `Filed ${task?.short_id ?? sent.result.task_short_id}, not started: ${sent.result.reason}`}
        </div>
      )}
    </div>
  );
}
