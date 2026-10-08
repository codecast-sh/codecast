"use client";
// A goal's sheet (cohesive build spec §5.2), in the order every goal reads:
// the frame's head (owner, health with its day, the first number against its
// target, the target day; what it serves; Ask its owner), then Why, Measured
// by, Now, Carried by, Latest update, and folded at the foot The record and
// Activity. A goal's progress is its number, so the head carries no task bar.
// A section with nothing in it is not drawn: while a goal is thin, one dim
// line under the head names what is still to write, and each phrase opens
// its editor.
import { Fragment, useMemo, useState } from "react";
import { metricReadings, type InitiativeRow } from "@codecast/shared/contracts/initiative";
import { useInboxStore } from "../../../../store/inboxStore";
import { useCoarseNow } from "../../../../hooks/useCoarseNow";
import { useInitiativeUpdates, useSyncInitiativeUpdates } from "../../../../hooks/useInitiatives";
import { subInitiatives } from "../../../../lib/initiatives";
import { GoalActivity, GoalCarriedBy, GoalLatest, GoalMeasures, GoalWhy } from "../../../initiatives/InitiativePanel";
import { InitiativeRecord } from "../../../initiatives/InitiativeRecord";
import { recordHint, recordParts, type RecordPart } from "../../../initiatives/recordModel";
import { GoalGlyph } from "../../lines/lineAtoms";
import { goalFacts } from "../../lines/lineFacts";
import { sessionsUnder } from "../../goalsLayout";
import { findGoal, seatFor } from "../objects";
import { NowBlock } from "../NowBlock";
import { SheetFold, SheetFolds, SheetFrame, type SheetMenuItem } from "../SheetFrame";
import type { SheetRef } from "../sheetStack";
import { useCompanyRows, type CompanyRows } from "../useCompanyRows";
import { docGoalOf, useCompanyDoc } from "../../../company/useCompanyDoc";
import { NotHere } from "./sheetParts";
import { goalAncestors, goalNamed, workspaceCrumb } from "./sheetModel";

/** One dim line under the head while a goal is thin: what is still to write,
 *  each phrase a button that opens its editor. Not drawn once all is written. */
function StillToWrite({ items }: { items: ReadonlyArray<{ key: string; words: string; onOpen: () => void }> }) {
  if (items.length === 0) return null;
  return (
    <p className="mt-3 text-[12px] leading-relaxed" style={{ color: "var(--sol-text-dim)" }} data-goal-still>
      Still to write:{" "}
      {items.map((it, i) => (
        <Fragment key={it.key}>
          {i > 0 && <span aria-hidden> · </span>}
          <button type="button" onClick={it.onOpen} className="underline decoration-dotted underline-offset-[3px] hover:text-[var(--sol-text)] transition-colors" data-goal-still-item={it.key}>{it.words}</button>
        </Fragment>
      ))}
    </p>
  );
}

export function GoalSheet({ sheet }: { sheet: SheetRef }) {
  const rows = useCompanyRows();
  const now = useCoarseNow(30_000);
  const goal = findGoal(rows.goals, sheet.ref);
  useSyncInitiativeUpdates(goal?._id ?? null);
  const seat = useMemo(() => seatFor(sheet, rows), [sheet, rows]);
  const ancestors = useMemo(() => goalAncestors(rows.goals, goal), [rows.goals, goal]);
  const sessions = useMemo(() => (goal && rows.tree ? sessionsUnder(rows.tree, goal.project_ids) : []), [goal, rows.tree]);
  const { doc } = useCompanyDoc();

  if (!goal) {
    return (
      <SheetFrame kind="initiative" idRef={sheet.ref} glyph={<GoalGlyph />} title="Goal" crumbs={[workspaceCrumb(rows)]} loading={rows.goals.length === 0}>
        <NotHere what="goal" />
      </SheetFrame>
    );
  }
  return <GoalBody key={goal._id} goal={goal} rows={rows} now={now} seat={seat} ancestors={ancestors} sessions={sessions} docGoal={docGoalOf(doc, goal._id)} />;
}

function GoalBody({ goal, rows, now, seat, ancestors, sessions, docGoal }: {
  goal: InitiativeRow;
  rows: CompanyRows;
  now: number;
  seat: ReturnType<typeof seatFor>;
  ancestors: InitiativeRow[];
  sessions: ReturnType<typeof sessionsUnder>;
  docGoal: ReturnType<typeof docGoalOf>;
}) {
  const [measuring, setMeasuring] = useState(false);
  const [writingWhy, setWritingWhy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [carrying, setCarrying] = useState(false);
  const [recordFrom, setRecordFrom] = useState<RecordPart | null>(null);
  const updates = useInitiativeUpdates(goal._id);
  const parent = ancestors[ancestors.length - 1];
  const filled = recordParts(goal).length > 0;
  const hasActivity = goal.project_ids.length > 0 || subInitiatives(rows.goals, goal._id).length > 0 || updates.length > 0;
  const ended = goal.status === "completed" || goal.status === "cancelled";
  // What a thin goal still lacks, each phrase opening its own editor; a phrase goes once it is written or open.
  const missing = ended ? [] : [
    ...(!goal.why?.trim() && !goal.description?.trim() && !writingWhy ? [{ key: "why", words: "why it matters", onOpen: () => setWritingWhy(true) }] : []),
    ...(metricReadings(goal).length === 0 && !measuring ? [{ key: "number", words: "a number", onOpen: () => setMeasuring(true) }] : []),
    ...(!goal.done_when?.trim() && !recordFrom ? [{ key: "done_when", words: "what done looks like", onOpen: () => setRecordFrom("done_when") }] : []),
  ];

  const menu: SheetMenuItem[] = [
    ...(!writing ? [{ label: "Post an update", onSelect: () => setWriting(true) }] : []),
    ...(metricReadings(goal).length === 0 ? [{ label: "Add a number", onSelect: () => setMeasuring(true) }] : []),
    ...(goal.project_ids.length === 0 ? [{ label: "Add a project", onSelect: () => setCarrying(true) }] : []),
    ...(!ended ? [{ label: "Cancel this goal", danger: true, onSelect: () => useInboxStore.getState().updateInitiative(goal._id, { status: "cancelled" }) }] : []),
  ];

  return (
    <SheetFrame
      kind="initiative"
      idRef={goal.short_id || null}
      glyph={<GoalGlyph />}
      title={goal.title}
      onRename={(title) => useInboxStore.getState().updateInitiative(goal._id, { title })}
      crumbs={[workspaceCrumb(rows), ...ancestors.map(goalNamed)]}
      facts={goalFacts(goal, now, true)}
      serves={parent ? [goalNamed(parent)] : []}
      talk={seat}
      ask={seat ? { seat } : null}
      menu={menu}
    >
      <div data-goal-sheet={goal.short_id || goal._id}>
        <StillToWrite items={missing} />
        <GoalWhy goal={goal} writing={writingWhy} onWriting={setWritingWhy} />
        <GoalMeasures goal={goal} all={rows.goals} now={now} editing={measuring} onEditing={setMeasuring} />
        <NowBlock subject={{ keys: [`goal:${goal._id}`, ...(goal.short_id ? [`goal:${goal.short_id}`] : [])], refs: goal.short_id ? [goal.short_id] : [] }} sessions={sessions} rows={rows} />
        <GoalCarriedBy goal={goal} doc={docGoal} now={now} adding={carrying} onAdding={setCarrying} />
        <GoalLatest goal={goal} now={now} writing={writing} onWriting={setWriting} />
        {(filled || recordFrom || hasActivity) && (
          <SheetFolds>
            {(filled || recordFrom) && (
              <SheetFold key={recordFrom ?? "folded"} title="The record" hint={recordHint(goal) || undefined} defaultOpen={!!recordFrom}>
                <InitiativeRecord initiative={goal} now={now} start={recordFrom} />
              </SheetFold>
            )}
            {hasActivity && (
              <SheetFold title="Activity">
                <div className="max-h-[520px] overflow-y-auto"><GoalActivity goal={goal} all={rows.goals} /></div>
              </SheetFold>
            )}
          </SheetFolds>
        )}
      </div>
    </SheetFrame>
  );
}
