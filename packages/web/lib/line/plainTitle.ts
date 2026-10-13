// A problem's raw title as a person would say it, when no written name exists
// (cause.named): the commit-style prefix, ids, hashes and thread references are
// evidence the problem's page keeps, never part of what a list or a decision's
// head calls it. "Main CI red at ac5c98b: x fails" reads "Main CI red: x fails";
// "Samvit's ruling (#team thread 1791598261.885089, Oct 10 04:35Z): ..." reads
// "Samvit's ruling: ...". Pure.

/** A short git hash or hex id: 7 to 40 hex characters holding both a digit and a letter. */
const HEX = String.raw`(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}`;
const UUID = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;
/** A codecast short id (ct-N, sd-N, tc-N, pl-N, tr-N, sg-N). */
const REF = String.raw`(?:ct|sd|tc|pl|tr|sg)-\d+`;
/** A Convex document id or a run id: a long lowercase token with digits in it. */
const DOC_ID = String.raw`(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{20,40}`;
/** A Slack message ts (1791598261.885089) or channel id (C0AQ2LDAV6J). */
const SLACK = String.raw`\d{9,}(?:\.\d+)?|C[0-9A-Z]{8,11}`;
const ID = `(?:${UUID}|${HEX}|${REF}|${DOC_ID}|${SLACK})`;

/** A parenthetical that carries an id, a thread or a clock time: evidence a reader cannot use in a name. Ids match
 *  case-sensitively: a Slack channel id is upper case, every other id lower, and an English word is neither. */
const ID_ASIDE = new RegExp(String.raw`\s*\((?=[^()]*(?:\b${ID}\b|#\w*\s*thread|\b\d{1,2}:\d{2}))[^()]*\)`, "g");
/** An id inline, with the preposition that only pointed at it ("red at ac5c98b", "in ct-123"). */
const INLINE_ID = new RegExp(String.raw`(?:\s+(?:at|in|on|by|from|of|see|per|run|thread)){0,2}\s*\b${ID}\b`, "g");
/** A "conventional commit" lead: "fix(web): ", "feat!: ". */
const COMMIT_LEAD = /^(?:feat|fix|chore|refactor|perf|docs|test|tests|build|ci|style|revert)(?:\([^)]*\))?!?:\s+/i;

export function plainTitle(title: string): string {
  let t = title.trim().replace(COMMIT_LEAD, "");
  t = t.replace(ID_ASIDE, "");
  // A PR or issue number: "#3850's classifier" is "the classifier"; a bare "#3850" goes.
  t = t.replace(/(^|\s)#\d{2,}'s\b/g, "$1the").replace(/\s*\(?#\d{2,}\)?(?=[\s,.;:]|$)/g, "");
  t = t.replace(INLINE_ID, "");
  // What the removals leave behind: empty asides, doubled spaces, a space before punctuation, a dangling separator.
  t = t.replace(/\(\s*[,;]?\s*\)/g, "").replace(/\s+([:,;.)])/g, "$1").replace(/([(])\s+/g, "$1").replace(/[,;]\s*([:.])/g, "$1").replace(/\s{2,}/g, " ").replace(/[\s,;:-]+$/, "").trim();
  if (!t) return title.trim();
  return t[0].toUpperCase() + t.slice(1);
}
