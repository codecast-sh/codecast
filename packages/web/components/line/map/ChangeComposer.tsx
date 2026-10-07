"use client";
// The Change slot of a map panel (docs/architecture/line-map.md LX3, LX6): a
// composer that asks an agent for a change to this node of the line. The
// person says what should change; it is filed as a cause in the project,
// category `line`, its subject the node (`line:station:prove`,
// `line:finder:agentwatch`), their words its first signal, and the line runs
// it like any change: it shows the problem where it can, edits the line's
// files on a branch, scores a prompt change, and brings a card. The cause
// paints at once, links to its trace, and can be started now.
import { useState } from "react";
import Link from "next/link";
import type { MapNode } from "../../../lib/line/lineMap";
import { lineCauseFields, lineSubject } from "../../../lib/line/lineCause";
import { lineTraceHref } from "../../../lib/line/lineMapUrl";
import { KeyCap } from "../../KeyboardShortcutsHelp";
import { isMac } from "../../../shortcuts";
import { useLineCauseActions, useLineCauses, type LineCauseRow } from "./useLineCause";

export { lineSubject };

const STATUS_WORDS: Record<string, string> = {
  open: "waiting for the line",
  in_progress: "on the line",
  in_review: "on the line",
  done: "done",
  dropped: "dropped",
};

export function ChangeComposer({ node, projectId }: { node: Pick<MapNode, "id" | "kind" | "label" | "source">; projectId: string | null }) {
  const subject = lineSubject(node);
  const [words, setWords] = useState("");
  const actions = useLineCauseActions(projectId);
  const causes = useLineCauses(projectId, subject, actions.filed);
  const submit = () => {
    const fields = lineCauseFields({ subject, label: node.label, words });
    if (!fields || !projectId) return;
    if (actions.file(fields)) setWords("");
  };
  const ready = !!projectId && words.trim().length > 0;

  return (
    <div className="flex flex-col gap-2" data-change-composer={subject} data-project={projectId ?? undefined}>
      <textarea
        value={words}
        onChange={(e) => { setWords(e.target.value); if (actions.error) actions.clearError(); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
          if (e.key === "Escape" && words) { e.preventDefault(); e.stopPropagation(); setWords(""); }
        }}
        disabled={!projectId}
        rows={3}
        placeholder={projectId ? `What should change about ${node.label}? Say what it does now and what it should do.` : "Pick a project to ask for a change to its line."}
        aria-label={`Ask for a change to ${node.label}`}
        className="w-full text-[12px] leading-[1.5] p-2 rounded outline-none resize-y"
        style={{ color: "var(--sol-text)", background: "var(--sol-card)", border: "1px solid var(--sol-border)" }}
        data-change-words
      />
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="m-0 text-[11px] leading-[1.45] min-w-[16ch] flex-1" style={{ color: "var(--sol-text-dim)" }}>
          The line works it like any change and brings you a card before anything lands.
        </p>
        <button type="button" className="lset-primary shrink-0 inline-flex items-center gap-1.5 disabled:opacity-50" disabled={!ready} onClick={submit} data-change-submit>
          Ask for this change
          <span className="inline-flex items-center gap-0.5" aria-hidden>
            <KeyCap size="xs">{isMac ? "⌘" : "Ctrl"}</KeyCap><KeyCap size="xs">↵</KeyCap>
          </span>
        </button>
      </div>
      {actions.error && <p className="text-[11.5px]" style={{ color: "var(--sol-red)" }} role="alert" data-change-error>{actions.error}</p>}
      {causes.length > 0 && (
        <ul className="flex flex-col gap-1 m-0 p-0 list-none" data-change-causes>
          {causes.map((c) => <CauseRow key={c.key} cause={c} onStart={actions.start} />)}
        </ul>
      )}
    </div>
  );
}

/** One cause against this node: its ref and title linking to its trace, where
 *  it stands, and "Start now" while it waits for the line. */
export function CauseRow({ cause, onStart }: { cause: LineCauseRow; onStart: (taskId: string) => void }) {
  const filing = !cause.id;
  const waiting = !filing && cause.status === "open" && !cause.running;
  const title = <span style={{ color: "var(--sol-text)" }}>{cause.title}</span>;
  return (
    <li className="flex items-start gap-2 text-[12px] min-w-0 py-1" style={{ borderTop: "1px solid var(--sol-border)" }} data-change-cause={cause.shortId ?? cause.key} data-status={filing ? "filing" : cause.status}>
      <div className="min-w-0 flex-1">
        {cause.shortId
          ? <Link href={lineTraceHref(cause.shortId)} className="block line-clamp-2 hover:underline" data-change-trace>{title}</Link>
          : <span className="block line-clamp-2">{title}</span>}
        <div className="text-[11px]" style={{ color: "var(--sol-text-dim)" }}>
          <code style={{ color: "var(--sol-violet)" }}>{cause.shortId ?? "ct-…"}</code>{" "}
          {filing ? "filing" : STATUS_WORDS[cause.status] ?? cause.status.replace(/_/g, " ")}
        </div>
      </div>
      {waiting && (
        <button type="button" className="lset-ghost shrink-0" onClick={() => onStart(cause.id!)} data-change-start>
          Start now
        </button>
      )}
    </li>
  );
}

/**
 * "Send through the line" for a station's prompt (LX5): the person's draft
 * goes to the line as the change they propose, filed as the same cause the
 * composer files, instead of being applied untested. Returns the send and the
 * causes sent from this station, for the editor to show under itself.
 */
export function useSendThroughLine(projectId: string | null, node: { id: string; label?: string }) {
  const subject = lineSubject({ id: node.id, kind: "station" });
  const label = node.label || node.id;
  const actions = useLineCauseActions(projectId);
  const causes = useLineCauses(projectId, subject, actions.filed);
  const send = (draft: string, words = "") => {
    const fields = lineCauseFields({ subject, label, words, draft: { field: "prompt", text: draft } });
    return fields ? actions.file(fields) : null;
  };
  const sent = (causes.length > 0 || actions.error) ? (
    <div className="flex flex-col gap-1" data-station-sent>
      {actions.error && <p className="text-[11.5px]" style={{ color: "var(--sol-red)" }} role="alert">{actions.error}</p>}
      {causes.length > 0 && (
        <ul className="flex flex-col gap-1 m-0 p-0 list-none">
          {causes.map((c) => <CauseRow key={c.key} cause={c} onStart={actions.start} />)}
        </ul>
      )}
    </div>
  ) : null;
  return { send: projectId ? send : null, sent };
}
