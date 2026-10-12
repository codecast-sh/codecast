// How bad a problem is for the people it reached, on the judges' own scale
// (judges/*.md): 9-10 breaks trust, 7-8 the contact noticed, 5-6 a lapse they
// likely missed. The problem page and the change card say it the same way.

import { findingConversation } from "@codecast/shared/contracts/judges";

type Finding = { _id: string; fingerprint?: string | null; moment?: string | null; severity?: number | null };

export function severityWord(n: number): string {
  return n >= 9 ? "breaks trust" : n >= 7 ? "contact noticed" : "likely unnoticed";
}

/** The conversations a contact noticed (severity 7 and up), counted once each. */
export function noticedCount(signals: ReadonlyArray<Finding>): number {
  return new Set(signals.filter((s) => (s.severity ?? 0) >= 7).map(findingConversation)).size;
}

/** The impact in a few words: "2 noticed by the contact", else the worst's word. Empty with no severity. */
export function impactLine(signals: ReadonlyArray<Finding>): string {
  const worst = signals.reduce((m, s) => Math.max(m, s.severity ?? 0), 0);
  if (!worst) return "";
  const noticed = noticedCount(signals);
  return noticed ? `${noticed} noticed by the contact` : severityWord(worst);
}
