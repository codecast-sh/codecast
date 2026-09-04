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
  ENGINE_PACKAGE, engineHelpText, engineHome, engineSession, engineTabs, engineVersion, ensureEngine, findEngine, isRealSession,
  realSessionKey, runEngine, runEngineJson,
} from "./engine.js";
import { engineBrowserFor, isRealMode, realModeHint, requireRealBridge, splitTargetFlags } from "./bridge/real.js";
import { registerBridgeCommands, targetFlags } from "./bridge/commands.js";
import { closeSessionTab, describeReap, listEngineSessions, reapEngineOrphans } from "./engineReap.js";
import { matchRefs, nearMatches } from "./snapshot.js";
import { ensurePinnedTab } from "./pinnedTab.js";
import { formatBytes, keepsOwnLogin, listRealProfiles } from "./profile.js";
import { DEFAULT_START, startLocalBrowser, startManagedBrowser, type StartOptions } from "./managedBrowser.js";
import { readState, stopInstance, writeState } from "./instance.js";
import { provisionLocalLogins } from "./credentials.js";
import { isPidAlive } from "../workspace/chrome.js";
import { auditLanding, NAVIGATING_VERBS, refuseNavigation, signInHost, signInLandingNote, viaFor } from "./siteGuard.js";
import { focusBrowserTabBlocking } from "./focusHttp.js";
import { emitFailureBlock, engineSource } from "./capture.js";
import { registerAuditCommand } from "./auditCommand.js";
import { autoShotsEnabled, clearAutoShots, isMutatingStep, maybeAutoShot, setAutoShots, type AutoShotSource } from "./autoShot.js";
import { tabFooterLines, TAB_AFFECTING_VERBS } from "./tabFooter.js";
import { tokenize } from "./batch.js";
import { evalInPage, grantPermissions } from "./pageEval.js";
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

/** Which browser a command was asked for: `--real` / `--clone`, or nothing
 *  and the session's sticky choice (`cast browser target`) decides. */
export interface TargetChoice {
  real?: boolean;
  clone?: boolean;
}

/**
 * Which browser each verb may act on. Every verb drives both unless it is
 * listed here with the reason it drives the clone only. Read in one place,
 * `ctxFor`, which the pre-action hook and the verb bodies share, so a verb
 * that will refuse the real Chrome refuses before anything touches it.
 */
const CLONE_ONLY: Record<string, string> = {
  grant: "the extension cannot grant site permissions in the human's Chrome",
  login: "the human's Chrome already holds their logins; a sign-in there is the human's own",
};

/**
 * Why a verb refuses the real Chrome, or null when it drives both. The one
 * reading of CLONE_ONLY: `ctxFor` dies with it before a standalone verb runs,
 * and `runFlow` fails the step with it inside a `do` flow, so the two paths
 * cannot disagree about which verbs the real Chrome gets.
 */
function cloneOnlyRefusal(verb: string, real: boolean): { message: string; hint: string } | null {
  const why = CLONE_ONLY[verb];
  if (!why || !real) return null;
  return {
    message: `\`${verb}\` drives the agent browser only: ${why}`,
    hint: `cast browser ${verb} --clone …, or \`cast browser target clone\``,
  };
}

/**
 * Options every engine call carries: this session, and the browser it drives.
 * Real mode (bridge/real.ts isRealMode) is the default once paired: a
 * second engine session, keyed `<session>-real`, on the bridge host's socket;
 * the daemon resets its tab when a session's flags change, so the two never
 * share a key. The human's Chrome is already running with its own logins;
 * the bridge host and the extension are what must be up for it, so a host
 * that is not running is started here (requireRealBridge), before the socket
 * URL is built. Dies when real mode was asked for but the bridge was never
 * set up, the extension is not on the host, or the host on its port cannot
 * prove it is ours: silently driving the clone instead would act on the
 * wrong browser.
 */
async function ctx(choice: TargetChoice = {}): Promise<Ctx> {
  const session = engineSession();
  if (!isRealMode(choice, auditOwner())) return { session };
  try {
    return await engineBrowserFor(realSessionKey(session), await requireRealBridge());
  } catch (err) {
    die((err as Error).message);
  }
}

/** `ctx` for a named verb: a clone-only verb (CLONE_ONLY) asked for the real
 *  Chrome dies here, before any side effect in either browser. */
async function ctxFor(verb: string, choice: TargetChoice): Promise<Ctx> {
  const refused = cloneOnlyRefusal(verb, isRealMode(choice, auditOwner()));
  if (refused) die(refused.message, refused.hint);
  return ctx(choice);
}

/** The choice a commander command was invoked with: its parsed `--real` /
 *  `--clone` options, or the same flags left raw among a passthrough verb's
 *  arguments. */
function targetChoiceOf(cmd: Command): TargetChoice {
  const o = cmd.opts() as TargetChoice;
  const raw = splitTargetFlags(cmd.args);
  return { real: o.real || raw.real, clone: o.clone || raw.clone };
}

/**
 * A passthrough verb's browser and its own arguments, from a raw argument
 * list that may carry `--real` / `--clone`: the one place the flags come off
 * the line and the browser is chosen from them.
 */
async function targetOf(verb: string, args: string[]): Promise<{ ctx: Ctx; args: string[] }> {
  const t = splitTargetFlags(args);
  return { ctx: await ctxFor(verb, t), args: t.args };
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
  { verb: "open", args: "[args...]", desc: "Navigate to a URL (--new-tab for a second page)" },
  { verb: "snapshot", args: "[args...]", desc: "The page as an accessibility tree with refs (-i interactive only, -s <sel> scope, -c compact, -d <n> depth, -u link urls)" },
  { verb: "read", args: "[args...]", desc: 'The page, or a URL, as clean readable text (--outline, --filter <text>) — best for "what does this page say"' },
  { verb: "click", args: "[args...]", desc: "Click an element (#e42 ref or CSS selector)" },
  { verb: "type", args: "[args...]", desc: "Type into an element (--submit presses Enter after)" },
  { verb: "fill", args: "[args...]", desc: "Clear a field and fill it" },
  { verb: "press", args: "[args...]", desc: 'Press a key ("Enter", "Control+a")' },
  { verb: "hover", args: "[args...]", desc: "Hover an element, revealing menus" },
  { verb: "focus", args: "[args...]", desc: "Focus an element without clicking" },
  { verb: "select", args: "[args...]", desc: "Choose an option in a dropdown" },
  { verb: "scroll", args: "[args...]", desc: "Scroll the page (up/down/left/right)" },
  { verb: "upload", args: "[args...]", desc: "Attach files to a file input" },
  { verb: "download", args: "[args...]", desc: "Download a file by clicking an element" },
  { verb: "drag", args: "[args...]", desc: "Drag one element onto another" },
  { verb: "wait", args: "[args...]", desc: "Wait for --text <s>, --url <pat>, --load <state>, --fn <js>, a selector, or ms" },
  { verb: "text", engine: "read", args: "[args...]", desc: "Visible text of the page, or of one element (text <selector>)" },
  { verb: "get", args: "[args...]", desc: "Element data without eval: get text|html|value|attr|count|box|styles <sel>" },
  { verb: "diff", args: "[args...]", desc: "What changed: diff snapshot (since your last snapshot; -s <sel> scope), diff url <u1> <u2>" },
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
  { verb: "skills", args: "[args...]", desc: "The engine's own usage guides (skills get core --full)" },
];

/** What the wrapper layers on top of every engine verb, appended to the
 *  generated help so it documents the command an agent actually runs. */
const CAST_HELP_EXTRAS = `Cast additions:
  #e42 and @e42 both work as element refs (they come from \`cast browser snapshot\`)
  --no-shot      Skip the automatic screenshot after a page-changing command
  --no-capture   Skip the failure context (console, network, screenshot) when a step fails

The engine's full guide: cast browser skills get core --full`;

/** Hand-written help for `text`: its selector form is ours (it fans out to two
 *  engine verbs), so no single engine help page describes it. */
const TEXT_HELP = `cast browser text - Visible text, for reading rather than acting

Usage: cast browser text [selector]

With no selector, prints the whole page as readable text.
With a CSS selector or a ref, prints just that element's text — the cheap way
to read one region of a large page:

  cast browser text                     # the whole page
  cast browser text "div[role=main]"    # one region, by CSS selector
  cast browser text #e42                # one element, by snapshot ref

Related:
  cast browser read             the page or a URL as clean text/markdown (--outline, --filter <text>)
  cast browser get text <sel>   what a scoped \`text\` runs underneath`;

/**
 * Per-verb help, generated from the engine's own \`--help\` so the flag list
 * cannot drift from what the passthrough accepts. Only the branding and verb
 * names are reworded into our vocabulary.
 */
export function verbHelp(p: { verb: string; engine?: string; desc: string }): string {
  if (p.verb === "text") return `${TEXT_HELP}\n\n${CAST_HELP_EXTRAS}`;
  const engineVerb = p.engine ?? p.verb;
  const raw = engineHelpText(engineVerb);
  if (!raw) {
    return (
      `Usage: cast browser ${p.verb} [args...]\n\n${p.desc}\n\n` +
      `(run \`cast browser start\` once to install the engine — the per-flag help comes from it)\n\n${CAST_HELP_EXTRAS}`
    );
  }
  const body = raw
    .replace(/\bagent-browser\b/g, "cast browser")
    .replace(new RegExp(`\\bcast browser ${engineVerb}\\b`, "g"), `cast browser ${p.verb}`);
  return `${body}\n\n${CAST_HELP_EXTRAS}`;
}

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

type Ctx = Awaited<ReturnType<typeof engineBrowserFor>>;

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

/**
 * `[role=main]` → `[role="main"]`. The engine's `-s` scoping rejects unquoted
 * attribute values that querySelector accepts, so the CSS an agent naturally
 * writes would miss. Quoting is always valid, so normalise rather than teach
 * the quirk.
 */
export function quoteAttrValues(sel: string): string {
  return sel.replace(/\[([\w-]+)([~^$*|]?=)([^"'\]]+)\]/g, '[$1$2"$3"]');
}

/** Where a `find` remembers what it matched, so a bare action can use it. */
function lastFindPath(session: string): string {
  return path.join(engineHome(), "sessions", session, "last-find");
}
function rememberFind(session: string, ref: string, query?: string): void {
  try {
    fs.mkdirSync(path.dirname(lastFindPath(session)), { recursive: true });
    fs.writeFileSync(lastFindPath(session), query ? `${ref} ${query}` : ref);
  } catch {
    /* courtesy only */
  }
}
function recallFind(session: string): string | null {
  try {
    const line = fs.readFileSync(lastFindPath(session), "utf-8").trim();
    return line.split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}
/** The words the last `find` matched on — what a stale-ref retry re-finds. */
function recallFindQuery(session: string): string | null {
  try {
    const line = fs.readFileSync(lastFindPath(session), "utf-8").trim();
    const i = line.indexOf(" ");
    return i > 0 ? line.slice(i + 1) : null;
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

  if (verb === "snapshot" || verb === "diff") {
    a = a.map((x, i) => (a[i - 1] === "-s" || a[i - 1] === "--selector" ? quoteAttrValues(x) : x));
  }

  if (verb === "read") {
    // `read -s <sel>` arrives by analogy with `snapshot -s` (observed in
    // agent testing). Scoped text is the engine's `get text`; absorb the
    // analogy instead of teaching the asymmetry. Only when no URL competes.
    const i = a.findIndex((x) => x === "-s" || x === "--selector");
    if (i >= 0) {
      const sel = a[i + 1];
      const others = a.filter((_, j) => j !== i && j !== i + 1);
      if (sel && !others.some((x) => !x.startsWith("-"))) {
        return [{ args: ["get", "text", sel, ...others] }];
      }
    }
  }

  if (verb === "text") {
    // `text <selector|ref>` reads ONE element (the engine's `get text`);
    // bare `text` reads the whole page (the engine's `read`). Without this,
    // reading one region of a big app forces agents into `eval`. A URL still
    // reads as a document, and a leading flag (--outline, --filter) means the
    // whole-page read was intended.
    if (a[0] === "-s" || a[0] === "--selector") return [{ args: ["get", "text", ...a.slice(1)] }];
    if (a[0] && !a[0].startsWith("-") && !/^[a-z]+:\/\//i.test(a[0])) return [{ args: ["get", "text", ...a] }];
  }

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
export async function runVerb(verb: string, args: string[], o: Ctx, run: RunOptions = {}): Promise<number> {
  const { session } = o;
  const owner = auditOwner();
  const real = isRealSession(session);

  if (verb === "open") {
    const url = args.find((a) => !a.startsWith("--"));
    const deny = url ? refuseNavigation(url, owner, "open") : null;
    if (deny) die(deny.message, deny.hint);
    // The real Chrome is the human's, already running; its bridge came up in
    // ctx. The clone is ours to start.
    if (!real) await ensureBrowser();
    // The pre-action hook ran before the browser existed on a cold start;
    // now that it does, bind this session's tab quietly (pinnedTab.ts).
    await ensurePinnedTab(session);
    // `open` is where a session's browsing begins, so it is also where tabs
    // whose sessions have died get closed (engineReap.ts) — throttled, and
    // never this session's own.
    const swept = describeReap(await reapEngineOrphans({ keep: session }));
    if (swept) console.log(fmt.muted(`  ${swept}`));
    // Your logins for this site, as your real Chrome holds them right now —
    // the clone the browser started from may be hours old (credentials.ts).
    if (url && !real) await carryLogins(url);
  }

  // `read <url>` fetches that URL, so the same site policy that gates `open`
  // gates it — a denied site must not be readable through a side door.
  if (verb === "read") {
    const url = args.find((x) => !x.startsWith("-"));
    const deny = url ? refuseNavigation(url, owner, "open") : null;
    if (deny) die(deny.message, deny.hint);
  }

  // `tab <id>`, `tab close <id>` and `tab switch <id>` take what the footer
  // printed (the 8-char target id) or a substring of a URL; the engine wants
  // its own `t<N>` label. A full target id would do for the clone, but over
  // the bridge a target id IS 8 chars and the engine reads anything shorter
  // than 16 as a label, so the label is the one form that works everywhere.
  if (verb === "tab") {
    const at = /^(close|switch)$/.test(args[0] ?? "") ? 1 : 0;
    const ref = args[at];
    if (ref && !/^(list|new|close|switch|--.*|t\d+)$/.test(ref)) {
      const q = ref.toLowerCase();
      const tabs = engineTabs(o);
      const hit =
        tabs.find((t) => t.targetId.toLowerCase().startsWith(q)) ??
        tabs.find((t) => (t.url ?? "").toLowerCase().includes(q));
      if (hit) args = [...args.slice(0, at), hit.tabId || hit.targetId, ...args.slice(at + 1)];
    }
  }

  // Ours, never the engine's. `skills` never touches a page, so a failure
  // there gets no page evidence either way.
  const capture = !args.includes("--no-capture") && verb !== "skills";
  const shot = !args.includes("--no-shot");
  const forwarded = args.filter((a) => a !== "--no-capture" && a !== "--no-shot");

  // Did translate() have to reach for the last find? Then a failure may just
  // be that ref going stale (a re-render, a route change since the find) —
  // re-find by the remembered words and retry once before reporting.
  const positionals = forwarded.filter((x) => !x.startsWith("--")).length;
  const usedLastFind =
    TARGETED.has(verb) && (TARGET_PLUS_VALUE.has(verb) ? positionals === 1 : positionals === 0);

  let calls = translate(verb, forwarded, recallFind(session));
  let refound = false;
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    let res = runEngine(call.args, o);
    if (res.status !== 0 && usedLastFind && !refound && i === 0 && !/tab_gone/.test(res.stderr + res.stdout)) {
      const query = recallFindQuery(session);
      if (query) {
        refound = true;
        const again = findRefs(query, o, { lenient: true }); // re-snapshots and re-remembers
        const fresh = recallFind(session);
        if (again.hits.length && fresh && fresh !== call.args.find((x) => /^@e\d+$/.test(x))) {
          console.log(fmt.muted(`  ref went stale — re-found ${JSON.stringify(query)} as ${fresh.replace("@", "#")}`));
          calls = translate(verb, forwarded, fresh);
          res = runEngine(calls[i].args, o);
        }
      }
    }
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
      await emitFailureBlock(engineSource(o), msg, { disabled: !capture });
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

/** Bring this machine's current cookies for the site into the managed browser. */
async function carryLogins(rawUrl: string): Promise<void> {
  const state = readState();
  if (!state || state.remote || !state.sourceProfile) return;
  const url = /^[a-z]+:/i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  try {
    const r = await provisionLocalLogins(state.port, url, { profileDir: state.sourceProfile, channel: state.channel });
    if (r.injected) console.log(fmt.muted(`  carried ${r.injected} cookie${r.injected === 1 ? "" : "s"} for ${r.host} from your Chrome`));
  } catch {
    /* a courtesy: never fail the open over it */
  }
}

/** Appended to a tab line when the tab is in the human's real Chrome. */
export const REAL_TAB_NOTE = " (real Chrome, via the extension)";

/** The URL and tab id lines the conversation reads, plus the audit stamp. */
function printFooter(o: Ctx, verb: string, owner: string | null): void {
  const tabs = engineTabs(o);
  // `open` already printed where it landed; repeat the URL only after verbs
  // whose engine output does not say.
  const lines = tabFooterLines(tabs);
  // The tab line names a tab in the human's own Chrome: say so, after the
  // id, where the web's tab parser (browserFocus.ts) does not read.
  if (lines.length && isRealSession(o.session)) lines[lines.length - 1] += fmt.muted(REAL_TAB_NOTE);
  for (const line of verb === "open" ? lines.slice(-1) : lines) console.log(line);
  if (NAVIGATING_VERBS.has(verb)) {
    const url = (tabs.find((t) => t.active) ?? tabs[0])?.url ?? "";
    // Tab identity on the engine path is the engine session: one active tab
    // per session, so per-session dedup is the same thing.
    const warn = url ? auditLanding({ url, tab: `engine:${o.session}`, session: owner, via: viaFor(verb) }) : null;
    if (warn) console.log(`${fmt.warning("!")} ${warn}`);
    // A login form where the work was expected. Named, with the fix, so an
    // agent does not read it as an empty page or restart the browser over it.
    const signIn = url ? signInLandingNote(url, keepsOwnLogin, realModeHint(owner)) : null;
    if (signIn) console.log(`${fmt.warning("!")} ${signIn}`);
  }
}

/** This session's current tab, as the engine sees it. */
function currentTab(o: Ctx): { targetId: string; url: string } | null {
  const tabs = engineTabs(o);
  const t = tabs.find((x) => x.active) ?? tabs[0];
  return t?.targetId ? { targetId: t.targetId, url: t.url ?? "" } : null;
}

/**
 * `login [url]`: a person signs in once, in the agent browser.
 *
 * Opens the page (when given), brings the agent browser's window and this
 * session's tab to the front — the same route the web's "open tab" link uses
 * (focusHttp.ts) — and waits until the tab has left the sign-in page. The
 * login lands in the clone's own cookie store, so it survives restarts and
 * `--resync`; only `stop --wipe` and `start --fresh` drop it. This is the
 * whole answer for the sites the agent browser never borrows a login for
 * (Google — profile.ts), and the fallback for any site that keeps its session
 * where a cookie carry cannot reach.
 */
/** One focus steal per this window, machine-wide — see InstanceState.loginRaisedAt. */
export const LOGIN_RAISE_COOLDOWN_MS = 5 * 60_000;

/**
 * Whether `login` may pull the window to the front, given where the tab is
 * and when a login raise last happened (machine-wide, from InstanceState).
 * Pure, so the invariant is pinned by test: an already-authed page never
 * raises, and a pending sign-in raises at most once per cooldown — a caller
 * re-running `login` in a loop must never turn into repeated focus steals.
 */
export function loginRaisePlan(
  startHost: string | null,
  lastRaisedAt: number | undefined,
  now: number,
): "signed-in" | "cooldown" | "raise" {
  if (!startHost) return "signed-in";
  if (now - (lastRaisedAt ?? 0) < LOGIN_RAISE_COOLDOWN_MS) return "cooldown";
  return "raise";
}

async function loginAsPerson(url: string | undefined, waitSeconds: number, choice: TargetChoice): Promise<number> {
  const o = await ctxFor("login", choice);
  if (url) {
    const code = await runVerb("open", [url], o, { quiet: true });
    if (code !== 0) return code;
  } else {
    await ensureBrowser();
    await ensurePinnedTab(o.session);
  }
  const tab = currentTab(o);
  if (!tab) die("this session has no tab to sign in on", "give a URL: cast browser login <url>");
  const startHost = signInHost(tab.url);
  const lastRaisedAt = readState()?.loginRaisedAt;
  const plan = loginRaisePlan(startHost, lastRaisedAt, Date.now());
  // Not a sign-in page: there is nothing for a person to type, so leave focus
  // alone. A caller re-running `login` after the sign-in already landed must
  // never keep pulling the window in front of the human (observed 2026-08-26:
  // a retry loop raised the window every 10s over an already-authed page).
  if (plan === "signed-in") {
    console.log(`${OK} not on a sign-in page (${tab.url}) — already signed in, nothing to wait for; the window stays where it is`);
    printFooter(o, "login", auditOwner());
    return 0;
  }
  if (plan === "cooldown") {
    // Still waiting on a person, but the window was raised moments ago —
    // repeating the raise only steals focus, it cannot speed the sign-in up.
    const sinceRaise = Math.round((Date.now() - (lastRaisedAt ?? 0)) / 1000);
    console.log(
      `${fmt.warning("!")} sign-in still pending on ${startHost} — the window was raised ${sinceRaise}s ago, not raising it again yet`,
    );
  } else {
    // Stamp before raising: the focus sentinel (focusSentinel.ts) reads this
    // to tell a wanted raise from a theft, so it must be visible on disk
    // before the window ever moves.
    const fresh = readState();
    if (fresh) writeState({ ...fresh, loginRaisedAt: Date.now() });
    const raised = await focusBrowserTabBlocking(tab.targetId);
    if (raised.ok) console.log(`${OK} raised the agent browser on ${startHost} — a separate window from your Chrome`);
    else console.log(`${fmt.warning("!")} could not raise the window (${raised.reason}); it is the Chrome window titled by the page, behind your others`);
  }
  console.log(fmt.muted("  sign in there once; the login stays in the agent browser across restarts (only `stop --wipe` / `start --fresh` drop it)"));
  const hint = realModeHint(auditOwner());
  if (hint) console.log(fmt.muted(`  or skip the sign-in: ${hint}`));
  printFooter(o, "login", auditOwner());
  if (waitSeconds <= 0) return 0;

  const deadline = Date.now() + waitSeconds * 1000;
  console.log(fmt.muted(`  waiting up to ${waitSeconds}s for the page to leave the sign-in page…`));
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const now = currentTab(o);
    if (!now) die("the tab went away while waiting");
    if (now.url && now.url !== tab.url && !signInHost(now.url)) {
      console.log(`${OK} signed in — now on ${now.url}`);
      return 0;
    }
  }
  const still = currentTab(o)?.url ?? tab.url;
  console.log(`${fmt.warning("!")} still on a sign-in page after ${waitSeconds}s (${still}) — run \`cast browser login\` again once the person has signed in`);
  return 1;
}

/** Run a verb and exit with its status — the shape commander actions want. */
async function passthrough(verb: string, args: string[]): Promise<never> {
  const t = await targetOf(verb, args);
  process.exit(await runVerb(verb, t.args, t.ctx));
}

/** One line of the engine's snapshot that carries a ref, parsed for matching.
 *  Flags render as `[expanded=false, ref=e162]` — the ref is not always at the
 *  start of the bracket, so match the pattern, not a "[ref=" prefix (that
 *  prefix filter silently hid every expanded/checked/disabled element). */
const REF_IN_LINE = /[[ ]ref=(e\d+)\]/;

export function parseEngineRefs(stdout: string): Array<{ line: string; role: string; name: string }> {
  return stdout
    .split("\n")
    .filter((l) => REF_IN_LINE.test(l))
    .map((line) => ({
      line: line.trim(),
      role: line.match(/^\s*- (\w+)/)?.[1] ?? "",
      name: line.match(/"([^"]*)"/)?.[1] ?? "",
    }));
}

/** Reorder ambiguous matches so on-screen elements come first, given each
 *  ref's box (zero size = hidden: display:none, a kept-alive background tab
 *  pane, a collapsed menu). Pure, so it is testable without a browser. */
export function rankByVisibility<T>(
  hits: T[],
  boxOf: (hit: T) => { width: number; height: number } | null,
): { ordered: T[]; hidden: Set<T> } {
  const hidden = new Set<T>();
  for (const h of hits) {
    const b = boxOf(h);
    if (b && (b.width <= 0 || b.height <= 0)) hidden.add(h);
  }
  return { ordered: [...hits.filter((h) => !hidden.has(h)), ...hits.filter((h) => hidden.has(h))], hidden };
}

/** `find <text>`: refs on the page whose accessible name matches, best first.
 *  Parses the engine's snapshot lines into (role, name) and hands matching to
 *  the shared matcher, so both drivers rank identically. With several matches,
 *  hidden elements (zero-size box) sink to the bottom — the wrong-"huddle"
 *  class of miss, where a kept-alive background pane held the same label.
 *  Remembers the best hit AND the query, so a following bare action can use
 *  it and a stale ref can be re-found. */
function findRefs(text: string, o: Ctx, opts: { lenient?: boolean } = {}): { hits: string[]; near: string[]; total: number } {
  const res = runEngine(["snapshot"], o);
  if (res.status !== 0) {
    if (opts.lenient) return { hits: [], near: [], total: 0 };
    die((res.stderr || res.stdout).trim().split("\n")[0] || "could not read the page");
  }
  const items = parseEngineRefs(res.stdout);
  let hits = matchRefs(items, text);
  if (hits.length > 1) {
    const boxes = new Map<string, { width: number; height: number } | null>();
    for (const h of hits.slice(0, 5)) {
      const ref = h.line.match(REF_IN_LINE)?.[1];
      if (!ref) continue;
      try {
        const box = runEngineJson<{ width?: number; height?: number }>(["get", "box", `@${ref}`], o);
        boxes.set(h.line, box?.width !== undefined ? { width: box.width ?? 0, height: box.height ?? 0 } : null);
      } catch {
        boxes.set(h.line, null);
      }
    }
    const { ordered, hidden } = rankByVisibility(hits, (h) => boxes.get(h.line) ?? null);
    hits = ordered.map((h) => (hidden.has(h) ? { ...h, line: `${h.line}  (hidden)` } : h));
  }
  const near = hits.length ? [] : nearMatches(items, text);
  const ref = hits[0]?.line.match(REF_IN_LINE)?.[1];
  if (ref) rememberFind(o.session, `@${ref}`, text);
  return { hits: hits.map((h) => h.line), near: near.map((h) => h.line), total: items.length };
}

/** `shot`: screenshot to a file, inline in the conversation, optionally shared. */
async function takeShot(
  pathArg: string | undefined,
  o: { full?: boolean; annotate?: boolean; share?: boolean; alt?: string; inline?: boolean; selector?: string; extra?: string[] },
  c: Ctx,
  deps: PublishDeps,
): Promise<string> {
  const out = pathArg ?? path.join(os.tmpdir(), `cast-shot-${Date.now()}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const extra = [...(o.extra ?? [])];
  if (o.full) extra.push("--full-page");
  if (o.annotate) extra.push("--annotate");
  // The engine's screenshot takes `[selector] [path]`: a selector (or ref)
  // clips the capture to that element — one region readable at full size,
  // no post-hoc cropping.
  const target = o.selector ? [engineRef(quoteAttrValues(o.selector))] : [];
  const res = runEngine(["screenshot", ...target, out, ...extra], c);
  if (res.status !== 0) {
    die((res.stderr || res.stdout).trim().split("\n")[0] || "the screenshot failed");
  }
  if (!fs.existsSync(out)) die(`the engine reported success but wrote no file at ${out}`);

  // The legend mapping each [N] label to a snapshot ref is the point of an
  // annotated shot; it arrives on the engine's stdout.
  if (o.annotate) {
    for (const line of res.stdout.split("\n")) {
      if (line.trim() && !/screenshot saved/i.test(line)) console.log(line);
    }
  }

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
 * The script an `eval` should run, from wherever the agent put it: a
 * positional argument, `--file <path>`, `-b <base64>`, or (command form only)
 * `--stdin`. `stdinBody` is null inside a `do` flow, whose stdin is the plan.
 */
export function readEvalScript(args: string[], stdinBody: string | null): string {
  const fi = args.findIndex((a) => a === "--file" || a === "-f");
  if (fi >= 0) {
    const p = args[fi + 1];
    if (!p) throw new Error("--file needs a path");
    return fs.readFileSync(p, "utf-8");
  }
  const bi = args.findIndex((a) => a === "-b" || a === "--base64");
  if (bi >= 0) {
    const enc = args[bi + 1];
    if (!enc) throw new Error("-b needs a base64 string");
    return Buffer.from(enc, "base64").toString("utf-8");
  }
  if (args.includes("--stdin")) {
    if (stdinBody === null) throw new Error("--stdin is not available here — use --file or a quoted script");
    return stdinBody;
  }
  const positional = args.filter((a) => !a.startsWith("--") && a !== "-b" && a !== "-f");
  if (!positional.length) throw new Error("no script given");
  return positional.join(" ");
}

/** The index of the last page-changing step in a flow, or -1 when none is.
 *  Pure, so it is testable without a browser. */
export function lastMutatingIndex(steps: string[]): number {
  let last = -1;
  steps.forEach((raw, i) => {
    const [verb, ...rest] = tokenize(raw);
    if (verb && isMutatingStep(verb, rest)) last = i;
  });
  return last;
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
  // One auto shot per flow, after its LAST page-changing step: that is where
  // the flow landed, and the only frame anyone reads. Intermediate shots cost
  // context and are superseded within the same invocation.
  const lastShot = lastMutatingIndex(steps);
  for (const [i, raw] of steps.entries()) {
    const [verb, ...rest] = tokenize(raw);
    const args = [...rest, ...flowFlags];
    if (i !== lastShot && !args.includes("--no-shot")) args.push("--no-shot");
    if (!verb) continue;
    let ok = true;
    console.log(`${fmt.highlight("›")} ${raw}`);
    try {
      // The same table the standalone verbs read (cloneOnlyRefusal): a step
      // the real Chrome cannot take fails here, before anything touches it.
      const refused = cloneOnlyRefusal(verb, isRealSession(c.session));
      if (refused) throw new Error(`${refused.message} (${refused.hint})`);
      if (verb === "shot") {
        const si = args.findIndex((a) => a === "-s" || a === "--selector");
        const selector = si >= 0 ? args[si + 1] : undefined;
        const rest = si >= 0 ? args.filter((_, j) => j !== si && j !== si + 1) : args;
        await takeShot(rest.find((a) => !a.startsWith("--")), { full: args.includes("--full"), selector }, c, deps);
      } else if (verb === "eval") {
        const script = readEvalScript(rest, null);
        const out = await evalInPage(script, c);
        console.log(out.output);
        if (!out.ok) throw new Error(out.hint ?? "eval failed");
      } else if (verb === "find") {
        // The query is the step's own words — flow-level flags are not part
        // of what the agent asked to find.
        const query = rest.join(" ");
        const { hits, near, total } = findRefs(query, c);
        if (!hits.length) {
          const hint = near.length ? `; closest: ${near.slice(0, 3).join(", ")}` : "";
          throw new Error(`no element matching ${JSON.stringify(query)} (${total} refs on the page)${hint}`);
        }
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
  registerBridgeCommands(br, { me: auditOwner });

  // Any verb that reaches the page can be the one that starts this session's
  // daemon, and a daemon attaching with no live bound tab creates one in the
  // FOREGROUND — raising Chrome over the human's work. Bind a background tab
  // first (pinnedTab.ts). Verbs that never touch this session's page skip it,
  // and a clone-only verb asked for the real Chrome dies in ctxFor before a
  // tab is pinned in a browser it will then refuse.
  const NO_TAB_NEEDED = new Set(["start", "stop", "profiles", "shots", "dialogs", "audit", "target", "bridge-host"]);
  br.hook("preAction", async (_thisCommand, actionCommand) => {
    const verb = actionCommand.name();
    if (NO_TAB_NEEDED.has(verb) || actionCommand.parent !== br) return;
    await ensurePinnedTab((await ctxFor(verb, targetChoiceOf(actionCommand))).session);
  });

  for (const p of PASSTHROUGH) {
    const cmd = br
      .command(`${p.verb} ${p.args}`)
      .description(p.desc)
      .allowUnknownOption(true)
      .helpOption(false)
      .action((args: string[] = []) => {
        // helpOption is off so flags pass through, which makes --help one of
        // them — catch it here so it prints our help, not raw engine branding.
        if (args.includes("--help") || args.includes("-h")) {
          console.log(verbHelp(p));
          process.exit(0);
        }
        return passthrough(p.verb, args);
      });
    // What `cast browser help <verb>` prints: the engine's own flag docs,
    // reworded into our vocabulary — generated, so it cannot drift.
    cmd.helpInformation = () => `${verbHelp(p)}\n`;
  }

  // The flags that make browsing cheap, where an agent scanning the command
  // list will actually see them. Everything deeper is one `help <verb>` away.
  br.addHelpText(
    "after",
    `
The cheap-browsing loop — scope reads instead of dumping whole pages:

  cast browser open "https://mail.google.com/mail/u/0/#search/test"
  cast browser snapshot -i -s "div[role=main]"    # interactive refs in one region, not the app shell
  cast browser do "click #e920" "wait --text Changelog" "get text div.a3s"

  snapshot -i -s <sel>     only interactive elements, only that region
  read                     the page (or a URL) as clean text — "what does this page say"
  get text <sel>           one element's text, no eval needed
  text <sel>               same, in one word
  diff snapshot            only what changed since your last snapshot
  wait --text/--url/--fn   wait for the state you mean, not a fixed delay
  eval                     JavaScript in the page; promises are awaited (--stdin heredoc, --file <path>)
  grant                    camera/mic/clipboard permission for this origin — no prompt, no restart
  shot -s <sel>            screenshot ONE element (--annotate numbers refs on a full shot)

Your Chrome is the default once the extension is paired, including after restarts:

  target                   show which browser this session uses and why
  target clone             opt this session into the agent browser; target real switches back
  --real / --clone         override the browser for one verb
  open <url>               a tab of its own there, in the "Cast" tab group;
                           act only on tabs you opened. Needs the extension paired once by
                           the human: cast browser extension setup
                           Commands wait for reconnect; --clone explicitly uses the agent browser.

\`cast browser help <command>\` documents every flag; \`cast browser skills get core --full\` is the engine's full guide.`,
  );

  // Escape hatch: the engine gains verbs faster than this table does, and an
  // agent should never be blocked because we have not listed one yet.
  br.command("raw [args...]")
    .description("Pass a command straight to the browser engine")
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async (args: string[] = []) => {
      if (!args.length) die("raw needs a command", "e.g. cast browser raw profiler start");
      const t = await targetOf("raw", args);
      const res = runEngine(t.args, t.ctx);
      if (res.stdout) process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
      process.exit(res.status);
    });

  // -------------------------------------------------------------- screenshots

  targetFlags(br.command("shot [pathArg]"))
    .description("Screenshot the page — appears inline in this conversation (--annotate labels refs on it, -s clips to one element)")
    .option("-s, --selector <sel>", "Screenshot just this element (CSS selector or #eNN ref)")
    .option("--full", "Whole scroll height, not just the viewport")
    .option("--annotate", "Number every interactive element on the image; each [N] label is snapshot ref #eN, with a legend")
    .option("--share", "Also upload it and print a link you can paste elsewhere")
    .option("--alt <text>", "Caption for the shared image — say what it shows")
    .option("--no-inline", "Do not show the image in the conversation")
    .allowUnknownOption(true)
    .action(async (pathArg: string | undefined, o: any, cmd: any) => {
      // Anything we do not recognise belongs to the engine, not to us. Only
      // valueless flags can pass this way: commander cannot know an unknown
      // flag takes a value, so it would misread the value as the path.
      const extra = (cmd.args ?? []).filter((a: unknown) => typeof a === "string" && a.startsWith("--"));
      await takeShot(pathArg, { ...o, extra }, await ctx(o), deps);
    });

  targetFlags(br.command("do [steps...]"))
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

A step with no ref uses whatever the last \`find\` matched.
One auto screenshot per flow, after the last page-changing step — intermediate
frames are superseded before anyone reads them.`,
    )
    .action(async (steps: string[] = [], o: { keepGoing?: boolean; shot?: boolean; capture?: boolean } & TargetChoice) => {
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
      process.exit(await runFlow(plan, o, await ctx(o), deps));
    });

  // ------------------------------------------------------- compatibility verbs
  //
  // These four are in every CLAUDE.md already installed on every machine, so
  // they have to keep working whichever engine is driving. The engine spells
  // some of them differently and does not have `find` at all; that is our
  // problem to absorb, not something to push onto agents by rewriting prose
  // they have already read into their context.

  targetFlags(br.command("login [url]"))
    .description("A person signs in once: raises the agent browser on the page and waits until it leaves the sign-in page")
    .option("--wait <seconds>", "How long to wait for the sign-in; 0 returns at once", "300")
    .action(async (url: string | undefined, o: { wait: string } & TargetChoice) => {
      process.exit(await loginAsPerson(url, Math.max(0, parseInt(o.wait, 10) || 0), o));
    });

  br.command("sync [url]")
    .description("Carry your Chrome's current logins into the running agent browser: one site, or every site with no URL (Google excepted — it signs in on its own)")
    .action(async (url: string | undefined) => {
      await ensureBrowser();
      const state = readState();
      if (!state || state.remote || !state.sourceProfile) die("no local browser started from your Chrome profile", "`cast browser start` (without --fresh) first");
      const target = url ? (/^[a-z]+:/i.test(url) ? url : `https://${url}`) : null;
      const r = await provisionLocalLogins(state.port, target, { profileDir: state.sourceProfile, channel: state.channel });
      if (r.injected) {
        const where = r.sites ? `across ${r.sites} site${r.sites === 1 ? "" : "s"}` : `for ${r.host}`;
        const rej = r.rejected ? fmt.muted(` (${r.rejected} Chrome would not store)`) : "";
        console.log(`${OK} carried ${r.injected} cookie${r.injected === 1 ? "" : "s"} ${where} from your Chrome${rej}`);
      } else {
        console.log(`${fmt.muted(icons.dot)} nothing to carry for ${r.host}${r.reason ? ` — ${r.reason}` : ""}`);
      }
      console.log(fmt.muted("  `open` does this for the site it opens; a login on a sibling host needs this whole-jar sync or a URL on that host"));
    });

  targetFlags(br.command("tabs"))
    .description("List open tabs")
    .action(async (o: TargetChoice) => {
      const c = await ctx(o);
      const code = await runVerb("tab", ["list"], c);
      // Only this session's tabs are listed, and in real mode they sit among
      // the human's own: name where they are.
      if (code === 0 && isRealSession(c.session)) console.log(fmt.muted(`  in your real Chrome, via the cast extension${ownerKey() ? " — the other tabs there are the human's" : ""}`));
      process.exit(code);
    });

  targetFlags(br.command("find <text>"))
    .description("Find elements whose visible name matches")
    .action(async (text: string, o: TargetChoice) => {
      // The engine has no `find` of this shape. A snapshot already carries every
      // ref with its accessible name, so matching here costs one call and keeps
      // the verb — and remembers the match for a bare action to use.
      const { hits, near, total } = findRefs(text, await ctx(o));
      if (!hits.length) {
        console.log(`no element matching ${JSON.stringify(text)} (${total} refs on the page)`);
        if (near.length) {
          console.log("closest:");
          for (const h of near) console.log(`  ${h}`);
        }
        console.log(fmt.muted("see everything: cast browser snapshot"));
        process.exit(1);
      }
      for (const h of hits.slice(0, 25)) console.log(h);
      if (hits.length > 25) console.log(fmt.muted(`  … and ${hits.length - 25} more`));
    });

  const EVAL_HELP = `cast browser eval - Run JavaScript in this session's page

Usage: cast browser eval [options] [script]

Runs over CDP with promise support: a returned promise is AWAITED and its
settled value printed, and top-level \`await\` works. Multi-line scripts come
from a heredoc or a file — no quote escaping:

  cast browser eval "document.title"
  cast browser eval "await fetch('/api/health').then(r => r.status)"
  cast browser eval --stdin <<'EOF'
  const ds = await navigator.mediaDevices.enumerateDevices();
  ds.map(d => d.kind + ':' + d.label)
  EOF
  cast browser eval --file scenario.js

Options:
  --stdin           Read the script from stdin (heredoc)
  --file, -f <p>    Read the script from a file
  -b, --base64 <s>  Script as base64 (rarely needed now — heredocs work)
  --timeout <ms>    How long an awaited promise may take (default 15000)

A script that throws prints the page's exception and exits 1.`;

  const evalCmd = br.command("eval [script...]")
    .description("Run JavaScript in the page — promises are awaited (--stdin heredoc, --file <path>)")
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async (scriptArgs: string[] = []) => {
      if (scriptArgs.includes("--help") || scriptArgs.includes("-h")) {
        console.log(EVAL_HELP);
        process.exit(0);
      }
      const t = await targetOf("eval", scriptArgs);
      const c = t.ctx;
      scriptArgs = t.args;
      await ensureBrowser();
      await ensurePinnedTab(c.session);
      let stdinBody: string | null = null;
      if (scriptArgs.includes("--stdin")) {
        stdinBody = await new Promise<string>((resolve) => {
          let buf = "";
          process.stdin.setEncoding("utf-8");
          process.stdin.on("data", (d) => (buf += d));
          process.stdin.on("end", () => resolve(buf));
        });
      }
      const ti = scriptArgs.findIndex((a) => a === "--timeout");
      const timeout = ti >= 0 ? parseInt(scriptArgs[ti + 1] ?? "", 10) || 15_000 : 15_000;
      const rest = ti >= 0 ? scriptArgs.filter((_, i) => i !== ti && i !== ti + 1) : scriptArgs;
      let script: string;
      try {
        script = readEvalScript(rest, stdinBody);
      } catch (err) {
        die((err as Error).message);
      }
      const out = await evalInPage(script, c, timeout);
      console.log(out.output);
      if (!out.ok && out.hint) console.log(fmt.muted(`  ${out.hint}`));
      process.exit(out.ok ? 0 : 1);
    });
  evalCmd.helpInformation = () => `${EVAL_HELP}\n`;

  targetFlags(br.command("grant [permissions...]"))
    .description("Grant browser permissions to the current origin, no prompt, no restart (default: camera microphone)")
    .option("--origin <origin>", "Grant to this origin instead of the current tab's")
    .option("--reset", "Reset ALL granted permissions to defaults")
    .addHelpText(
      "after",
      `
The permission prompt an agent cannot see simply never appears; getUserMedia
resolves with the real device. Names: camera, microphone, clipboard,
notifications, geolocation, midi — or any raw CDP PermissionType.

  cast browser grant                          # camera + microphone, current origin
  cast browser grant clipboard --origin https://app.example.com
  cast browser grant --reset

A machine with no camera still needs fake devices at launch:
\`cast browser start --fake-media\` (restart — coordinate, it closes other
sessions' tabs).`,
    )
    .action(async (permissions: string[] = [], o: { origin?: string; reset?: boolean } & TargetChoice) => {
      const c = await ctxFor("grant", o);
      await ensureBrowser();
      await ensurePinnedTab(c.session);
      const out = await grantPermissions(permissions, c, o);
      console.log(`${out.ok ? OK : BAD} ${out.output}`);
      if (out.hint) console.log(fmt.muted(`  ${out.hint}`));
      process.exit(out.ok ? 0 : 1);
    });

  targetFlags(br.command("viewport [size]"))
    .description("Resize the page, or emulate a device: desktop, laptop, wide, tablet, mobile, mobile-small")
    .option("--reset", "Back to the default size")
    .action(async (size: string | undefined, o: { reset?: boolean } & TargetChoice) => {
      const c = await ctx(o);
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
    .option("--fake-media", "Fake camera/mic devices (test pattern + tone) — for machines without real ones; permission prompts are auto-accepted")
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
      const swept = describeReap(await reapEngineOrphans({ force: true, keep: session }));
      if (swept) console.log(fmt.muted(`  ${swept}`));

      await startManagedBrowser({ ...DEFAULT_START, ...o });
      console.log(fmt.muted(`  this session drives its own tab in it — session ${session}`));
    });

  targetFlags(br.command("status"))
    .description("What the browser is doing")
    .action(async (o: TargetChoice) => {
      const binary = findEngine();
      const state = readState();
      const c = await ctx(o);
      const real = isRealSession(c.session);
      // Real mode has no managed browser behind it: the human's Chrome is
      // the browser, and the bridge is what can be up or down.
      if (!binary || (!state && !real)) {
        console.log(`${fmt.muted(icons.dot)} not set up yet — run \`cast browser start\``);
        return;
      }
      let alive = true;
      if (real) {
        console.log(`${OK} real Chrome via the bridge on ${new URL(c.cdp!).host} — \`cast browser extension status\` says whether it is connected`);
      } else if (state) {
        alive = isPidAlive(state.pid);
        console.log(`${alive ? OK : BAD} browser ${alive ? "up" : "gone"} — pid ${state.pid}, CDP 127.0.0.1:${state.port}${state.headless ? ", headless" : ""}${state.fakeMedia ? ", fake media devices" : ""}`);
      }
      console.log(`  engine: ${ENGINE_PACKAGE} ${engineVersion() ?? "?"}  ${fmt.muted(binary)}`);
      console.log(`  session: ${c.session}`);
      if (!real && state) {
        console.log(`  profile: ${state.sourceProfile ? `${state.sourceProfile} (logins inherited; Google is its own — \`cast browser login\` once)` : "fresh — signed out"}`);
      }
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

  targetFlags(br.command("stop"))
    .description("Close this session's tab; --all closes every session's and the browser")
    .option("--all", "Close every session's tab and the browser itself")
    .option("--wipe", "With --all: also remove the cloned profile")
    .action(async (o: { all?: boolean; wipe?: boolean } & TargetChoice) => {
      const { session } = await ctx(o);
      // Detach the engine and close the tab it was pinned to; the browser
      // stays for everyone else.
      await closeSessionTab(session);
      console.log(`${OK} closed this session's tab`);
      const swept = describeReap(await reapEngineOrphans({ force: true, keep: o.all ? null : session, idleMs: o.all ? 0 : undefined }));
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
    .description("Automatic screenshots after page-changing commands: on | off | default | status")
    .action((mode?: string) => {
      if (!mode || mode === "status") {
        console.log(
          autoShotsEnabled()
            ? `${OK} auto screenshots are on — page-changing commands inline a small capture (\`--no-shot\` skips one)`
            : `${fmt.muted(icons.dot)} auto screenshots are off${ownerKey() ? " (the default for agent sessions)" : ""} — \`cast browser shots on\` enables them`,
        );
        return;
      }
      if (mode === "default") {
        clearAutoShots();
        console.log(`${OK} auto screenshots follow the default again: on at a terminal, off for agent sessions`);
        return;
      }
      if (mode !== "on" && mode !== "off") die(`'${mode}' is not a mode`, "use: cast browser shots on | off | default | status");
      setAutoShots(mode === "on");
      console.log(`${OK} auto screenshots ${mode} (machine-wide; \`cast browser shots default\` restores the per-audience default)`);
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
