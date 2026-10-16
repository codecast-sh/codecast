"use client";
// Expectations (the-line-model.md LM5, learning-loop.md LL2): the lines every
// judge grades a moment against, versioned. The page is the document itself
// (ExpectationsDocument, the same one /expectations and a project's tab
// show), under its figures: the version judges read now, the lines in force,
// and the proposed changes waiting. A proposal's row opens in place here: the
// decision its proposing session asked (the one place it is answered), or,
// when nobody was asked, the proposal with its own Apply.
import { useMemo } from "react";
import { useProjectExpectations, useSyncProjectExpectations } from "../../../../hooks/useSyncProjectExpectations";
import { openProposals } from "../../../../lib/expectations/view";
import { ExpectationsDocument, UnaskedProposal, type ProposalOpener } from "../../../expectations/ExpectationsDocument";
import { DecisionSession } from "../../widgets/DecisionSession";
import { dayWords } from "../../widgets";
import type { LineViewProps } from "../views/types";
import { Back, StageHead } from "./parts";
import "./expectationsStage.css";

export function ExpectationsStage({ workspace: ws, href, select, selection, projectId }: LineViewProps & { projectId: string | null }) {
  useSyncProjectExpectations(projectId);
  const row = useProjectExpectations(projectId);
  const open = useMemo(() => openProposals(row), [row]);
  // A proposal's row opens its decision (sd-N) or, unasked, the proposal (xp-N), as the stage's item.
  const opener = useMemo<ProposalOpener>(() => ({
    href: (p) => href({ item: p.card ?? p.short_id }),
    open: (p) => select({ item: p.card ?? p.short_id }),
  }), [href, select]);
  if (!projectId) return <div className="lw-empty"><b>No project</b>Pick a project to read its expectations.</div>;

  const item = selection.item;
  const back = <Back label="Expectations" onBack={() => select({ item: null })} href={href({ item: null })} />;
  if (item?.startsWith("sd-")) {
    return (
      <div className="sd sd-fill" data-line-stage="expectations" data-line-expectations-decision={item}>
        {back}
        <div className="sd-decision"><DecisionSession id={item} /></div>
      </div>
    );
  }
  const unasked = item?.startsWith("xp-") && row ? open.find((p) => p.short_id === item) : null;
  if (unasked && row) {
    const byId = new Map((row.doc?.items ?? []).map((e) => [e.id, e]));
    return (
      <div className="sd" data-line-stage="expectations" data-line-expectations-proposal={item}>
        {back}
        <UnaskedProposal projectId={projectId} row={row} p={unasked} byId={byId} />
      </div>
    );
  }

  const items = row?.doc?.items ?? [];
  return (
    <div className="sd" data-line-stage="expectations">
      <StageHead
        title="Expectations"
        sub={row?.doc ? `Judges grade every moment against v${row.current_version}${row.doc.applied_at ? `, applied ${dayWords(row.doc.applied_at)}` : ""}` : "None written yet"}
        figures={[
          { label: "Version", n: row ? `v${row.current_version}` : "–" },
          { label: "In force", n: items.filter((e) => e.status === "active").length },
          { label: "Retired", n: items.filter((e) => e.status === "retired").length, tone: "dim" },
          { label: "Proposed", n: open.length, tone: open.length ? "you" : "dim" },
          { label: "Versions", n: row?.versions.length ?? "–", tone: "dim" },
        ]}
      />
      <div className="sd-doc" data-trial={ws.trialProjects.has(projectId) ? "" : undefined}>
        <ExpectationsDocument projectId={projectId} variant="panel" opener={opener} />
      </div>
    </div>
  );
}
