// What a selection of decisions can have done to it at once, through the
// palette: assign them, take the assignment back, pass them with a note,
// escalate them, answer them with an option they all offer, dismiss them. Every verb writes through
// the store's own decision actions, one row at a time, so each paints at once
// and rides the same dispatch a single row's press does.
import { approvesSecretRead } from "@codecast/shared/contracts/secrets";
import { useInboxStore, type SessionDecisionItem } from "../../store/inboxStore";
import { isOpen, type DecisionOwner } from "./decisionRows";

type Rows = ReadonlyArray<SessionDecisionItem>;

const open = (rows: Rows) => rows.filter(isOpen);

export function assignDecisions(rows: Rows, to: DecisionOwner): number {
  const { passDecision } = useInboxStore.getState();
  const targets = open(rows);
  for (const d of targets) passDecision(d._id, to);
  return targets.length;
}

export function unassignDecisions(rows: Rows): number {
  const { unassignDecision } = useInboxStore.getState();
  const targets = open(rows).filter((d) => !!d.passed_to);
  for (const d of targets) unassignDecision(d._id);
  return targets.length;
}

/**
 * The answers every selected open decision offers by the same label, each a
 * plain pick (an Ask first approval confirms with Touch ID one at a time, on
 * its own card, so it is left out), in the first decision's order.
 */
export function sharedAnswers(rows: Rows): string[] {
  const targets = open(rows);
  if (targets.length === 0 || targets.some((d) => d.kind && d.kind !== "single")) return [];
  const pickable = (d: SessionDecisionItem) => new Set(d.options.filter((_, i) => !approvesSecretRead(d, i)).map((o) => o.label));
  const [first, ...rest] = targets.map(pickable);
  return targets[0].options.map((o) => o.label).filter((l) => first.has(l) && rest.every((s) => s.has(l)));
}

export function answerDecisions(rows: Rows, label: string): number {
  const { answerDecision } = useInboxStore.getState();
  let n = 0;
  for (const d of open(rows)) {
    const index = d.options.findIndex((o) => o.label === label);
    if (index < 0 || approvesSecretRead(d, index)) continue;
    void answerDecision(d._id, { index });
    n++;
  }
  return n;
}

export function dismissDecisions(rows: Rows): number {
  const { answerDecision } = useInboxStore.getState();
  const targets = open(rows);
  for (const d of targets) void answerDecision(d._id, { dismiss: true });
  return targets.length;
}

/** Pass with a note: each moves to the new owner's queue, the note with it. */
export function passDecisions(rows: Rows, to: DecisionOwner, note: string): number {
  const { passDecision } = useInboxStore.getState();
  const targets = open(rows);
  for (const d of targets) passDecision(d._id, to, note);
  return targets.length;
}

/** Escalate with a note: each goes up to its owner's manager, else the workspace's admins (store escalateDecision). */
export function escalateDecisions(rows: Rows, note: string): number {
  const { escalateDecision } = useInboxStore.getState();
  const targets = open(rows);
  for (const d of targets) escalateDecision(d._id, note);
  return targets.length;
}
