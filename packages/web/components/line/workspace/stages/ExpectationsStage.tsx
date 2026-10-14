"use client";
// Expectations (the-line-model.md LM5, learning-loop.md LL2): the lines every
// judge grades a moment against, versioned. The page is the document itself
// (ExpectationsDocument, the same one /expectations and a project's tab
// show), under its figures: the version judges read now, the lines in force,
// and the proposals waiting, which a trial asks as decisions in For you.
import { useProjectExpectations, useSyncProjectExpectations } from "../../../../hooks/useSyncProjectExpectations";
import { openProposals } from "../../../../lib/expectations/view";
import { ExpectationsDocument } from "../../../expectations/ExpectationsDocument";
import { dayWords } from "../../widgets";
import type { LineViewProps } from "../views/types";
import { StageHead } from "./parts";

export function ExpectationsStage({ model, workspace: ws, href, select, projectId }: LineViewProps & { projectId: string | null }) {
  useSyncProjectExpectations(projectId);
  const row = useProjectExpectations(projectId);
  if (!projectId) return <div className="lw-empty"><b>No project</b>Pick a project to read its expectations.</div>;
  const items = row?.doc?.items ?? [];
  const proposals = openProposals(row).length;
  const toForYou = href({ view: "foryou", process: model.graphKey, stage: null, step: null });
  return (
    <div className="sd" data-line-stage="expectations">
      <StageHead
        title="Expectations"
        sub={row?.doc ? `Judges grade every moment against v${row.current_version}${row.doc.applied_at ? `, applied ${dayWords(row.doc.applied_at)}` : ""}` : "None written yet"}
        figures={[
          { label: "Version", n: row ? `v${row.current_version}` : "–" },
          { label: "In force", n: items.filter((e) => e.status === "active").length },
          { label: "Retired", n: items.filter((e) => e.status === "retired").length, tone: "dim" },
          { label: "Proposed", n: proposals ? <a className="lw-link" href={toForYou} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); select({ view: "foryou", process: model.graphKey, stage: null, step: null }); }} data-line-expectations-proposed>{proposals}</a> : 0, tone: proposals ? "you" : "dim" },
          { label: "Versions", n: row?.versions.length ?? "–", tone: "dim" },
        ]}
      />
      <div className="sd-doc" data-trial={ws.trialProjects.has(projectId) ? "" : undefined}>
        <ExpectationsDocument projectId={projectId} variant="panel" />
      </div>
    </div>
  );
}
