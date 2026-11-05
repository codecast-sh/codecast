// The fingerprints finders compute for `signals.ingest` (docs/architecture/
// the-line-end-to-end.md LE3). A fingerprint is the dedupe key: the same
// observation seen again must hash to the same string, so a cause collects it
// instead of a second cause opening. Each finder's shape lives here once, so
// the CLI, the evals package and convex never spell one differently.
import { fnv1a32 } from "./inboxProjection";

/** What a signal can say it saw (LE3). The door, the CLI and a repo's line profile share this list. */
export const SIGNAL_KINDS = ["bug", "regression", "prompt_miss", "ux", "cohesion", "request"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** An eval finding: a surface and the check (a gate, a verdict) or freeze id it concerns. */
export function evalsSignalFingerprint(surface: string, ref: string): string {
  return `evals:${surface.trim()}:${ref.trim()}`;
}

// ── Ingested groups (docs/architecture/external-data.md X3, X6) ──
//
// A group's fingerprint is `<segment>:<fp>`, stable per source; the signal it
// promotes to carries the source's fingerprint_prefix in front. A check's
// segment is "invariant" so a check a product reports joins the cause its
// line finder files under the same scheme (`union:invariant:<id>`).

/** The fingerprint segment per group kind. Typed loosely so this file need not import the ingest contract. */
const GROUP_FINGERPRINT_SEGMENT: Record<string, string> = {
  error: "error",
  log: "log",
  job: "job",
  check: "invariant",
  metric: "metric",
  replay_issue: "replay",
};

/**
 * The fingerprint of a group: `<prefix>:<segment>:<fp>` with a prefix, or
 * `<segment>:<fp>` without. Groups store the unprefixed form (it is already
 * source-scoped by its index); signals use the prefixed one.
 */
export function groupFingerprint(prefix: string | undefined, kind: string, fp: string): string {
  const segment = GROUP_FINGERPRINT_SEGMENT[kind] ?? kind;
  const head = prefix?.trim();
  return head ? `${head}:${segment}:${fp}` : `${segment}:${fp}`;
}

function hex8(s: string): string {
  return fnv1a32(s).toString(16).padStart(8, "0");
}

/** A Sentry issue mirrored as a group: the issue id is already Sentry's grouping. */
export function sentryIssueFingerprint(issueId: string | number): string {
  return `sentry-${String(issueId).trim()}`;
}

/**
 * A message without its request ids (`[Request ID: 65293c3ba5e64535]`,
 * `(request id: abc-123)`): one per call, they name no cause, and in a title
 * they push the part that does (the function, the error) out of sight.
 */
export function dropRequestIds(text: string): string {
  return text.replace(/\s*[\[(]request[ _-]?id:?\s*[\w-]+[\])]/gi, "").replace(/ {2,}/g, " ").trim();
}

/**
 * An error message with the parts that differ per occurrence removed: uuids,
 * hex runs (addresses, hashes), ids that mix letters and digits (a Convex id,
 * a short id, a bundle hash) and numbers. "User 42 not found" and "User 97
 * not found" are one error, and so are two validator refusals that quote
 * different ids.
 */
export function normalizeErrorMessage(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{8,}\b/gi, "<id>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The first frame of a stack that is the product's own code, as `fn@file`.
 * Line and column numbers, query strings and bundler content hashes are
 * dropped: they move with every build, and a fingerprint that moves with the
 * build opens a new group per deploy. Reads V8 (`at fn (file:1:2)`) and
 * Firefox/Safari (`fn@file:1:2`) frames.
 */
export function topInAppFrame(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  for (const raw of stack.split("\n")) {
    const frame = parseStackFrame(raw);
    if (!frame?.in_app || !frame.file) continue;
    return `${frame.fn || "<anon>"}@${frame.file}`;
  }
  return undefined;
}

export interface StackFrame {
  /** The function name as written, empty when the frame names none. */
  fn: string;
  /** The location as written: url or path with line and column. */
  loc: string;
  /** The location with line, column, query, origin and bundler hash removed. */
  file: string;
  /** The product's own code: not a dependency, the runtime or an extension. */
  in_app: boolean;
}

/**
 * One line of a stack read as a frame, or null when it is not one (the
 * message line, a blank). The same reading topInAppFrame fingerprints with,
 * so a stack shown on the Ops page emphasizes the frames the group is keyed
 * on.
 */
export function parseStackFrame(raw: string): StackFrame | null {
  const line = raw.trim();
  const v8 = /^at\s+(?:(.+?)\s+\()?(.+?)\)?$/.exec(line);
  // Gecko frames must end in :line:col, so a message line holding an email is not a frame.
  const gecko = !v8 ? /^(.*?)@(.+:\d+:\d+)$/.exec(line) : null;
  const m = v8 ?? gecko;
  if (!m || !m[2]) return null;
  const loc = m[2];
  const file = loc
    .replace(/:\d+(:\d+)?$/, "")
    .replace(/[?#].*$/, "")
    .replace(/^[a-z]+:\/\/[^/]+/i, "")
    .replace(/[-.][A-Za-z0-9_]{8,}(?=\.(m?js|cjs|jsx?|tsx?)$)/, "");
  const in_app = !/node_modules|^node:|^native|<anonymous>|^internal\/|chrome-extension:|webpack\/bootstrap/.test(loc);
  return { fn: (m[1] ?? "").trim(), loc, file, in_app };
}

/** `[CONVEX Q(module:fn)] ...`: a Convex function's error, relayed to the client that called it. */
const CONVEX_RELAYED = /^\[CONVEX [QMA]\(([^)\s]+)\)\]/;

/**
 * Convex stopping a function that did too much: out of time (in either of
 * Convex's wordings), out of memory or past a read limit, with whatever detail
 * it appends. One function hits whichever limit the data reaches first, and
 * the one fix (do less work) ends all of them, so they are one error. A value
 * or a return value too large is another fix and stays its own error.
 */
const CONVEX_LIMIT = /^(?:Uncaught Error: )?(?:Function execution timed out|Your request timed out|JavaScript execution ran out of memory|Too many (?:reads|bytes read|documents read))\b.*$/gm;

/**
 * Where an error was thrown, as `fn@file`. A Convex error reaching the client
 * was thrown on the server: its client stack only shows the Convex client
 * receiving the reply, and reads differently per browser engine and per
 * build. Its own message carries the server's stack when there is one, and
 * otherwise the function names the place.
 */
export function errorCulprit(error: { message: string; stack?: string }): string | undefined {
  const relayed = CONVEX_RELAYED.exec(error.message.trimStart());
  if (relayed) return topInAppFrame(error.message) ?? relayed[1];
  return topInAppFrame(error.stack);
}

/**
 * What an error says, as it keys a group: the message without the stack
 * frames written into it (those name the culprit, and move with every call
 * path and build), without request ids, normalized, with Convex's limit
 * messages read as one.
 */
function errorKey(message: string): string {
  const text = dropRequestIds(message)
    .split("\n")
    .filter((line) => !parseStackFrame(line))
    .join("\n")
    .replace(CONVEX_LIMIT, "<convex limit>");
  return normalizeErrorMessage(text);
}

/**
 * An SDK error's fingerprint: the caller's own when it sent one, else a hash
 * of what the error says (errorKey) and where it was thrown (errorCulprit).
 */
export function sdkErrorFingerprint(error: { message: string; stack?: string; fingerprint?: string }): string {
  const explicit = error.fingerprint?.trim();
  if (explicit) return explicit;
  return hex8(`${errorKey(error.message)}|${errorCulprit(error) ?? ""}`);
}

/** A check is identified by the id its product gives it. */
export function checkFingerprint(id: string): string {
  return id.trim();
}

/**
 * A CI workflow on a repository's default branch (X7, the github-ci source):
 * one check per repository and workflow name, so a red run after red counts
 * on the same group and a green one recovers it.
 */
export function ciCheckFingerprint(repository: string, workflow: string): string {
  return checkFingerprint(`ci:${repository.trim().toLowerCase()}:${workflow}`);
}

/**
 * A check group filed for one CI run before groups were keyed by workflow: a
 * workflow with a run-name reported `Deploy <sha> for <actor>` as its name,
 * so every run opened its own group. It records a deploy and is not a problem;
 * its workflow's own group carries the check now.
 */
export function isCiRunRecord(g: { kind: string; title: string }): boolean {
  return g.kind === "check" && /^Deploy [0-9a-f]{7,40} for \S/.test(g.title);
}

/**
 * A group that is a record and not an issue: a CI run filed as its own group
 * (isCiRunRecord), or a check or metric that never failed. A passing reading
 * keeps its check's group (the last green a later red is judged against, the
 * newest run a late one is checked against), but a monitor is an issue only
 * once it fails, so lists and counts leave these out.
 */
export function isRecordNotIssue(g: { kind: string; title: string; count: number }): boolean {
  return isCiRunRecord(g) || ((g.kind === "check" || g.kind === "metric") && g.count === 0);
}

/**
 * A wall a recording shows (shared/replay/issues.ts): its kind and what
 * failed, so the same failure in many recordings is one replay_issue group.
 */
export function replayIssueFingerprint(kind: string, failure: string): string {
  return `${kind}-${hex8(failure)}`;
}

/**
 * What a job's failure said, as one key: its first line, spacing collapsed,
 * ids, times and long numbers (uuids, hex, ISO times) written as #, clipped. One job
 * groups many causes (a timeout, a closed connection, a billing refusal); the
 * group tallies its failures under these keys (event_groups.messages) and the
 * page splits the kept samples the same way.
 */
export function failureMessageKey(message: string | undefined | null): string {
  const line = (message ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, "#")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "#")
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{12,}\b/gi, "#")
    .replace(/\d{6,}/g, "#")
    .replace(/\s+/g, " ")
    .slice(0, 160);
}

/** A job's failures group by job name, whatever the case or spacing it was logged with. */
export function jobFingerprint(job: string): string {
  return job.trim().toLowerCase().replace(/\s+/g, "_");
}

/** A watched metric is identified by its key (a metric_watches short id or an app reader). */
export function metricFingerprint(key: string): string {
  return key.trim();
}
