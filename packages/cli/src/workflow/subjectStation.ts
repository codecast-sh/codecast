// The session a change came from is the run's subject (docs/architecture/flows.md
// FL4). A stage that finds work for the change (a failing check, a reviewer's
// finding, a Revise note, a rebase conflict) sends it back to that session as a
// message in its own thread, the session fixes it there, and the run freezes
// the session's change again before the stages run once more. The session also
// hears the gate's answer and how the run ended. Everything here is what the
// runner says to the session and how it reads its change back; the waiting is
// the runner's own station wait (waitOnStation).
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowGraph } from "./types";
import { readFrozenChange, type FrozenChange } from "./flowChangeFile.js";
import { PERSONAL_FLOW_SLUG } from "@codecast/shared/contracts/flowPool";
import { ownRestartOf } from "@codecast/shared/contracts/runRestart";

export type Subject = { conversationId: string; shortId: string };

/** The session a run's change came from, when the run was started from one. */
export function subjectOf(context: Record<string, string>): Subject | null {
  const conversationId = context["change_conversation"];
  if (!conversationId) return null;
  return { conversationId, shortId: context["change_session"] || conversationId.slice(0, 7) };
}

/**
 * The run's change when it is a whole checkout's (flows.md FL4): a finding goes to the writers of the files it names,
 * and nothing parks or retires anyone, since the writers are other people's sessions in a shared checkout.
 */
export function checkoutChangeOf(runDir: string | undefined): FrozenChange | null {
  const change = readFrozenChange(runDir);
  return change?.source === "checkout" ? change : null;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const SIGNAL_WORDS = String.raw`\b(error|errors|fail|failed|failing|failure|✗|×|expected|received|panic|exception|traceback|cannot|could not|not found|TS\d{4})\b`;
const SIGNAL = new RegExp(SIGNAL_WORDS, "i");

/**
 * A session that wrote files of a checkout's change, with the ones a finding names (flows.md FL4). The run's subject
 * also carries the named files no session wrote (`unclaimed`), which are its to fix or hand on.
 */
export type Writer = Subject & { files: string[]; unclaimed?: string[] };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A line that says something broke: SIGNAL, or a merge conflict. A test runner's pass, skip or todo line never does,
// whatever its test's name says.
const FAILING = new RegExp(`${SIGNAL_WORDS}|\\bCONFLICT\\b`, "i");
const QUIET_RESULT = /^\s*\((?:pass|skip|todo)\)/;
// bun prints each test file's path alone on a line, then its results.
const TEST_HEADER = /^\s*\S+\.(?:test|spec)\.[cm]?[jt]sx?:\s*$/;
// bun's closing recap of the failed tests, after the last file's results.
const RECAP = /^\s*\d+ tests? failed:?\s*$/;
// eslint and other linters print each file's path alone on a line, then its problems.
const PATH_LINE = /^\s*(?:[A-Za-z]:)?[\w.@\-/\\]*[/\\][\w.@\-]+\.[A-Za-z]\w*\s*$/;
// How far a line may sit from a failing one and still belong to it: a stack trace or code frame under its error.
const NEAR = 6;

/**
 * The lines of a finding that can name a file, each with whether it says something failed or sits near a line that
 * does. A file's section (a test file's header, a linter's path line, bun's closing recap) bounds that nearness, so
 * one file's error never reaches the next file's name. git's `Auto-merging` lines go (every file a merge touches,
 * conflict or not), and so do a passed test's line and a test file's header when nothing in its section failed. Paths under any of `roots`
 * (the checkout, the run's worktree) read relative, as the change names them.
 */
function findingLines(text: string, roots: string[]): Array<{ line: string; failing: boolean }> {
  let clean = text.replace(ANSI, "").replace(/\r/g, "");
  for (const r of [...new Set(roots.filter(Boolean))].sort((a, b) => b.length - a.length)) clean = clean.split(`${r.replace(/\/+$/, "")}/`).join("");
  const lines = clean.split("\n");
  const failing = (l: string) => FAILING.test(l) && !QUIET_RESULT.test(l);
  const section: number[] = [];
  lines.forEach((l, i) => { section[i] = (section[i - 1] ?? 0) + (TEST_HEADER.test(l) || RECAP.test(l) || PATH_LINE.test(l) ? 1 : 0); });
  const passedHeader = (i: number) => TEST_HEADER.test(lines[i]) && !lines.some((l, j) => j > i && section[j] === section[i] && failing(l));
  // A passed, skipped or todo test's name may hold a file's name; it names nothing that failed.
  const kept = lines.map((line, i) => ({ line, i })).filter(({ line, i }) => !/^\s*Auto-merging\s/.test(line) && !QUIET_RESULT.test(line) && !passedHeader(i));
  const failingAt = kept.filter(({ line }) => failing(line)).map(({ i }) => i);
  return kept.map(({ line, i }) => ({ line, failing: failingAt.some((f) => Math.abs(f - i) <= NEAR && section[f] === section[i]) }));
}

/**
 * The files of a checkout change a finding names, split by whether a session's edit wrote them: `writers` groups
 * them by that session, `unclaimed` are the ones no session wrote. A file is named by its path; by a tail of it that
 * starts at a `/` and no other file of the change ends with (a tool run inside a package prints paths from there:
 * `src/a.ts(12,5)` for `packages/cli/src/a.ts`); or by a basename no other file of the change shares, standing alone
 * or as a location (`a.ts:12`, `a.ts(12,5)`). None of these is named inside a longer path (`src/a.ts` within
 * `lib/src/a.ts`, `index.ts` within `node_modules/x/index.ts`). Lines that say something failed, and those beside
 * them in the same file's section, are read first; only a finding with no file named there is read whole.
 */
export function writersNamed(
  change: { paths: string[]; writers?: Record<string, { conversation: string; session: string }> },
  text: string,
  roots: string[] = [],
): { writers: Writer[]; unclaimed: string[] } {
  const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const sharing = new Map<string, number>();
  for (const p of change.paths) sharing.set(base(p), (sharing.get(base(p)) ?? 0) + 1);
  // The tails of a path from each `/` on (two segments or more), kept when no other file of the change ends with one.
  const tails = (p: string) => {
    const parts = p.split("/");
    return parts.slice(1, -1).map((_, k) => parts.slice(k + 1).join("/"))
      .filter((t) => change.paths.filter((q) => q === t || q.endsWith(`/${t}`)).length === 1);
  };
  // Bounded on both sides, so a.ts is not named by data.ts or a.tsx, nor src/a.ts by lib/src/a.ts.
  const byPath = (p: string) => new RegExp(`(?:^|[^\\w.\\-/\\\\@])${escapeRe(p)}(?![\\w\\-/\\\\]|\\.\\w)`);
  const byBase = (name: string) => new RegExp(`(?:^|[^\\w.\\-/\\\\@])${escapeRe(name)}(?=:\\d|\\(\\d+,|[\\s,;'"\`)\\]]|[.:](?:\\s|$)|$)`);
  const tests = new Map(change.paths.map((p) => [p, [byPath(p), ...tails(p).map(byPath), ...(sharing.get(base(p)) === 1 && base(p) !== p ? [byBase(base(p))] : [])]]));
  const lines = findingLines(text, roots);
  const namedIn = (subset: string[]) => change.paths.filter((p) => subset.some((l) => tests.get(p)!.some((t) => t.test(l))));
  const strong = namedIn(lines.filter((l) => l.failing).map((l) => l.line));
  const named = strong.length ? strong : namedIn(lines.map((l) => l.line));
  const byWriter = new Map<string, Writer>();
  const unclaimed: string[] = [];
  for (const p of named) {
    const w = change.writers?.[p];
    if (!w) { unclaimed.push(p); continue; }
    const entry = byWriter.get(w.conversation) ?? { conversationId: w.conversation, shortId: w.session, files: [] };
    entry.files.push(p);
    byWriter.set(w.conversation, entry);
  }
  return { writers: [...byWriter.values()], unclaimed };
}

/** A writer's brief: the station's, which of the failing files are its own, and which no session's edit names. */
export function writerBrief(brief: string, writer: Writer): string {
  const own = writer.files.length ? `\n\nYour files among the failing ones: ${writer.files.join(", ")}.` : "";
  const nobody = writer.unclaimed?.length
    ? `\n\nNo session's edit names these failing files, and you ran this pass, so they are yours to fix or hand to whoever wrote them: ${writer.unclaimed.join(", ")}.`
    : "";
  return `${brief}${own}${nobody}`;
}

/**
 * What a session needs from a long failure: the lines that say what broke, with
 * a line of context each, and the end of the output, where tools sum up. Short
 * output passes whole.
 */
export function failureExcerpt(text: string, maxLines = 60, maxChars = 6000): string {
  const lines = text.replace(ANSI, "").replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
  if (lines.length <= maxLines && lines.join("\n").length <= maxChars) return lines.join("\n");
  const tail = Math.min(20, Math.floor(maxLines / 3));
  const keep = new Set<number>();
  for (let i = lines.length - tail; i < lines.length; i++) if (i >= 0) keep.add(i);
  for (let i = 0; i < lines.length - tail && keep.size < maxLines; i++) {
    if (!SIGNAL.test(lines[i])) continue;
    for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lines.length && keep.size < maxLines) keep.add(j);
  }
  const out: string[] = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > last + 1) out.push(`... (${i - last - 1} lines)`);
    out.push(lines[i]);
    last = i;
  }
  const joined = out.join("\n");
  return joined.length <= maxChars ? joined : `...\n${joined.slice(joined.length - maxChars)}`;
}

/** Where the run's worktree is on disk, read the way `cast ws path` reads it; null when it is gone. */
export async function runWorktreePath(cwd: string, name: string | undefined): Promise<string | null> {
  if (!name) return null;
  const { readState } = await import("../workspace/contract.js");
  const { git } = await import("../wipSnapshot.js");
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => cwd)).trim();
  const at = readState(root, name)?.path ?? path.join(root, ".codecast", "worktrees", name);
  return fs.existsSync(at) ? at : null;
}

/** The directories a finding's absolute paths can start with: the checkout and the run's worktree, as given and resolved. */
export async function findingRoots(cwd: string, worktree: string | undefined): Promise<string[]> {
  const at = await runWorktreePath(cwd, worktree);
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
  return [...new Set([cwd, at].filter((p): p is string => !!p).flatMap((p) => [p, real(p)]))];
}

/** How a run ended, said to the session it came from. */
export function runEndMessage(graph: WorkflowGraph, opts: { taskId?: string; endLabel: string; failed: boolean; failReason?: string; lastOutput?: string; landed?: boolean; whole?: boolean }): string {
  const flow = graph.label || graph.name;
  const on = opts.taskId ? ` on ${opts.taskId}` : "";
  if (!opts.failed) {
    const said = (opts.lastOutput ?? "").replace(ANSI, "").split("\n").map((l) => l.trim()).filter(Boolean).pop();
    // Words that open with the end's own name ("Live: e180ae0 on …") say it once.
    const words = !said || said.startsWith("{") ? `${opts.endLabel}.` : said.startsWith(`${opts.endLabel}:`) ? (/[.!?]$/.test(said) ? said : `${said}.`) : `${opts.endLabel}. ${said}`;
    return `The ${flow} run${on} is over: ${words} Nothing more is waiting on this session for it.`;
  }
  const why = (opts.failReason ?? "it failed").replace(/^Stopped:\s*/, "").replace(/\.$/, "");
  // A stop that says all of it (whole_stop, or the runner's own words naming its restart) stands as it is.
  if (opts.whole || ownRestartOf(opts.failReason)) return `The ${flow} run${on} stopped at ${opts.endLabel}: ${why}.`;
  // A stop after Land leaves the change on the default branch: only what comes after it did not happen.
  // The personal Ship lands with no merge, and runs as `change` in the workspace it ships (flowPool.ts workspacePool).
  const personal = graph.name === PERSONAL_FLOW_SLUG;
  const after = opts.landed ? "The change is on the default branch; nothing after this stage ran."
    : `The change was not ${personal ? "landed" : "merged"}. Run it again with \`cast flow run ${personal ? "change" : graph.name}\` once it is ready.`;
  return `The ${flow} run${on} stopped at ${opts.endLabel}: ${why}. ${after}`;
}

/** Why a run stops when a stage has sent the change back to its session as often as the flow allows. */
export function sentBackWords(stage: string, times: number): string {
  return `${stage} sent the change back ${times} times, the most one run allows, and the last round still found something to fix.`;
}

/** A gate's answer, said to the session whose change it was about. A note that only repeats the choice says nothing. */
export function gateAnswerMessage(gateLabel: string, choice: string, note: string | undefined): string {
  const words = choice.replace(/^\[.\]\s*/, "").replace(/\s*::.*$/, "").trim();
  const said = (note ?? "").trim();
  const plain = (s: string) => s.replace(/[.!\s]+$/, "").toLowerCase();
  const own = said && plain(said) !== plain(words) ? ` Their note: ${/[.!?]$/.test(said) ? said : `${said}.`}` : "";
  return `${gateLabel}: ${words}.${own} The run goes on; this session will hear how it ends.`;
}
