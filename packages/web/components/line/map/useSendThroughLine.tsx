"use client";
// "Send through the line" for a station's prompt (docs/architecture/line-map.md
// LX5, LX6): the person's draft goes to the line as the change they propose,
// filed as a cause in the project, category `line`, its subject the station
// (`line:station:prove`), and the line runs it like any change. The causes sent
// from a station show under its editor, each opening its timeline, with
// "Start now" while it waits for the line.
import Link from "next/link";
import { lineCauseFields, lineSubject } from "../../../lib/line/lineCause";
import { lineRefHref } from "../../../lib/line/lineWorkspaceUrl";
import { useLineCauseActions, useLineCauses, type LineCauseRow } from "./useLineCause";

const STATUS_WORDS: Record<string, string> = {
  open: "waiting for the line",
  in_progress: "on the line",
  in_review: "on the line",
  done: "done",
  dropped: "dropped",
};

/** One cause against this station: its ref and title opening its timeline,
 *  where it stands, and "Start now" while it waits for the line. */
function CauseRow({ cause, onStart }: { cause: LineCauseRow; onStart: (taskId: string) => void }) {
  const filing = !cause.id;
  const waiting = !filing && cause.status === "open" && !cause.running;
  const title = <span style={{ color: "var(--sol-text)" }}>{cause.title}</span>;
  return (
    <li className="flex items-start gap-2 text-[12px] min-w-0 py-1" style={{ borderTop: "1px solid var(--sol-border)" }} data-change-cause={cause.shortId ?? cause.key} data-status={filing ? "filing" : cause.status}>
      <div className="min-w-0 flex-1">
        {cause.shortId
          ? <Link href={lineRefHref(cause.shortId)} className="block line-clamp-2 hover:underline" data-change-trace>{title}</Link>
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

/** Returns the send and the causes sent from this station, for the editor to show under itself. */
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
