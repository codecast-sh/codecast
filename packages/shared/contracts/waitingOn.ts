// conversations.waiting_on: what a dormant session says it waits on, written
// by `cast state --status dormant --on <ref>` and cleared by any later pin
// without --on. The CLI and the server read the ref with this one parser, so a
// ref one accepts the other cannot refuse.
//
// Imported by path (@codecast/shared/contracts/waitingOn), never through the
// contracts barrel.
import { parseBlockerRef } from "../tasks/graph";

export const WAITING_ON_KINDS = ["person", "session", "task", "pr"] as const;
export type WaitingOnKind = (typeof WAITING_ON_KINDS)[number];
/** A session's ref is its conversation id (short ids collide across
 *  workspaces), with the short id in `label` for display. */
export type WaitingOn = {
  kind: WaitingOnKind;
  ref: string;
  label?: string;
  at: number;
  /** A person's wait: the card asked of them, whose answer wakes the session. */
  decision_id?: string;
  /** The card that went to the session's own person when that one sat a day unanswered. */
  escalation_id?: string;
};

export type ParsedWaitingOn =
  | { ok: true; kind: "person" | "session" | "task"; ref: string }
  // A bare #42 leaves the repository to the caller (the CLI fills in the checkout's origin).
  | { ok: true; kind: "pr"; repository?: string; pr_number: number }
  | { ok: false; error: string };

const PERSON = /^@[a-z0-9][a-z0-9._-]*$/i;
const SESSION = /^jx[a-z0-9]{4,}$/i;

export const WAITING_ON_USAGE = "a session (jx7c6zk), a task (ct-12), a pull request ('#42', owner/repo#42 or its URL) or a person (@handle)";

export function parseWaitingOnRef(raw: string): ParsedWaitingOn {
  const text = (raw ?? "").trim();
  if (!text) return { ok: false, error: `--on names what this session waits on: ${WAITING_ON_USAGE}` };
  if (PERSON.test(text)) return { ok: true, kind: "person", ref: text.toLowerCase() };
  if (SESSION.test(text)) return { ok: true, kind: "session", ref: text.toLowerCase() };
  const b = parseBlockerRef(text);
  if (!b.ok) return { ok: false, error: `"${text}" is not something to wait on: ${WAITING_ON_USAGE}` };
  if (b.kind === "task") return { ok: true, kind: "task", ref: b.ref };
  if (b.kind === "pr_merged") return { ok: true, kind: "pr", ...(b.repository ? { repository: b.repository } : {}), pr_number: b.pr_number };
  if (b.kind === "pr_checks_green") {
    return { ok: false, error: `--on waits for a pull request to merge or close; for green checks arm cast trigger add --on pr_checks_green --pr ${b.pr_number}` };
  }
  if (b.kind === "decision") return { ok: false, error: `${b.decision} wakes this session when it is answered: no --on needed` };
  return { ok: false, error: `--on waits on a session, task, pull request or person; for a time arm cast trigger add --in <duration>` };
}

/** The refusal of `--on @person` without the question their answer settles. */
export const personWaitNeedsAsk = (ref: string): string =>
  `--on ${ref} asks them a question, and their answer wakes this session: add --ask "<question>" (and -o "<option>" for each choice, or none for a free answer)`;

/** The stored ref of a pull request wait: "owner/repo#42". */
export const prWaitingRef = (repository: string, pr_number: number): string => `${repository.toLowerCase()}#${pr_number}`;

/** The repository and number a stored pull request ref names, or null. */
export function prOfWaitingRef(ref: string): { repository: string; pr_number: number } | null {
  const m = /^([^#\s]+\/[^#\s]+)#(\d+)$/.exec(ref);
  return m ? { repository: m[1], pr_number: Number(m[2]) } : null;
}
