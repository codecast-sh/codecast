// Opening the Files surface FROM somewhere else: a file link in a
// conversation, a tool card, a diff, the palette, the repo blob page, the
// header's Files action. One rule for where it goes: beside what's on stage as
// a split pane when the stage can hold one (lib/stage.openBeside), otherwise
// the tab navigates. Cmd-click and "open in new tab" never come here; the Link
// compat handles those.
//
// `openInEditor` is the one door into the code editor. It builds the address
// (editorHref, over vaultHref's filesHref), reuses the Files pane already on
// stage rather than stacking another, records on the stage tab which
// conversation the editor was opened from (AppTab.editorOpenedFrom, read by the
// editor's agent link), and runs the follow-ups the address cannot carry: a new
// editor split, a diff against a git ref.
//
// `openConversationPath` is the door for a path a conversation names (a link,
// a tool card): when this machine cannot reach that conversation's files
// (`editorReachable`), it opens the session's own changes instead.

import { canOpenBeside, openBeside } from "./stage";
import { tabNavigate } from "../src/compat/tabRouting";
import { useInboxStore, type AppTab } from "../store/inboxStore";
import { findLeaf, leavesOf } from "../store/stageSplit";
import { sessionGitRefs, sessionOfPanePath, type SessionChangeRef } from "./code/agent/sessions";
import { isFilesPath } from "./vault/vaultHref";
import { filePathHref, resolveMentionPath, type FilePathContextValue } from "./filePathLinks";
import { runCodeCommand, type CodeCommandId } from "./code/commands";
import { CODE_GIT_MERGE_BASE_REF } from "@codecast/shared/contracts";
import { useVaultStore } from "../store/vaultStore";
import { openSessionChangedPath } from "./sessionChangedFiles";
import { toast } from "sonner";

/** Show a /files address: in the Files pane already on stage (its workspace
 *  opens the file as a tab there), else as a pane beside, else in the tab. */
export function openFiles(href: string): void {
  placeFiles(href);
}

// ── the editor ──────────────────────────────────────────────────────────────

/** A place in a local file. */
export interface EditorTarget {
  /** As written: absolute, `~/…`, or relative to `ctx.base`. */
  path: string;
  /** 1-based. */
  line?: number;
  column?: number;
  /** The last line of a range the editor flashes on arrival. */
  endLine?: number;
  /** Text the file holds, tried in order (findTextRange). With no `line` the
   *  editor lands on the first found and flashes it (a MultiEdit's result
   *  names no lines); beside a `line` it is the check that the lines are
   *  still there, and the editor moves to the match nearest `line` when the
   *  file has changed under them since. */
  find?: string[];
  /** The conversation the path was written in, which resolves a relative one. */
  ctx?: FilePathContextValue | null;
}

export interface OpenInEditorOptions {
  /** The stage leaf the gesture came from (useTabContext().leafId). Its
   *  conversation becomes the editor's linked session. */
  fromLeaf?: string | null;
  /** Open in a new editor split group inside the Files pane already open. */
  split?: boolean;
  /** Once the file shows, open its diff against this git ref. */
  diffAgainst?: { ref: string; label?: string };
  /** Once the file shows, peek the change at the landed line: its old lines
   *  open inline (a tool card's edit, what it replaced on screen). */
  peek?: boolean;
}

/** The absolute path a target names (as written when nothing resolves it). */
export function editorTargetPath(t: EditorTarget): string {
  return resolveMentionPath(t.path, t.ctx) ?? t.path;
}

/** The Files address that opens a target in the editor: the same address a
 *  path link carries (on the conversation's machine), plus the range. */
export function editorHref(t: EditorTarget): string {
  return filePathHref(t.path, t.line, t.ctx, t.column, t.endLine);
}

/** Open a local file in the code editor, beside the stage when it can be. */
export function openInEditor(target: EditorTarget, opts: OpenInEditorOptions = {}): void {
  const href = editorHref(target);
  const abs = editorTargetPath(target);
  // Recorded on the stage tab before the pane moves: the agent link reads it
  // from the store, so it wakes on this write even when placing the pane
  // changes nothing else, and it lives and dies with the tab.
  const tab = activeTab();
  const session = sessionOfLeaf(opts.fromLeaf);
  if (tab && session) useInboxStore.getState().updateTab(tab.id, { editorOpenedFrom: session });
  const placed = opts.split ? placeFiles(href, { keepFile: true }) : placeFiles(href);
  if (opts.split && placed.reused) {
    // The pane is there with a workspace in it: the split is a command. When
    // nothing takes it (the file is in another vault), the address opens it.
    const args = { path: abs, line: target.line, column: target.column, split: "right" };
    void retryCommand("file.open", () => args).then((ok) => ok || tabNavigate(href, "push"));
  }
  if ((target.find?.length || opts.peek) && abs.startsWith("/")) {
    const find = target.find ?? [];
    void whenEditorShows(abs).then(async (view) => {
      if (!view) return;
      let line = target.line;
      const doc = (view as { state?: { doc: { toString(): string } } }).state?.doc;
      const at = doc && find.length ? findTextRange(doc.toString(), find, target.line) : undefined;
      // Lines read off a tool result go stale as the file changes; the text
      // the edit wrote finds where it is now. A match that holds the given
      // line agrees with the address, which already landed there.
      if (at && !(line && at.line <= line && line <= (at.endLine ?? at.line))) {
        const { revealTarget } = await import("./code/editorHost");
        // Flashed even on one line: there is no range in the address to show it.
        revealTarget(view as never, { line: at.line, endLine: at.endLine ?? at.line });
        line = at.line;
      }
      if (opts.peek && line) await retryCommand("git.peekHunk", () => ({ line }), view);
    });
  }
  if (opts.diffAgainst) {
    const { ref, label } = opts.diffAgainst;
    const failed = () => toast.error(`Couldn't open the diff against ${label ?? ref}`);
    // Only an absolute path can be matched to the buffer the editor shows.
    if (!abs.startsWith("/")) failed();
    else void whenEditorShows(abs).then(async (view) => (view && (await retryCommand("git.diffAgainst", () => ({ ref, label }), view))) || failed());
  }
}

/** This machine can open a conversation's files in its editor: the
 *  conversation is the viewer's own, and a daemon serves the vault. */
export function editorReachable(ctx: FilePathContextValue | null | undefined, connection = useVaultStore.getState()?.connection): boolean {
  return !ctx?.foreign && connection !== "no-daemon";
}

/** Open a path a conversation names. When the editor cannot reach the
 *  conversation's files, a file the session changed opens in its own
 *  changes; anything else goes to the editor, which says what is missing. */
export function openConversationPath(target: EditorTarget, opts: OpenInEditorOptions = {}): void {
  if (!editorReachable(target.ctx) && openSessionChangedPath(target.path, target.ctx)) return;
  openInEditor(target, opts);
}

/**
 * Put `href` in front: in the Files pane already on stage (re-pointed, so the
 * workspace opens the file as a tab there), else a new pane beside, else the
 * tab itself. `keepFile` focuses an existing pane without moving its file.
 */
function placeFiles(href: string, opts: { keepFile?: boolean } = {}): { reused: boolean } {
  const tab = activeTab();
  if (!tab || !canOpenBeside()) {
    tabNavigate(href, "push");
    return { reused: false };
  }
  // The whole tab is Files already: it is the pane.
  if (!tab.layout && isFilesPath(tab.path)) {
    if (!opts.keepFile) tabNavigate(href, "push");
    return { reused: true };
  }
  const existing = leavesOf(tab.layout).find((l) => isFilesPath(l.path));
  if (existing) {
    useInboxStore.getState().stageFocusLeaf(existing.id);
    // The focused pane's navigation is the tab's (history, recents, URL).
    tabNavigate(opts.keepFile ? existing.path : href, opts.keepFile ? "replace" : "push");
    return { reused: true };
  }
  if (!openBeside(href)) tabNavigate(href, "push");
  return { reused: false };
}

function activeTab(): AppTab | null {
  const st = useInboxStore.getState();
  return st.tabs.find((t) => t.id === st.activeTabId) ?? null;
}

// ── the linked session ──────────────────────────────────────────────────────

/** The conversation a stage leaf shows: the named leaf, else the tab itself.
 *  Read the way the agent link reads panes (sessionOfPanePath), so the
 *  opener it records is one that link can find on the stage. */
function sessionOfLeaf(leafId: string | null | undefined): string | null {
  const st = useInboxStore.getState();
  const tab = activeTab();
  if (!tab) return null;
  const leaf = leafId && tab.layout ? findLeaf(tab.layout, leafId) : null;
  return sessionOfPanePath(leaf?.path ?? tab.path, st.currentSessionId ?? null);
}

// ── follow-ups once the workspace is up ─────────────────────────────────────

const RETRY_MS = 80;
const RETRY_FOR_MS = 4000;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run a code command until a mounted handler takes it: the pane that will
 *  take it may still be focusing or loading its chunk. */
async function retryCommand(id: CodeCommandId, args: () => Record<string, unknown>, view?: unknown): Promise<boolean> {
  const until = Date.now() + RETRY_FOR_MS;
  while (Date.now() < until) {
    const ctx = view ? { view: view as never, source: "api" as const } : { source: "api" as const };
    if (runCodeCommand(id, args(), ctx)) return true;
    await wait(RETRY_MS);
  }
  return false;
}

/** The editor view showing `abs`, once one does (the editor chunk loads on
 *  first open, so this imports it lazily rather than pulling it in here). */
async function whenEditorShows(abs: string): Promise<object | null> {
  const [{ codeBuffers }, { useVaultStore }] = await Promise.all([import("./code/buffers"), import("../store/vaultStore")]);
  const until = Date.now() + RETRY_FOR_MS * 2;
  while (Date.now() < until) {
    const roots = new Map(useVaultStore.getState().vaults.map((v) => [v.id, v.root?.replace(/\/+$/, "")]));
    const shown = codeBuffers.all().find((b) => b.view?.dom.isConnected && `${roots.get(b.vaultId)}/${b.path}` === abs);
    if (shown?.view) return shown.view;
    await wait(RETRY_MS);
  }
  return null;
}

// ── ranges ──────────────────────────────────────────────────────────────────

/** The first line a unified patch adds or changes, in the new file. */
export function firstChangedLine(patch: string | undefined): number | undefined {
  if (!patch) return undefined;
  let next = 0;
  for (const row of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      next = parseInt(hunk[1], 10);
      continue;
    }
    if (!next) continue;
    if (row.startsWith("+") || row.startsWith("-")) return Math.max(1, next);
    if (!row.startsWith("\\")) next++;
  }
  return undefined;
}

/** Where `candidates` (in order) sit in `text`, as whole lines: the first
 *  that occurs exactly once, else the first found (a short new text like
 *  `return null;` can also match lines the edit never wrote), at its
 *  occurrence nearest `near` (1-based) when given. Blank candidates are
 *  skipped; a candidate's surrounding blank lines don't count toward its
 *  range. */
export function findTextRange(text: string, candidates: readonly string[], near?: number): { line: number; endLine?: number } | undefined {
  const lineOf = (at: number) => text.slice(0, at).split("\n").length;
  let fallback: { at: number; want: string } | undefined;
  let pick: { at: number; want: string } | undefined;
  for (const raw of candidates) {
    const want = raw.replace(/^\s*\n/, "").replace(/\n\s*$/, "");
    if (!want.trim()) continue;
    const at = text.indexOf(want);
    if (at < 0) continue;
    if (text.indexOf(want, at + 1) < 0) {
      pick = { at, want };
      break;
    }
    if (fallback) continue;
    fallback = { at, want };
    if (near === undefined) continue;
    for (let i = text.indexOf(want, at + 1); i >= 0; i = text.indexOf(want, i + 1)) {
      if (Math.abs(lineOf(i) - near) < Math.abs(lineOf(fallback.at) - near)) fallback = { at: i, want };
    }
  }
  const hit = pick ?? fallback;
  if (!hit) return undefined;
  const line = lineOf(hit.at);
  const endLine = line + hit.want.split("\n").length - 1;
  return endLine > line ? { line, endLine } : { line };
}

/**
 * The lines an Edit wrote, read off the tool's result snippet (`cat -n`
 * style, `  42→text` or `  42\ttext`): where the replacement's lines appear in
 * the snippet, in order. Short heads (`}`, `return null;`) repeat in a snippet,
 * so the whole block is matched, and of several matches the one nearest the
 * snippet's middle wins (the snippet is centred on the edit). Falls back to the
 * snippet's first line when the block is not found.
 */
export function editedLineRange(resultSnippet: string | undefined, newText: string | undefined): { line: number; endLine?: number } | undefined {
  if (!resultSnippet) return undefined;
  const rows: { n: number; text: string }[] = [];
  for (const row of resultSnippet.split("\n")) {
    const m = /^\s*(\d+)(?:→|\t)(.*)$/.exec(row);
    if (m) rows.push({ n: parseInt(m[1], 10), text: m[2] });
  }
  if (!rows.length) return undefined;
  const lines = (newText ?? "").split("\n").map((l) => l.trim());
  const first = lines.findIndex(Boolean);
  if (first < 0) return { line: rows[0].n };
  // The block's non-blank lines, with their offsets from its first line.
  const want = lines.map((text, i) => ({ text, i })).filter((l) => l.text);
  const middle = (rows[0].n + rows[rows.length - 1].n) / 2;
  let best: number | null = null;
  for (let at = 0; at < rows.length; at++) {
    if (rows[at].text.trim() !== want[0].text) continue;
    const start = rows[at].n - want[0].i;
    const byLine = (n: number) => rows.find((r) => r.n === n);
    // Every non-blank line the snippet shows must match; lines past its end
    // (a long replacement) cannot be checked and do not count against it.
    const fits = want.every((w) => {
      const r = byLine(start + w.i);
      return !r ? start + w.i > rows[rows.length - 1].n : r.text.trim() === w.text;
    });
    if (fits && (best === null || Math.abs(start - middle) < Math.abs(best - middle))) best = start;
  }
  if (best === null) return { line: rows[0].n };
  const endLine = best + lines.length - 1;
  return endLine > best ? { line: best, endLine } : { line: best };
}

/**
 * The git ref a conversation diff's base stands for in the editor's diff view,
 * read off the session's own commits (sessionGitRefs): Session is the parent
 * of its first commit (HEAD while it has committed nothing), Commit its last
 * commit, Branch the merge base. A commit with no recorded hash falls back to
 * the merge base or HEAD. A turn, a review mark or a picked range has no ref:
 * null.
 */
export function gitRefForDiffBase(base: string, changes: readonly SessionChangeRef[]): { ref: string; label: string } | null {
  const refs = sessionGitRefs(changes);
  if (base === "session") {
    if (!refs.committed) return { ref: "HEAD", label: "HEAD" };
    return refs.base ? { ref: refs.base, label: "Session base" } : { ref: CODE_GIT_MERGE_BASE_REF, label: "Merge base" };
  }
  if (base === "commit") return refs.last ? { ref: refs.last, label: "Last commit" } : { ref: "HEAD", label: "HEAD" };
  if (base === "branch") return { ref: CODE_GIT_MERGE_BASE_REF, label: "Merge base" };
  return null;
}

type LocalCheckouts = ReadonlyArray<{
  root: string;
  device_id?: string;
  mine?: boolean;
  worktrees: ReadonlyArray<{ path: string; branch?: string; main?: boolean; head_sha?: string }>;
}>;

/**
 * This machine's checkout of a repository, given the checkouts the viewer's
 * machines publish for it: the worktree on `refName` when one is (`onRef`),
 * else the main checkout. `head` is that tree's commit when published. Null
 * when this machine has none.
 */
export function localCheckout(checkouts: LocalCheckouts, deviceId: string | null, refName: string): { root: string; onRef: boolean; head?: string } | null {
  if (!deviceId) return null;
  const here = checkouts.filter((c) => c.mine !== false && c.device_id === deviceId);
  if (!here.length) return null;
  const trees = here.flatMap((c) => c.worktrees);
  const onRef = refName ? trees.find((w) => w.branch === refName) : undefined;
  const tree = onRef ?? trees.find((w) => w.main);
  return { root: (tree?.path ?? here[0].root).replace(/\/+$/, ""), onRef: !!onRef, head: tree?.head_sha };
}

/** Where `path` (repo-relative) is in this machine's checkout (localCheckout). */
export function localCheckoutFile(checkouts: LocalCheckouts, deviceId: string | null, refName: string, path: string): string | null {
  const at = localCheckout(checkouts, deviceId, refName);
  return at ? `${at.root}/${path.replace(/^\/+/, "")}` : null;
}
