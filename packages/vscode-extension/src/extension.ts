import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { existsSync, appendFileSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Codecast session blame for VS Code / Cursor. A thin client over the `cast`
// CLI: it shells out to `cast blame …` (which holds the auth token and does the
// SHA→session resolution server-side) and surfaces the result as current-line
// decorations + commands. No attribution logic lives here — the CLI is the one
// source of truth, shared with the vim-fugitive integration.

interface LineInfo {
  session: string;
  conversation: string;
  title: string;
  author?: string;
  url: string;
  message?: string;
}

const blameCache = new Map<string, Map<number, LineInfo>>(); // fsPath → (1-based line → info)
const inFlight = new Set<string>();
let decoration: vscode.TextEditorDecorationType;
let statusItem: vscode.StatusBarItem;
let resolvedCli: string | undefined;
let warnedMissing = false;
let out: vscode.OutputChannel;
const LOG_FILE = path.join(os.homedir(), ".codecast", "vscode-ext.log");

function log(msg: string): void {
  out?.appendLine(msg);
  // Mirror to a file so failures are diagnosable without copying the panel.
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* best effort */
  }
}

function inlineEnabled(): boolean {
  return vscode.workspace.getConfiguration("codecast").get<boolean>("inlineBlame") !== false;
}

// GUI-launched editors don't inherit the shell PATH, so a bare `cast` (installed
// to ~/.local/bin) isn't found. Resolve a real path: an explicit setting wins,
// then common install dirs, then a login shell (whatever the user's rc sets up).
// Cached for the session.
function resolveCliSync(): string | undefined {
  const configured = vscode.workspace.getConfiguration("codecast").get<string>("cliPath")?.trim();
  if (configured && configured !== "cast") return existsSync(configured) ? configured : configured;
  if (resolvedCli) return resolvedCli;
  const candidates = [
    path.join(os.homedir(), ".local/bin/cast"),
    "/opt/homebrew/bin/cast",
    "/usr/local/bin/cast",
    "/usr/bin/cast",
  ];
  for (const c of candidates) if (existsSync(c)) return (resolvedCli = c);
  return undefined; // fall back to a login-shell lookup in runCast
}

// The user's real login PATH, learned once via their shell. A GUI-launched
// editor starts with a stripped PATH, which breaks `cast` AND any runtime it
// shells out to (e.g. the dev `cast` is a bun wrapper; bun lives in ~/.bun/bin).
let userPath: string | undefined;
async function learnUserPath(): Promise<void> {
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const out = await new Promise<string>((resolve, reject) =>
      execFile(shell, ["-lic", "printf '__CC__%s__END__' \"$PATH\""], { timeout: 6000 }, (e, so) =>
        e ? reject(e) : resolve(so),
      ),
    );
    const m = out.match(/__CC__(.*?)__END__/s);
    if (m && m[1]) userPath = m[1];
  } catch {
    /* keep undefined → fall back to the static floor below */
  }
}

// Build a PATH: the learned login PATH (if any) plus a static floor of the
// usual user bin dirs the GUI session drops — including runtime dirs so a
// wrapper-style `cast` can find its interpreter.
function augmentedEnv(): NodeJS.ProcessEnv {
  const home = os.homedir();
  const floor = [
    path.join(home, ".local/bin"),
    path.join(home, ".bun/bin"),
    path.join(home, ".deno/bin"),
    path.join(home, ".volta/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const PATH = [...floor, userPath || process.env.PATH || ""].filter(Boolean).join(":");
  return { ...process.env, PATH };
}

function runCast(args: string[], cwd: string): Promise<string> {
  const bin = resolveCliSync();
  const env = augmentedEnv();
  const tag = (err: any, stderr?: string) => {
    // Distinguish "cast can't be run at all" from "it ran but found nothing".
    err.castMissing =
      err?.code === "ENOENT" || err?.code === 127 || /command not found|not found/i.test(stderr || "");
    return err;
  };
  return new Promise((resolve, reject) => {
    if (bin) {
      log(`run: ${bin} ${args.join(" ")}  (cwd=${cwd})`);
      execFile(bin, args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        // ENOEXEC = the launcher has a broken/missing shebang (e.g. a dev
        // `cast` wrapper). A shell runs it regardless of shebang, so retry the
        // binary through bash — direct `bash <file> <args>`, no rc, no noise.
        if ((err as any).code === "ENOEXEC") {
          log(`  ↻ ENOEXEC — retrying via bash ${bin}`);
          execFile("/bin/bash", [bin, ...args], { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (e2, so2, se2) => {
            if (e2) {
              log(`  ✗ exit=${(e2 as any).code} ${se2 ? "stderr=" + se2.slice(0, 300) : e2.message}`);
              reject(tag(e2, se2));
            } else {
              resolve(so2);
            }
          });
          return;
        }
        log(`  ✗ exit=${(err as any).code} ${stderr ? "stderr=" + stderr.slice(0, 300) : err.message}`);
        reject(tag(err, stderr));
      });
      return;
    }
    // Last resort: run through a login shell so the user's rc PATH applies.
    const shell = process.env.SHELL || "/bin/bash";
    const quoted = ["cast", ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    log(`run (login shell ${shell}): cast ${args.join(" ")}`);
    execFile(shell, ["-lic", quoted], { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        log(`  ✗ exit=${(err as any).code} ${stderr ? "stderr=" + stderr.slice(0, 300) : err.message}`);
        reject(tag(err, stderr));
      } else {
        resolve(stdout);
      }
    });
  });
}

// Parse `cast blame --line-porcelain`: every line block carries full headers,
// and resolved lines get extra `codecast-*` keys injected after `summary`.
function parseLinePorcelain(out: string): Map<number, LineInfo> {
  const map = new Map<number, LineInfo>();
  let finalLine = 0;
  let cur: Partial<LineInfo> = {};
  for (const raw of out.split("\n")) {
    const header = raw.match(/^([0-9a-f]{40}) \d+ (\d+)/);
    if (header) {
      finalLine = parseInt(header[2], 10);
      cur = {};
      continue;
    }
    if (raw.startsWith("\t")) {
      if (cur.conversation) map.set(finalLine, cur as LineInfo);
      continue;
    }
    const kv = raw.match(/^codecast-(\w+) (.*)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    if (key === "session") cur.session = val;
    else if (key === "conversation") cur.conversation = val;
    else if (key === "title") cur.title = val;
    else if (key === "author") cur.author = val;
    else if (key === "url") cur.url = val;
    else if (key === "message") cur.message = val;
  }
  return map;
}

// One actionable nudge if `cast` can't be run at all — far better than the
// silent "no session resolved" that a missing CLI otherwise produces.
function warnCastMissing(): void {
  if (warnedMissing) return;
  warnedMissing = true;
  vscode.window
    .showWarningMessage(
      "Codecast: couldn't run the `cast` CLI. Install it from codecast.sh, or set codecast.cliPath to the output of `which cast`.",
      "Open Settings",
    )
    .then((choice) => {
      if (choice) vscode.commands.executeCommand("workbench.action.openSettings", "codecast.cliPath");
    });
}

async function loadBlame(doc: vscode.TextDocument): Promise<void> {
  if (doc.uri.scheme !== "file" || doc.isDirty) {
    log(`skip loadBlame: scheme=${doc.uri.scheme} dirty=${doc.isDirty}`);
    return;
  }
  const fsPath = doc.uri.fsPath;
  if (inFlight.has(fsPath)) return;
  inFlight.add(fsPath);
  try {
    const out = await runCast(["blame", "--line-porcelain", "--", fsPath], path.dirname(fsPath));
    const map = parseLinePorcelain(out);
    blameCache.set(fsPath, map);
    log(`loadBlame ok: ${path.basename(fsPath)} → ${map.size} resolved lines`);
  } catch (err: any) {
    blameCache.set(fsPath, new Map()); // not a repo / not tracked / cast missing
    log(`loadBlame failed: ${path.basename(fsPath)} → ${err?.message || err}`);
    if (err?.castMissing) warnCastMissing();
  } finally {
    inFlight.delete(fsPath);
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.uri.fsPath === fsPath) renderCurrentLine(ed);
  }
}

function infoForCursor(editor: vscode.TextEditor): LineInfo | undefined {
  const map = blameCache.get(editor.document.uri.fsPath);
  if (!map) return undefined;
  return map.get(editor.selection.active.line + 1); // blame is 1-based
}

function renderCurrentLine(editor: vscode.TextEditor): void {
  if (!inlineEnabled() || editor.document.isDirty) {
    editor.setDecorations(decoration, []);
    statusItem.hide();
    return;
  }
  const info = infoForCursor(editor);
  if (!info) {
    editor.setDecorations(decoration, []);
    statusItem.hide();
    return;
  }
  const who = info.author ? `${info.author} · ` : "";
  const label = `${who}${info.title}  ·  ${info.session}`;
  const line = editor.selection.active.line;
  const range = editor.document.lineAt(line).range;
  editor.setDecorations(decoration, [
    {
      range,
      renderOptions: {
        after: {
          contentText: `  ↳ ${label}`,
          color: new vscode.ThemeColor("editorCodeLens.foreground"),
          fontStyle: "italic",
        },
      },
    },
  ]);
  statusItem.text = `$(comment-discussion) ${info.session}`;
  statusItem.tooltip = `${info.title}${info.author ? " — " + info.author : ""}\nClick to open the conversation`;
  statusItem.command = "codecast.openSession";
  statusItem.show();
}

async function openSession(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  // Prefer the cached resolution (instant); fall back to a fresh single-line
  // resolve through the CLI when the cache is cold or stale after edits.
  const cached = infoForCursor(editor);
  if (cached?.url) {
    const url = cached.message ? `${cached.url}#msg-${cached.message}` : cached.url;
    vscode.env.openExternal(vscode.Uri.parse(url));
    return;
  }
  const fsPath = editor.document.uri.fsPath;
  const lnum = editor.selection.active.line + 1;
  try {
    const out = await runCast(["blame", `${fsPath}:${lnum}`, "--open"], path.dirname(fsPath));
    const url = out.trim().split("\n")[0];
    if (url.startsWith("http")) vscode.window.setStatusBarMessage(`Codecast: opened ${url}`, 4000);
    else vscode.window.showInformationMessage("Codecast: no session resolved for this line.");
  } catch (err: any) {
    if (err?.castMissing) warnCastMissing();
    else vscode.window.showInformationMessage("Codecast: no session resolved for this line.");
  }
}

async function sessionLog(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const fsPath = editor.document.uri.fsPath;
  let rows: { line: number; sha: string; relpath: string; display: string }[] = [];
  try {
    const out = await runCast(["blame", "--log", "--quickfix", "--", fsPath], path.dirname(fsPath));
    rows = out
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t"))
      .filter((f) => f.length >= 5)
      .map((f) => ({ line: parseInt(f[1], 10), sha: f[2], relpath: f[3], display: f[4] }));
  } catch {
    /* fall through to empty */
  }
  if (rows.length === 0) {
    vscode.window.showInformationMessage("Codecast: no sessions resolved for this file.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    rows.map((r) => ({ label: r.display, description: `line ${r.line}`, row: r })),
    { title: "Sessions that shaped this file (newest first)", placeHolder: "Open the conversation" },
  );
  if (!picked) return;
  try {
    const out = await runCast(["blame", `${fsPath}:${picked.row.line}`, "--open"], path.dirname(fsPath));
    const url = out.trim().split("\n")[0];
    if (url.startsWith("http")) vscode.window.setStatusBarMessage(`Codecast: opened ${url}`, 4000);
  } catch {
    vscode.window.showInformationMessage("Codecast: couldn't open that conversation.");
  }
}

// "Codecast: Run Diagnostics" — dumps everything needed to see why blame
// isn't resolving (resolved cli path, the PATH in use, and a live blame run on
// the active file with the real error). Shown in the Codecast output panel.
async function runDiagnostics(): Promise<void> {
  out.show(true);
  log("──────── codecast diagnostics ────────");
  log(`extension version: 0.1.4`);
  log(`homedir: ${os.homedir()}`);
  log(`process.env.PATH: ${process.env.PATH || "(empty)"}`);
  log(`process.env.SHELL: ${process.env.SHELL || "(unset)"}`);
  resolvedCli = undefined;
  await learnUserPath();
  log(`learned login PATH: ${userPath || "(login-shell probe failed)"}`);
  log(`augmented PATH used for cast: ${augmentedEnv().PATH}`);
  const bin = resolveCliSync();
  log(`resolved cast binary: ${bin || "(none — will use login shell)"}`);
  if (bin) log(`  exists: ${existsSync(bin)}`);

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") {
    log("no file open — open a tracked file and run diagnostics again.");
    return;
  }
  const fsPath = editor.document.uri.fsPath;
  log(`active file: ${fsPath}`);
  try {
    const v = await runCast(["blame", "--line-porcelain", "--", fsPath], path.dirname(fsPath));
    const map = parseLinePorcelain(v);
    log(`✓ blame ran: ${v.length} bytes, ${map.size} lines resolved to sessions`);
    if (map.size === 0) log("  (0 resolved — file may have no synced sessions, or output had no codecast-* keys)");
  } catch (e: any) {
    log(`✗ blame failed: ${e?.message || e}`);
    log(`  code=${e?.code} castMissing=${e?.castMissing}`);
    if (e?.stderr) log(`  stderr: ${e.stderr}`);
  }
  log("──────── end ────────");
}

export function activate(context: vscode.ExtensionContext): void {
  out = vscode.window.createOutputChannel("Codecast");
  decoration = vscode.window.createTextEditorDecorationType({});
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(out, decoration, statusItem);
  log("════════ codecast extension activated (v0.1.4) ════════");
  log(`config cliPath: ${vscode.workspace.getConfiguration("codecast").get("cliPath")}`);
  log(`process PATH: ${process.env.PATH || "(empty)"}`);
  log(`resolved cast: ${resolveCliSync() || "(none)"}`);

  let cursorTimer: NodeJS.Timeout | undefined;
  const onCursor = (editor: vscode.TextEditor | undefined) => {
    if (!editor) return;
    if (cursorTimer) clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => renderCurrentLine(editor), 80);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("codecast.openSession", openSession),
    vscode.commands.registerCommand("codecast.sessionLog", sessionLog),
    vscode.commands.registerCommand("codecast.diagnostics", runDiagnostics),
    vscode.commands.registerCommand("codecast.toggleInlineBlame", async () => {
      const cfg = vscode.workspace.getConfiguration("codecast");
      await cfg.update("inlineBlame", !inlineEnabled(), vscode.ConfigurationTarget.Global);
      const ed = vscode.window.activeTextEditor;
      if (ed) renderCurrentLine(ed);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      if (!blameCache.has(editor.document.uri.fsPath)) loadBlame(editor.document);
      else renderCurrentLine(editor);
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => onCursor(e.textEditor)),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      blameCache.delete(doc.uri.fsPath);
      loadBlame(doc);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => blameCache.delete(doc.uri.fsPath)),
  );

  // Learn the real shell PATH first (so the dev `cast`→bun wrapper resolves),
  // then blame the file that's already open.
  void learnUserPath().finally(() => {
    if (vscode.window.activeTextEditor) loadBlame(vscode.window.activeTextEditor.document);
  });
}

export function deactivate(): void {
  blameCache.clear();
}
