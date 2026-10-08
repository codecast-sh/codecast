"use client";
// A goal's sheet (cohesive build spec §5.2), in the order every goal reads:
// the frame's head (owner, health with its day, the first number against its
// target, the target day; what it serves; Ask its owner), then Why, Measured
// by, Now, Carried by, Latest update, and folded at the foot The
// record and Activity. A goal's progress is its number, so the head carries
// no task bar. A section with nothing in it is not drawn; the menu starts
// what a fresh goal has not got yet, and an empty record is one line.
import { useMemo, useState } from "react";
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
import { findGoal, seatFor, type Member } from "../objects";
import { NowBlock } from "../NowBlock";
import { SheetFold, SheetFolds, SheetFrame, SheetSection, type SheetMenuItem } from "../SheetFrame";
import type { SheetRef } from "../sheetStack";
import { useCompanyRows, type CompanyRows } from "../useCompanyRows";
import { docGoalOf, useCompanyDoc } from "../../../company/useCompanyDoc";
import { NotHere } from "./sheetParts";
import { goalAncestors, goalNamed, workspaceCrumb } from "./sheetModel";

/** Whom to ask for the record: the seat that answers for the goal, else the person who owns it. */
function ownerName(goal: InitiativeRow, rows: CompanyRows, seatName: string | null): string | null {
  if (seatName) return seatName;
  const o = goal.owner;
  if (!o) return null;
  if (o.kind === "role") return rows.tree?.roles.find((r) => r._id === o.role_id)?.name ?? null;
  const person = rows.tree?.people.find((p) => p.user_id === o.user_id);
  if (person?.is_me) return null;
  return person?.name ?? (rows.members as Member[]).find((m) => String(m._id) === o.user_id)?.name ?? null;
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
  const [writing, setWriting] = useState(false);
  const [carrying, setCarrying] = useState(false);
  const [recordFrom, setRecordFrom] = useState<RecordPart | null>(null);
  const updates = useInitiativeUpdates(goal._id);
  const parent = ancestors[ancestors.length - 1];
  const filled = recordParts(goal).length > 0;
  const hasActivity = goal.project_ids.length > 0 || subInitiatives(rows.goals, goal._id).length > 0 || updates.length > 0;
  const owner = ownerName(goal, rows, seat?.name ?? null);
  const ended = goal.status === "completed" || goal.status === "cancelled";

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
        <GoalWhy goal={goal} />
        <GoalMeasures goal={goal} all={rows.goals} now={now} editing={measuring} onEditing={setMeasuring} />
        <NowBlock subject={{ keys: [`goal:${goal._id}`, ...(goal.short_id ? [`goal:${goal.short_id}`] : [])], refs: goal.short_id ? [goal.short_id] : [] }} sessions={sessions} rows={rows} />
        <GoalCarriedBy goal={goal} doc={docGoal} now={now} adding={carrying} onAdding={setCarrying} />
        <GoalLatest goal={goal} now={now} writing={writing} onWriting={setWriting} />
        {!filled && !recordFrom && (
          <SheetSection title="The record" data="record">
            <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--sol-text-muted)" }} data-goal-record-empty>
              Nothing recorded yet.{" "}
              {owner && <>Ask {owner} to write what done looks like, or </>}
              <button type="button" onClick={() => setRecordFrom("done_when")} className="underline decoration-dotted underline-offset-[3px] hover:text-[var(--sol-text)]" data-goal-record-start>{owner ? "write it yourself" : "Write what done looks like"}</button>.
            </p>
          </SheetSection>
        )}
        {(filled || recordFrom || hasActivity) && (
          <SheetFolds>
            {(filled || recordFrom) && (
              <SheetFold title="The record" hint={recordHint(goal) || undefined} defaultOpen={!!recordFrom}>
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
