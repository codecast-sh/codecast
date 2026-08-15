/**
 * `cast browser` on top of the agent-browser engine.
 *
 * The shape here is deliberately thin. Almost every verb is a passthrough: we
 * apply codecast's session and profile, hand the rest of the command line
 * straight to the engine, and print what it prints. That buys the engine's
 * whole surface — fifty-odd verbs including React introspection, Web Vitals,
 * HAR capture, accessibility audits and video — without us restating any of it,
 * and without a translation layer to drift out of date.
 *
 * Only three things are genuinely ours, and they are the reason this wrapper
 * exists rather than telling agents to run agent-browser directly:
 *
 *   - **Screenshots land in the conversation.** `shot` writes the file, then
 *     prints the marker the transcript parser turns into an inline image. No
 *     third-party tool can do this; it is the whole reason a human sees what
 *     the agent saw.
 *   - **The profile is codecast's.** Agents inherit the human's logins from a
 *     read-only copy of their real Chrome profile, chosen once and remembered.
 *   - **Sessions are codecast sessions.** Each agent drives an isolated browser
 *     session keyed to its codecast session, so parallel agents cannot navigate
 *     or close each other's tabs.
 *
 * Verb names stay ours even where the engine's differ (`shot`, not
 * `screenshot`; `do`, not `batch`), because those names are already written
 * into every CLAUDE.md on the machine. The mapping is one table below.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Command } from "commander";
import {
  ENGINE_PACKAGE, engineHome, engineSession, engineTabs, engineVersion, ensureEngine, findEngine, runEngine,
} from "./engine.js";
import { closeSessionTab, describeReap, listEngineSessions, reapEngineOrphans } from "./engineReap.js";
import { formatBytes, listRealProfiles } from "./profile.js";
import { DEFAULT_START, startLocalBrowser, startManagedBrowser, type StartOptions } from "./managedBrowser.js";
import { readState, stopInstance } from "./instance.js";
import { isPidAlive } from "../workspace/chrome.js";
import { auditLanding, NAVIGATING_VERBS, refuseNavigation, viaFor } from "./siteGuard.js";
import { emitFailureBlock, engineSource } from "./capture.js";
import { registerAuditCommand } from "./auditCommand.js";
import { autoShotsEnabled, isMutatingStep, maybeAutoShot, setAutoShots, type AutoShotSource } from "./autoShot.js";
import { tabFooterLines, TAB_AFFECTING_VERBS } from "./tabFooter.js";
import { tokenize } from "./batch.js";
import { ownerKey } from "./owner.js";
import { inlineImageMarker } from "../inlineImage.js";
import { uploadOne } from "../imageCommand.js";
import { MAX_IMAGE_SIZE } from "../syncService.js";
import type { PublishDeps } from "../publish.js";
import { fmt, icons } from "../colors.js";

const OK = `${fmt.success(icons.check)}`;
const BAD = `${fmt.error(icons.cross)}`;

function die(msg: string, hint?: string): never {
  console.error(`${BAD} ${msg}`);
  if (hint) console.error(`  ${fmt.muted(hint)}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The session, and the browser it attaches to
// ---------------------------------------------------------------------------

/** Options every engine call carries: this session. The browser is implied —
 *  the one managed Chrome, whose port runEngine reads from the state file. */
function ctx(): { session: string } {
  return { session: engineSession() };
}

/**
 * Make sure the managed browser is up before a verb needs it. `open` is where
 * a session's browsing begins, so it starts the browser when there is none —
 * quietly, behind the human's windows, reusing the profile clone.
 */
async function ensureBrowser(): Promise<void> {
  const state = readState();
  if (state && isPidAlive(state.pid)) return;
  await startLocalBrowser({ ...DEFAULT_START, quiet: true });
}

/**
 * The engine's own screenshot, as the small JPEG the auto-shot policy wants
 * (autoShot.ts). The tab key is the engine session: one active tab per
 * session, so "did this tab change" and "did this session's page change" are
 * the same question.
 */
function engineAutoShotSource(o: Ctx): AutoShotSource {
  return {
    tabKey: `engine:${o.session}`,
    capture: async () => {
      const out = path.join(os.tmpdir(), `cast-autoshot-${process.pid}.jpg`);
      const res = runEngine(["screenshot", out, "--screenshot-format", "jpeg", "--screenshot-quality", "60"], {
        ...o,
        timeoutMs: 20_000,
      });
      if (res.status !== 0) throw new Error(res.stderr || "screenshot failed");
      const buf = fs.readFileSync(out);
      fs.rmSync(out, { force: true });
      return buf;
    },
  };
}

// ---------------------------------------------------------------------------
// Passthrough verbs
// ---------------------------------------------------------------------------

/**
 * Our verb → the engine's verb, for the handful that differ, plus a one-line
 * description so `cast browser --help` still reads like our tool. Anything not
 * listed is still reachable: `cast browser raw <args…>`.
 */
const PASSTHROUGH: Array<{ verb: string; engine?: string; args: string; desc: string }> = [
  { verb: "open", args: "[args...]", desc: "Navigate to a URL" },
  { verb: "snapshot", args: "[args...]", desc: "The page as an accessibility tree with refs to act on" },
  { verb: "click", args: "[args...]", desc: "Click an element (@ref or selector)" },
  { verb: "type", args: "[args...]", desc: "Type into an element" },
  { verb: "fill", args: "[args...]", desc: "Clear a field and fill it" },
  { verb: "press", args: "[args...]", desc: 'Press a key ("Enter", "Control+a")' },
  { verb: "hover", args: "[args...]", desc: "Hover an element, revealing menus" },
  { verb: "focus", args: "[args...]", desc: "Focus an element without clicking" },
  { verb: "select", args: "[args...]", desc: "Choose an option in a dropdown" },
  { verb: "scroll", args: "[args...]", desc: "Scroll the page (up/down/left/right)" },
  { verb: "upload", args: "[args...]", desc: "Attach files to a file input" },
  { verb: "download", args: "[args...]", desc: "Download a file by clicking an element" },
  { verb: "drag", args: "[args...]", desc: "Drag one element onto another" },
  { verb: "wait", args: "[args...]", desc: "Wait for an element, or a number of ms" },
  { verb: "eval", args: "[args...]", desc: "Run JavaScript in the page" },
  { verb: "text", engine: "read", args: "[args...]", desc: "The page's visible text, for reading" },
  { verb: "get", args: "[args...]", desc: "Read text, html, value, attr, box or styles" },
  { verb: "back", args: "[args...]", desc: "Go back in history" },
  { verb: "forward", args: "[args...]", desc: "Go forward in history" },
  { verb: "reload", args: "[args...]", desc: "Reload the page" },
  { verb: "tab", args: "[args...]", desc: "Tabs: list, new, close, switch" },
  { verb: "console", args: "[args...]", desc: "What the page logged" },
  { verb: "errors", args: "[args...]", desc: "Uncaught errors on the page" },
  { verb: "network", args: "[args...]", desc: "Requests, routing and HAR capture" },
  { verb: "cookies", args: "[args...]", desc: "Read and write cookies" },
  { verb: "storage", args: "[args...]", desc: "Local and session storage" },
  { verb: "inspect", args: "[args...]", desc: "Inspect an element in detail" },
  { verb: "react", args: "[args...]", desc: "React tree, renders and Suspense boundaries" },
  { verb: "vitals", args: "[args...]", desc: "Web Vitals for the current page" },
  { verb: "a11y", args: "[args...]", desc: "Accessibility audit (axe-core)" },
  { verb: "trace", args: "[args...]", desc: "Record a DevTools trace" },
  { verb: "record", args: "[args...]", desc: "Record video of the session" },
  { verb: "skills", args: "[args...]", desc: "The engine's own usage guides" },
];

/** Our preset sizes, kept so the names in CLAUDE.md keep meaning the same
 *  thing regardless of which engine is driving. */
const VIEWPORTS: Record<string, [number, number]> = {
  desktop: [1440, 900],
  laptop: [1280, 800],
  wide: [1920, 1080],
  tablet: [820, 1180],
  mobile: [390, 844],
  "mobile-small": [320, 568],
};
const MOBILE_PRESETS = new Set(["tablet", "mobile", "mobile-small"]);

/** The calling codecast session, for the audit trail — same key the built-in
 *  driver stamps, so `cast browser audit` reads one trail whichever engine drove. */
let auditOwner: () => string | null = () => ownerKey();

type Ctx = ReturnType<typeof ctx>;

// ---------------------------------------------------------------------------
// The vocabulary CLAUDE.md teaches → what the engine speaks
// ---------------------------------------------------------------------------
//
// Every installed CLAUDE.md on every machine says `#e42`, `type … --submit`,
// `scroll 800`, `find "Sign in"` then a bare `click`, `wait --ref`. That prose
// is already in agents' context windows and cannot be recalled, so the engine
// path has to accept it. The translations are small and mechanical; anything
// not listed here goes to the engine untouched.

/** `#e42` (what CLAUDE.md says) → `@e42` (what the engine reads). */
export function engineRef(a: string): string {
  return a.replace(/^#e(\d+)$/i, "@e$1");
}

/** Where a `find` remembers what it matched, so a bare action can use it. */
function lastFindPath(session: string): string {
  return path.join(engineHome(), "sessions", session, "last-find");
}
function rememberFind(session: string, ref: string): void {
  try {
    fs.mkdirSync(path.dirname(lastFindPath(session)), { recursive: true });
    fs.writeFileSync(lastFindPath(session), ref);
  } catch {
    /* courtesy only */
  }
}
function recallFind(session: string): string | null {
  try {
    return fs.readFileSync(lastFindPath(session), "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/** Verbs whose first positional argument is the element to act on. */
const TARGETED = new Set(["click", "dblclick", "hover", "focus", "check", "uncheck", "select", "upload", "scrollintoview", "type", "fill", "drag", "download", "inspect", "highlight"]);
/** Verbs that take an element AND a value, so one positional means "the value". */
const TARGET_PLUS_VALUE = new Set(["type", "fill", "select", "upload", "download"]);

/** Key names the built-in driver accepted, in the engine's spelling. */
export function engineKey(k: string): string {
  return k
    .replace(/(^|\+)(cmd|command|meta|⌘)(?=\+|$)/gi, "$1Meta")
    .replace(/(^|\+)(ctrl|control)(?=\+|$)/gi, "$1Control")
    .replace(/(^|\+)(alt|option|opt)(?=\+|$)/gi, "$1Alt")
    .replace(/(^|\+)shift(?=\+|$)/gi, "$1Shift")
    .replace(/^(esc)$/i, "Escape")
    .replace(/^(enter|return)$/i, "Enter")
    .replace(/^(tab)$/i, "Tab")
    .replace(/^(space)$/i, "Space")
    .replace(/^(up|down|left|right)$/i, (m) => `Arrow${m[0].toUpperCase()}${m.slice(1).toLowerCase()}`);
}

export interface EngineCall {
  args: string[];
}

/**
 * One command in our vocabulary → the engine command lines that carry it out.
 * Pure, so it is testable without a browser. `lastFind` is what a bare action
 * falls back to.
 */
export function translate(verb: string, args: string[], lastFind: string | null): EngineCall[] {
  const engineVerb = PASSTHROUGH.find((p) => p.verb === verb)?.engine ?? verb;
  let a = args.map(engineRef);
  const positional = () => a.filter((x) => !x.startsWith("--"));

  if (verb === "press" && a[0]) a = [engineKey(a[0]), ...a.slice(1)];

  if (verb === "scroll") {
    // `scroll 800` / `scroll -800` / `scroll --up 400` → `scroll down|up 800`
    const flags = a.filter((x) => x.startsWith("--"));
    const rest = a.filter((x) => !x.startsWith("--"));
    const up = flags.includes("--up");
    const others = flags.filter((x) => x !== "--up");
    if (rest.length && /^-?\d+$/.test(rest[0])) {
      const n = parseInt(rest[0], 10);
      a = [n < 0 || up ? "up" : "down", String(Math.abs(n)), ...rest.slice(1), ...others];
    } else if (!rest.length) {
      a = [up ? "up" : "down", ...others];
    } else if (up && !/^(up|down|left|right)$/.test(rest[0])) {
      a = ["up", ...rest, ...others];
    }
  }

  if (verb === "wait") {
    if (!a.length) a = ["--load", "networkidle"];
    // `wait --ref #e12` was the built-in driver's spelling of `wait @e12`.
    const i = a.indexOf("--ref");
    if (i >= 0) a = [...a.slice(0, i), ...a.slice(i + 1)];
  }

  if (verb === "network" && (!a.length || a[0] === "--failed")) a = ["requests", ...a.slice(1)];

  if (verb === "open") {
    // The engine always waits and always navigates; these built-in flags have
    // nothing to say to it.
    const newTab = a.includes("--new-tab");
    a = a.filter((x) => x !== "--no-wait" && x !== "--reload" && x !== "--wait" && x !== "--new-tab");
    const i = a.findIndex((x) => !x.startsWith("--"));
    if (i >= 0 && !/^[a-z]+:/i.test(a[i]) && a[i] !== "about:blank") a[i] = `https://${a[i]}`;
    // A second page for this session: bind a new tab and go there.
    if (newTab) return [{ args: ["tab", "new", ...a] }];
  }

  // A bare action after `find` acts on what find matched.
  if (TARGETED.has(verb) && lastFind) {
    const pos = positional();
    const needsTarget = TARGET_PLUS_VALUE.has(verb) ? pos.length === 1 : pos.length === 0;
    if (needsTarget) a = [lastFind, ...a];
  }

  const calls: EngineCall[] = [];
  if ((verb === "type" || verb === "fill") && a.includes("--submit")) {
    calls.push({ args: [engineVerb, ...a.filter((x) => x !== "--submit")] });
    calls.push({ args: ["press", "Enter"] });
    return calls;
  }
  calls.push({ args: [engineVerb, ...a] });
  return calls;
}

// ---------------------------------------------------------------------------
// Running one verb
// ---------------------------------------------------------------------------

/** After an action that may navigate, give the page a moment to arrive so the
 *  screenshot, footer and audit describe where it ended up. Short, and never
 *  a failure: polling apps are never network-idle. */
function settle(o: Ctx): void {
  // A flag, never an env override: the daemon treats a changed environment as
  // a new launch config and resets the tab to about:blank.
  runEngine(["wait", "--load", "networkidle", "--timeout", "3000"], { ...o, timeoutMs: 8_000 });
}

export interface RunOptions {
  /** Inside `do`: no footer per step, the flow prints one at the end. */
  quiet?: boolean;
}

/**
 * Run one command in our vocabulary against the engine, with every hook that
 * must apply to ALL of them:
 *
 * Site policy (siteGuard.ts), the same two hooks the built-in driver has: an
 * explicit `open` is refused before the engine runs when its origin is off the
 * allowlist, and after any verb that can move the page we record where it
 * landed on the audit trail, warning when an in-page action carried it
 * somewhere off-policy. The page is never yanked back.
 *
 * Failure capture (capture.ts): a failing step is followed by the same failure
 * context the built-in driver prints — console errors, failed requests, a
 * screenshot in the thread. `--no-capture` skips it.
 *
 * Auto screenshot (autoShot.ts): after a verb that can change what the page
 * shows, a small capture lands in the conversation if the page visibly
 * changed. `--no-shot` skips it.
 *
 * Tab footer (tabFooter.ts): the URL and tab id the web's "open tab" link reads.
 */
export async function runVerb(verb: string, args: string[], o: Ctx = ctx(), run: RunOptions = {}): Promise<number> {
  const { session } = o;
  const owner = auditOwner();

  if (verb === "open") {
    const url = args.find((a) => !a.startsWith("--"));
    const deny = url ? refuseNavigation(url, owner, "open") : null;
    if (deny) die(deny.message, deny.hint);
    await ensureBrowser();
    // `open` is where a session's browsing begins, so it is also where tabs
    // whose sessions have died get closed (engineReap.ts) — throttled, and
    // never this session's own.
    const swept = describeReap(reapEngineOrphans({ keep: session }));
    if (swept) console.log(fmt.muted(`  ${swept}`));
  }

  // Ours, never the engine's.
  const capture = !args.includes("--no-capture");
  const shot = !args.includes("--no-shot");
  const forwarded = args.filter((a) => a !== "--no-capture" && a !== "--no-shot");

  for (const call of translate(verb, forwarded, recallFind(session))) {
    let res = runEngine(call.args, o);
    // The session is pinned to one tab. When that tab is gone (closed by the
    // human, or by a reap of an earlier incarnation of this session), an
    // `open` binds a fresh one instead of failing; anything else is asked to
    // open first.
    if (res.status !== 0 && /tab_gone/.test(res.stderr + res.stdout)) {
      if (call.args[0] === "open") {
        res = runEngine(["tab", "new", ...call.args.slice(1)], o);
      } else {
        res = { ...res, stderr: `this session's tab is gone — \`cast browser open <url>\` starts a new one\n`, stdout: "" };
      }
    }
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    if (res.status !== 0) {
      const msg = engineFailureMessage(res.stderr, res.stdout);
      await emitFailureBlock(engineSource({ session }), msg, { disabled: !capture });
      return res.status;
    }
  }

  const mutating = isMutatingStep(verb, forwarded);
  if (mutating) {
    settle(o);
    const file = await maybeAutoShot(engineAutoShotSource(o), shot);
    if (file) console.log(inlineImageMarker(file));
  }
  if (!run.quiet && (TAB_AFFECTING_VERBS.has(verb) || NAVIGATING_VERBS.has(verb))) {
    printFooter(o, verb, owner);
  }
  return 0;
}

/** The URL and tab id lines the conversation reads, plus the audit stamp. */
function printFooter(o: Ctx, verb: string, owner: string | null): void {
  const tabs = engineTabs(o);
  // `open` already printed where it landed; repeat the URL only after verbs
  // whose engine output does not say.
  const lines = tabFooterLines(tabs);
  for (const line of verb === "open" ? lines.slice(-1) : lines) console.log(line);
  if (NAVIGATING_VERBS.has(verb)) {
    const url = (tabs.find((t) => t.active) ?? tabs[0])?.url ?? "";
    // Tab identity on the engine path is the engine session: one active tab
    // per session, so per-session dedup is the same thing.
    const warn = url ? auditLanding({ url, tab: `engine:${o.session}`, session: owner, via: viaFor(verb) }) : null;
    if (warn) console.log(`${fmt.warning("!")} ${warn}`);
  }
}

/** Run a verb and exit with its status — the shape commander actions want. */
async function passthrough(verb: string, args: string[]): Promise<never> {
  process.exit(await runVerb(verb, args));
}

/** `find <text>`: refs on the page whose accessible name matches, best first.
 *  Remembers the best one so a following bare action can use it. */
function findRefs(text: string, o: Ctx): { hits: string[]; total: number } {
  const res = runEngine(["snapshot"], o);
  if (res.status !== 0) die((res.stderr || res.stdout).trim().split("\n")[0] || "could not read the page");
  const q = text.toLowerCase();
  const lines = res.stdout.split("\n").filter((l) => l.includes("[ref="));
  // Exact name first: "Save" must not be ambiguous just because "Save
  // draft" also contains it.
  const named = (l: string) => (l.match(/"([^"]*)"/) ?? [, ""])[1]!.toLowerCase();
  const exact = lines.filter((l) => named(l) === q);
  const hits = exact.length ? exact : lines.filter((l) => l.toLowerCase().includes(q));
  const ref = hits[0]?.match(/\[ref=(e\d+)\]/)?.[1];
  if (ref) rememberFind(o.session, `@${ref}`);
  return { hits: hits.map((h) => h.trim()), total: lines.length };
}

/** `shot`: screenshot to a file, inline in the conversation, optionally shared. */
async function takeShot(
  pathArg: string | undefined,
  o: { full?: boolean; share?: boolean; alt?: string; inline?: boolean; extra?: string[] },
  c: Ctx,
  deps: PublishDeps,
): Promise<string> {
  const out = pathArg ?? path.join(os.tmpdir(), `cast-shot-${Date.now()}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const extra = [...(o.extra ?? [])];
  if (o.full) extra.push("--full-page");
  const res = runEngine(["screenshot", out, ...extra], c);
  if (res.status !== 0) {
    die((res.stderr || res.stdout).trim().split("\n")[0] || "the screenshot failed");
  }
  if (!fs.existsSync(out)) die(`the engine reported success but wrote no file at ${out}`);

  const bytes = fs.statSync(out).size;
  console.log(`${OK} ${out} (${formatBytes(bytes)})`);
  // The codecast-specific half: put the picture in the conversation, under
  // the command that took it, the way an extension screenshot appears.
  if (o.inline !== false && bytes <= MAX_IMAGE_SIZE) {
    console.log(inlineImageMarker(path.resolve(out)));
  } else if (o.inline !== false) {
    console.log(fmt.muted(`  (too large to show inline at ${formatBytes(bytes)} — pass --share for a link)`));
  }
  if (o.share) {
    const img = await uploadOne(deps, out, o.alt || "screenshot");
    console.log(img.markdown);
  }
  return out;
}

/**
 * `do`: several steps in one invocation, in OUR vocabulary — `find` and `shot`
 * included — each step through the same runner as its standalone command, so a
 * flow behaves exactly like the commands typed one by one. One footer at the
 * end.
 */
async function runFlow(
  steps: string[],
  o: { keepGoing?: boolean; shot?: boolean; capture?: boolean },
  c: Ctx,
  deps: PublishDeps,
): Promise<number> {
  const started = Date.now();
  let failed = 0;
  // Flow-level opt-outs apply to every step.
  const flowFlags = [...(o.shot === false ? ["--no-shot"] : []), ...(o.capture === false ? ["--no-capture"] : [])];
  for (const raw of steps) {
    const [verb, ...rest] = tokenize(raw);
    const args = [...rest, ...flowFlags];
    if (!verb) continue;
    let ok = true;
    console.log(`${fmt.highlight("›")} ${raw}`);
    try {
      if (verb === "shot") {
        await takeShot(args.find((a) => !a.startsWith("--")), { full: args.includes("--full") }, c, deps);
      } else if (verb === "find") {
        const { hits, total } = findRefs(args.join(" "), c);
        if (!hits.length) throw new Error(`no element matching ${JSON.stringify(args.join(" "))} (${total} refs on the page)`);
        for (const h of hits.slice(0, 5)) console.log(`    ${h}`);
      } else {
        ok = (await runVerb(verb, args, c, { quiet: true })) === 0;
      }
    } catch (err) {
      ok = false;
      console.log(`${BAD} ${(err as Error).message}`);
    }
    if (!ok) {
      failed++;
      if (!o.keepGoing) break;
    }
  }
  printFooter(c, "batch", auditOwner());
  console.log(fmt.muted(`  ${steps.length} step${steps.length === 1 ? "" : "s"} in ${((Date.now() - started) / 1000).toFixed(1)}s${failed ? `, ${failed} failed` : ""}`));
  return failed ? 1 : 0;
}

/** The engine's one-line verdict, for failure classification. */
export function engineFailureMessage(stderr: string, stdout: string): string {
  const lines = `${stderr}\n${stdout}`.split("\n").map((l) => l.replace(/^\s*[✗×x]\s*/, "").trim()).filter(Boolean);
  return lines[0] ?? "the browser engine reported a failure";
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerEngineCommands(br: Command, deps: PublishDeps): void {
  auditOwner = () => ownerKey(deps.detectCurrentSessionId);
  registerAuditCommand(br, auditOwner);

  for (const p of PASSTHROUGH) {
    br.command(`${p.verb} ${p.args}`)
      .description(p.desc)
      .allowUnknownOption(true)
      .helpOption(false)
      .action((args: string[] = []) => passthrough(p.verb, args));
  }

  // Escape hatch: the engine gains verbs faster than this table does, and an
  // agent should never be blocked because we have not listed one yet.
  br.command("raw [args...]")
    .description("Pass a command straight to the browser engine")
    .allowUnknownOption(true)
    .helpOption(false)
    .action((args: string[] = []) => {
      if (!args.length) die("raw needs a command", "e.g. cast browser raw profiler start");
      const res = runEngine(args, ctx());
      if (res.stdout) process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
      process.exit(res.status);
    });

  // -------------------------------------------------------------- screenshots

  br.command("shot [pathArg]")
    .description("Screenshot the page — appears inline in this conversation")
    .option("--full", "Whole scroll height, not just the viewport")
    .option("--share", "Also upload it and print a link you can paste elsewhere")
    .option("--alt <text>", "Caption for the shared image — say what it shows")
    .option("--no-inline", "Do not show the image in the conversation")
    .allowUnknownOption(true)
    .action(async (pathArg: string | undefined, o: any, cmd: any) => {
      // Anything we do not recognise belongs to the engine, not to us.
      const extra = (cmd.args ?? []).filter((a: unknown) => typeof a === "string" && a.startsWith("--"));
      await takeShot(pathArg, { ...o, extra }, ctx(), deps);
    });

  br.command("do [steps...]")
    .description("Run several steps in one invocation")
    .option("--keep-going", "Continue past a failing step")
    .option("--no-shot", "Skip the automatic screenshots after page-changing steps")
    .option("--no-capture", "Skip the automatic failure context on a failing step")
    .addHelpText(
      "after",
      `
Steps are the same commands you would type one at a time, each in quotes.
Pass \`-\` to read them from stdin, one per line:

  cast browser do "open example.com" "find Sign in" click "wait --text Password" shot
  cast browser do - <<'EOF'
  open https://example.com
  find "Sign in"
  click
  type #e42 "hunter2" --submit
  shot
  EOF

A step with no ref uses whatever the last \`find\` matched.`,
    )
    .action(async (steps: string[] = [], o: { keepGoing?: boolean; shot?: boolean; capture?: boolean }) => {
      let plan = steps;
      if (steps.length === 1 && steps[0] === "-") {
        const stdin = await new Promise<string>((resolve) => {
          let buf = "";
          process.stdin.setEncoding("utf-8");
          process.stdin.on("data", (d) => (buf += d));
          process.stdin.on("end", () => resolve(buf));
        });
        plan = stdin.split("\n").map((l) => l.trim()).filter(Boolean);
      }
      if (!plan.length) die("no steps given", 'try: cast browser do "open example.com" snapshot');
      process.exit(await runFlow(plan, o, ctx(), deps));
    });

  // ------------------------------------------------------- compatibility verbs
  //
  // These four are in every CLAUDE.md already installed on every machine, so
  // they have to keep working whichever engine is driving. The engine spells
  // some of them differently and does not have `find` at all; that is our
  // problem to absorb, not something to push onto agents by rewriting prose
  // they have already read into their context.

  br.command("tabs")
    .description("List open tabs")
    .action(() => passthrough("tab", ["list"]));

  br.command("find <text>")
    .description("Find elements whose visible name matches")
    .action((text: string) => {
      // The engine has no `find` of this shape. A snapshot already carries every
      // ref with its accessible name, so matching here costs one call and keeps
      // the verb — and remembers the match for a bare action to use.
      const { hits, total } = findRefs(text, ctx());
      if (!hits.length) {
        console.log(`no element matching ${JSON.stringify(text)} (${total} refs on the page)`);
        process.exit(1);
      }
      for (const h of hits.slice(0, 25)) console.log(h);
      if (hits.length > 25) console.log(fmt.muted(`  … and ${hits.length - 25} more`));
    });

  br.command("viewport [size]")
    .description("Resize the page, or emulate a device: desktop, laptop, wide, tablet, mobile, mobile-small")
    .option("--reset", "Back to the default size")
    .action((size: string | undefined, o: { reset?: boolean }) => {
      const c = ctx();
      if (o.reset || size === "reset") {
        runEngine(["set", "viewport", "1440", "900"], c);
        return console.log(`${OK} viewport reset`);
      }
      if (!size) {
        const res = runEngine(["eval", "JSON.stringify([innerWidth,innerHeight,devicePixelRatio])"], c);
        console.log(res.stdout.trim());
        console.log(fmt.muted(`  presets: ${Object.keys(VIEWPORTS).join(", ")}  ·  or a size like 1024x768`));
        return;
      }
      const preset = VIEWPORTS[size];
      const explicit = /^(\d+)x(\d+)$/.exec(size);
      if (!preset && !explicit) {
        die(`unknown size '${size}'`, `use a preset (${Object.keys(VIEWPORTS).join(", ")}) or WxH like 1024x768`);
      }
      const [w, h] = preset ?? [parseInt(explicit![1], 10), parseInt(explicit![2], 10)];
      const res = runEngine(["set", "viewport", String(w), String(h)], c);
      if (res.status !== 0) die((res.stderr || res.stdout).trim().split("\n")[0] || "could not resize");
      console.log(`${OK} ${size} — ${w}x${h}`);
      if (preset && MOBILE_PRESETS.has(size)) {
        // Say it plainly: a "mobile" page that is secretly non-touch can show a
        // hover menu no real phone would ever render.
        console.log(fmt.muted("  (size only — touch is not emulated, so hover-only menus still open)"));
      }
    });

  br.command("dialogs")
    .description("Modal dialogs the page tried to open")
    .action(() => {
      console.log(
        fmt.muted("alert / confirm / beforeunload are dismissed automatically, so a dialog cannot freeze the tab.\n") +
          fmt.muted("Anything the page logged around one shows in `cast browser console`."),
      );
    });

  // ---------------------------------------------------------------- lifecycle

  br.command("start")
    .description("Get the browser ready (installs the engine on first use)")
    .option("--profile <dir>", "Chrome profile to inherit logins from (see `cast browser profiles`)")
    .option("--fresh", "Start signed out of everything")
    .option("--resync", "Re-copy the profile even if a clone already exists")
    .option("--headless", "Run without a visible window")
    .option("--size <WxH>", "Window size", DEFAULT_START.size)
    .option("--remote [host]", "Run the browser on a remote host (see `cast browser hosts`)")
    .action(async (o: Partial<StartOptions>) => {
      let install;
      try {
        install = ensureEngine();
      } catch (err) {
        die((err as Error).message);
      }
      if (install.installed) console.log(`${OK} browser engine installed (${ENGINE_PACKAGE})`);

      const session = engineSession();
      const swept = describeReap(reapEngineOrphans({ force: true, keep: session }));
      if (swept) console.log(fmt.muted(`  ${swept}`));

      await startManagedBrowser({ ...DEFAULT_START, ...o });
      console.log(fmt.muted(`  this session drives its own tab in it — session ${session}`));
    });

  br.command("status")
    .description("What the browser is doing")
    .action(() => {
      const binary = findEngine();
      const state = readState();
      if (!binary || !state) {
        console.log(`${fmt.muted(icons.dot)} not set up yet — run \`cast browser start\``);
        return;
      }
      const c = ctx();
      const alive = isPidAlive(state.pid);
      console.log(`${alive ? OK : BAD} browser ${alive ? "up" : "gone"} — pid ${state.pid}, CDP 127.0.0.1:${state.port}${state.headless ? ", headless" : ""}`);
      console.log(`  engine: ${ENGINE_PACKAGE} ${engineVersion() ?? "?"}  ${fmt.muted(binary)}`);
      console.log(`  session: ${c.session}`);
      console.log(`  profile: ${state.sourceProfile ? `${state.sourceProfile} (logins inherited)` : "fresh — signed out"}`);
      if (!alive) return;
      const res = runEngine(["tab", "list"], c);
      if (res.status === 0 && res.stdout.trim()) {
        console.log(`  tabs (→ is this session's):`);
        for (const line of res.stdout.trim().split("\n")) console.log(`    ${line}`);
      }
      const others = listEngineSessions().filter((x) => x.running && x.key !== c.session);
      if (others.length) {
        console.log(fmt.muted(`  ${others.length} other session${others.length === 1 ? " is" : "s are"} browsing here too — abandoned tabs close on the next start`));
      }
    });

  br.command("stop")
    .description("Close this session's tab; --all closes every session's and the browser")
    .option("--all", "Close every session's tab and the browser itself")
    .option("--wipe", "With --all: also remove the cloned profile")
    .action(async (o: { all?: boolean; wipe?: boolean }) => {
      const { session } = ctx();
      // Detach the engine and close the tab it was pinned to; the browser
      // stays for everyone else.
      closeSessionTab(session);
      console.log(`${OK} closed this session's tab`);
      const swept = describeReap(reapEngineOrphans({ force: true, keep: o.all ? null : session, idleMs: o.all ? 0 : undefined }));
      if (swept) console.log(fmt.muted(`  ${swept}`));
      if (o.all) {
        const state = readState();
        if (state) {
          await stopInstance(state);
          console.log(`${OK} browser stopped`);
          if (o.wipe) {
            fs.rmSync(state.userDataDir, { recursive: true, force: true });
            console.log(`${OK} removed the cloned profile`);
          }
        }
      }
    });

  br.command("shots [mode]")
    .description("Automatic screenshots after page-changing commands: on | off | status")
    .action((mode?: string) => {
      if (!mode || mode === "status") {
        console.log(
          autoShotsEnabled()
            ? `${OK} auto screenshots are on — page-changing commands inline a small capture (\`--no-shot\` skips one)`
            : `${fmt.muted(icons.dot)} auto screenshots are off — enable with \`cast browser shots on\``,
        );
        return;
      }
      if (mode !== "on" && mode !== "off") die(`'${mode}' is not a mode`, "use: cast browser shots on | off | status");
      setAutoShots(mode === "on");
      console.log(`${OK} auto screenshots ${mode}`);
    });

  br.command("profiles")
    .description("Chrome profiles on this machine, and which one agents use")
    .action(() => {
      const profiles = listRealProfiles();
      if (!profiles.length) die("no Chrome profiles found on this machine");
      const active = readState()?.sourceProfile ?? null;
      for (const p of profiles) {
        const mark = p.dir === active ? fmt.success("*") : " ";
        const tag = p.lastUsed ? fmt.muted(" (you used this last)") : "";
        console.log(`${mark} ${p.dir.padEnd(12)} ${fmt.highlight(p.name)}${p.email ? fmt.muted(` <${p.email}>`) : ""}${tag}`);
      }
      console.log(fmt.muted(`\n  * = what agents use. Change it with: cast browser stop --all && cast browser start --profile "<dir>"`));
    });
}
