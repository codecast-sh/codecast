// What happened when review feedback was handed to an agent.
//
// Every path that sends notes to a session (`cast review send`, a pull
// request's pending notes handed to its session, a submitted review delivered
// to the shepherd, a published page's "Send all") reports one of these, so a
// caller never has to infer the result from which fields happen to be set.
// A send can also resolve the rows it sent; the resolve runs only after the
// send landed, and when it fails the outcome names the rows still open.

/** The message is in the session's queue, not yet read: mid-turn, or no live process. */
export type SendWaiting = "busy" | "offline";

export type SendOutcome =
  | { kind: "sent"; sent_ids: string[] }
  | { kind: "queued"; sent_ids: string[]; waiting: SendWaiting }
  | { kind: "sent_and_resolved"; sent_ids: string[]; waiting?: SendWaiting }
  | { kind: "resolve_failed"; sent_ids: string[]; open_ids: string[]; reason: string; waiting?: SendWaiting }
  | { kind: "failed"; reason: string };

export type SendOutcomeKind = SendOutcome["kind"];

/**
 * The outcome of a send that landed. `resolve` is present only when the
 * caller asked to resolve: `open_ids` are the sent rows that stayed open.
 */
export function deliveredOutcome(
  sentIds: string[],
  waiting: SendWaiting | null | undefined,
  resolve?: { open_ids: string[]; reason?: string },
): SendOutcome {
  const wait = waiting ?? undefined;
  if (resolve) {
    if (resolve.open_ids.length === 0) return { kind: "sent_and_resolved", sent_ids: sentIds, ...(wait ? { waiting: wait } : {}) };
    return {
      kind: "resolve_failed",
      sent_ids: sentIds,
      open_ids: resolve.open_ids,
      reason: resolve.reason ?? "Could not resolve",
      ...(wait ? { waiting: wait } : {}),
    };
  }
  return wait ? { kind: "queued", sent_ids: sentIds, waiting: wait } : { kind: "sent", sent_ids: sentIds };
}

export function failedOutcome(reason: unknown): SendOutcome {
  const text = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : String(reason ?? "");
  return { kind: "failed", reason: text.trim() || "The send failed" };
}

/** The message reached the session's queue (whatever happened to the resolve). */
export function outcomeDelivered(outcome: SendOutcome): boolean {
  return outcome.kind !== "failed";
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * One line for a toast or a terminal. `noun` names what was sent ("note",
 * "comment"); `to` names the session when the caller knows it.
 */
export function describeSendOutcome(outcome: SendOutcome, opts: { noun?: string; to?: string | null } = {}): string {
  const noun = opts.noun ?? "note";
  if (outcome.kind === "failed") return `Not sent: ${outcome.reason}`;
  const what = outcome.sent_ids.length ? count(outcome.sent_ids.length, noun) : "Review";
  const where = opts.to ? ` to ${opts.to}` : " to the session";
  const waiting = "waiting" in outcome ? outcome.waiting : undefined;
  const wait = waiting === "busy" ? ", queued until its turn ends" : waiting === "offline" ? ", queued until it is back online" : "";
  switch (outcome.kind) {
    case "sent":
    case "queued":
      return `${what} sent${where}${wait}`;
    case "sent_and_resolved":
      return `${what} sent${where}${wait} and resolved`;
    case "resolve_failed":
      return `${what} sent${where}${wait}; ${count(outcome.open_ids.length, noun)} still open: ${outcome.reason}`;
  }
}
