"use client";
// One edit to a repo's pipeline, composed on the page (docs/architecture/
// pipeline.md PL5): the edits as one form, previewed as the words, the lane's
// own track with the edit drawn in (dashed amber), and what it would have run on. Confirming
// starts a session in the repo whose first message is the exact `cast flow
// edit` command and the ask to ship it through the flow, through the shared
// confirm flow. The page writes no checkout; until the edit is live, the
// pipeline draws it as a ghost (pipelineModel `pending`).
import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { SwitchReview } from "../../consequential/ConsequentialSwitch";
import { pipelineEditLedger } from "../../consequential/pipelineEditLedger";
import { spawnSessionWithPrompt } from "../../../lib/spawnSession";
import { drawnFlow, pipelineModel, type PipelineModel } from "../../../lib/line/pipelineModel";
import { trackOf } from "../../../lib/line/pipelineView";
import { PipelineTrack } from "./PipelineTrack";
import { flowDiagram } from "../../../lib/line/flowDiagram";
import { editChanges, editCommand, editSessionMessage, editWords, groupsOf, idOf, lineDiff, opsFor, wouldRun, type AddDoes, type EditOp, type PipelineEdit } from "../../../lib/line/pipelineEdit";
import type { Pipeline } from "../../../lib/line/pipelineTypes";

export type ComposerStart = { lane: "change" | "release"; op: EditOp; station?: string | null; at?: "after" | "before" };

const OPS: Array<{ op: EditOp; word: string }> = [
  { op: "add", word: "Add a station" },
  { op: "guide", word: "Add guidance" },
  { op: "prompt", word: "Replace prompt" },
  { op: "run", word: "Change command" },
  { op: "when", word: "Run only when" },
  { op: "skip", word: "Skip" },
];
const DOES: Array<{ does: AddDoes; word: string }> = [{ does: "run", word: "Command" }, { does: "agent", word: "Agent" }, { does: "person", word: "Person" }];


export function EditComposer({ pipeline, start, where, recent, onClose }: {
  pipeline: Pipeline;
  start: ComposerStart;
  /** Where the edit session starts: the repo's checkout and the machine holding it; null when no checkout is known. */
  where: { root: string; device: string | null; machine: string | null } | null;
  /** The repo's recent changes with their files, for "would have run on"; null when the pipeline carries none. */
  recent: ReadonlyArray<{ files: readonly string[] }> | null;
  onClose: () => void;
}) {
  const flow = start.lane === "change" ? pipeline.change : pipeline.release;
  // The steps the passing path draws, in order: where a new station can go. A branch of a side-by-side group is not
  // one: a station added at a branch goes after its group ("after CI and review").
  // The spots on the path, by the name the lane draws (a side-by-side group by its own name, "CI and review").
  const main = useMemo(() => flowDiagram(drawnFlow(flow)).steps.filter((st) => st.kind !== "join").map((st) => ({ id: st.id, label: st.label })), [flow]);
  const groups = useMemo(() => groupsOf(flow), [flow]);
  const anchor = (id: string | null | undefined) => (id ? groups.get(id) ?? id : main[0]?.id ?? "");
  const [op, setOp] = useState<EditOp>(start.op);
  // The stations each edit can be about: a group's branches take only what they run; adding goes on the path.
  const editable = useMemo(() => flow.stations.filter((x) => x.who !== "rule"), [flow]);
  const takes = (o: EditOp, id: string) => opsFor(flow.stations.find((x) => x.id === id), groups.has(id)).has(o);
  const choices = (o: EditOp) => (o === "add" ? main : editable.filter((x) => takes(o, x.id)).map((x) => ({ id: x.id, label: x.label })));
  const [station, setStation] = useState<string>(() => {
    if (start.op === "add") return anchor(start.station);
    const list = choices(start.op);
    return list.find((x) => x.id === start.station)?.id ?? list[0]?.id ?? "";
  });
  const s = flow.stations.find((x) => x.id === station) ?? null;
  const [at, setAt] = useState<"after" | "before">(start.at ?? "after");
  const [label, setLabel] = useState("");
  const [does, setDoes] = useState<AddDoes>("run");
  const [body, setBody] = useState("");
  const [when, setWhen] = useState("");
  const [text, setText] = useState("");
  const [reviewing, setReviewing] = useState(false);
  // A tab shows when some station takes it; picking one moves the station to the first that does, and the heading says which.
  const tabs = OPS.filter((o) => choices(o.op).length);
  const prompted = s?.own === "inherited" && flow.base !== null ? "Inherited" : "Current prompt";
  const label$ = (id: string) => main.find((x) => x.id === id)?.label ?? flow.stations.find((x) => x.id === id)?.label ?? id;

  // The edit the form says, or null while it says too little to be one.
  const edit = useMemo<PipelineEdit | null>(() => {
    if (!station) return null;
    switch (op) {
      case "add": return label.trim() && body.trim() ? { op, id: idOf(label), label: label.trim(), at, station, does, body: body.trim(), ...(when.trim() ? { when: when.trim() } : {}) } : null;
      case "guide": return text.trim() ? { op, station, text: text.trim() } : null;
      case "prompt": return text.trim() ? { op, station, text: text.trim() } : null;
      case "run": return text.trim() ? { op, station, command: text.trim() } : null;
      case "when": return { op, station, globs: when.trim() || "always" };
      case "skip": return { op, station };
    }
  }, [op, station, label, body, at, does, when, text]);

  const model = useMemo<PipelineModel | null>(() => (edit ? pipelineModel(pipeline, [], [], [], 0, [{ flow: flow.slug, edit, session: { id: "", title: "this edit" } }]) : null), [edit, pipeline, flow.slug]);
  const preview = model ? model[start.lane] : null;
  // The edit can be reviewed only when the preview draws it: a new station on the path, or a station whose words change.
  const drawable = !!edit && !!preview && (edit.op === "add"
    ? preview.diagram.steps.some((st) => st.id === edit.id || st.inner.some((x) => x.id === edit.id))
    : editChanges(flow, edit));
  const words = edit ? editWords(edit, label$) : null;
  const command = edit ? editCommand(flow.slug, edit) : null;
  const globs = op === "add" || op === "when" ? when.trim() : "";
  const hits = recent && globs && globs !== "always" ? wouldRun(globs, recent) : null;

  const pickOp = (next: EditOp) => {
    setOp(next);
    const list = choices(next);
    const to = next === "add" ? anchor(station) : list.find((x) => x.id === station)?.id ?? list[0]?.id ?? "";
    setStation(to);
    // A prompt or command edit starts from what the station runs now.
    const t = flow.stations.find((x) => x.id === to);
    if (next === "prompt") setText(t?.prompt ?? "");
    else if (next === "run") setText(t?.runs ?? "");
    else if (next === "guide") setText(t?.guide ?? "");
    else if (next === "when") setWhen(t?.when?.join(", ") ?? "");
  };

  // One name for the checkout the session starts in, in the footer and in the confirm.
  const checkoutName = where?.root.split("/").pop() ?? undefined;

  const send = () => {
    if (!edit || !command || !words || !where) return;
    spawnSessionWithPrompt({
      prompt: editSessionMessage(flow, [command], words),
      projectPath: where.root,
      ...(where.device ? { targetDeviceId: where.device } : {}),
      failureLabel: "Failed to start the pipeline edit session",
    });
    toast.success("Edit session started", { description: "It is in your inbox; the pipeline shows the edit until it is live." });
    onClose();
  };

  return (
    <section className="rpl-compose" aria-label={`Edit ${flow.label}`} data-pipeline-composer>
      <header className="rpl-compose-head">
        <span className="rpl-compose-title">{OPS.find((o) => o.op === op)?.word} · {op === "add" ? `${at} ${label$(station)}` : label$(station)}</span>
        <button type="button" className="fsp-close" onClick={onClose} aria-label="Close the edit"><X aria-hidden strokeWidth={2} /></button>
      </header>

      <div className="rpl-compose-ops" role="tablist" aria-label="Edit">
        {tabs.map((o) => (
          <button key={o.op} type="button" role="tab" aria-selected={op === o.op} onClick={() => pickOp(o.op)} className="rpl-compose-op">{o.word}</button>
        ))}
      </div>

      <div className="rpl-compose-form">
        {op === "add" ? (
          <>
            <label className="rpl-field"><span>Name</span><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Lint" autoFocus /></label>
            <div className="rpl-field"><span>Goes</span>
              <span className="rpl-inline">
                <select value={at} onChange={(e) => setAt(e.target.value as "after" | "before")}><option value="after">after</option><option value="before">before</option></select>
                <StationPick stations={main} value={station} onChange={setStation} />
              </span>
            </div>
            <div className="rpl-field"><span>Does</span>
              <span className="rpl-seg" role="radiogroup">
                {DOES.map((d) => <button key={d.does} type="button" role="radio" aria-checked={does === d.does} onClick={() => setDoes(d.does)}>{d.word}</button>)}
              </span>
            </div>
            <label className="rpl-field"><span>{does === "run" ? "Command" : does === "agent" ? "Prompt" : "Question"}</span>
              {does === "run"
                ? <input className="rpl-mono" value={body} onChange={(e) => setBody(e.target.value)} placeholder="bun run lint --changed" />
                : <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder={does === "agent" ? "What the agent does" : "What the person decides"} />}
            </label>
            <label className="rpl-field"><span>Only when</span><input className="rpl-mono" value={when} onChange={(e) => setWhen(e.target.value)} placeholder="every change (or paths: landing/**, src/api/**)" /></label>
          </>
        ) : (
          <div className="rpl-field"><span>Station</span><StationPick stations={choices(op)} value={station} onChange={(id) => { setStation(id); setText(""); }} /></div>
        )}
        {op === "guide" ? (
          <>
            <div className="rpl-field rpl-field-top"><span>{prompted}</span><pre className="rpl-inherited">{s?.prompt ?? ""}</pre></div>
            <label className="rpl-field rpl-field-top"><span>Guidance</span><textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="What this repo adds to the prompt" autoFocus /></label>
          </>
        ) : op === "prompt" ? (
          <label className="rpl-field rpl-field-top"><span>Prompt</span><textarea className="rpl-prompt-editor" value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(40, Math.max(12, text.split("\n").length + 2))} /></label>
        ) : op === "run" ? (
          <label className="rpl-field"><span>Command</span><input className="rpl-mono" value={text} onChange={(e) => setText(e.target.value)} /></label>
        ) : op === "when" ? (
          <label className="rpl-field"><span>Only when</span><input className="rpl-mono" value={when} onChange={(e) => setWhen(e.target.value)} placeholder="every change (or paths: landing/**)" autoFocus /></label>
        ) : null}
      </div>

      {edit && preview ? (
        <div className="rpl-compose-preview">
          <div className="rpl-compose-words">{drawable ? words : edit.op === "add" ? "This place is not on the passing path" : "Nothing changes yet"}</div>
          {edit.op === "prompt" && drawable ? <PromptDiff before={s?.prompt ?? ""} after={edit.text} /> : null}
          <div className="rpl-compose-figs">
            {hits ? <span className="rpl-fig" data-on=""><b className="lw-num">{hits.hits}</b> of the last {hits.total} changes would have run it</span>
              : globs && globs !== "always" ? <span className="rpl-fig">no recent changes known yet</span>
              : op === "add" ? <span className="rpl-fig" data-on="">runs on every change</span> : null}
          </div>
          {model ? <div className="rpl-compose-track"><PipelineTrack items={trackOf(model, start.lane)} small /></div> : null}
          <details className="rpl-compose-cmd"><summary>Command</summary><code>{command}</code></details>
        </div>
      ) : null}

      <footer className="rpl-compose-foot">
        <button type="button" className="rpl-primary" disabled={!drawable || !where} onClick={() => setReviewing(true)}>Review edit</button>
        {!where ? <span className="rpl-fig" data-tone="bad">no checkout of this repo known</span> : <span className="rpl-fig" title={where.root}>in {checkoutName}{where.machine ? ` on ${where.machine}` : ""}</span>}
      </footer>
      {reviewing && drawable && edit && words && command && where ? (
        <SwitchReview
          ledger={pipelineEditLedger({ repo: pipeline.repository.split("/").pop() ?? pipeline.repository, checkout: checkoutName, words, command, flow: pipeline.change.label, machine: where.machine, checkedBy: edit && edit.op !== "add" && start.lane === "change" ? label$(edit.station) : null, hits })}
          onClose={() => setReviewing(false)}
          onConfirm={send}
        />
      ) : null}
    </section>
  );
}

function StationPick({ stations, value, onChange }: { stations: ReadonlyArray<{ id: string; label: string }>; value: string; onChange: (id: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {stations.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
    </select>
  );
}

/** A prompt edit as the lines it removes and adds, with a line of what stays around each change. */
function PromptDiff({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after);
  const near = new Set<number>();
  lines.forEach((l, i) => { if (l.kind !== "same") for (const k of [i - 1, i, i + 1]) near.add(k); });
  const rows: Array<{ kind: "same" | "del" | "add" | "gap"; text: string }> = [];
  lines.forEach((l, i) => {
    if (near.has(i)) rows.push(l);
    else if (rows[rows.length - 1]?.kind !== "gap") rows.push({ kind: "gap", text: "" });
  });
  return (
    <pre className="rpl-diff" aria-label="What the prompt edit changes">
      {rows.map((r, i) => <span key={i} className="rpl-diff-line" data-kind={r.kind}>{r.kind === "gap" ? "⋯" : `${r.kind === "add" ? "+ " : r.kind === "del" ? "− " : "  "}${r.text}`}{"\n"}</span>)}
    </pre>
  );
}
