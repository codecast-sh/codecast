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
import * as path from "node:path";
import { Option, type Command } from "commander";
import {
  ENGINE_PACKAGE, engineHelpText, engineHome, engineSession, ownerOfSessionKey, requestTabName, tabNameOf, engineTabs, engineVersion, ensureEngine, findEngine, isPaneSession, isRealSession,
  parseEngineJson, realSessionKey, runEngine, runEngineJson, type EngineRun,
} from "./engine.js";
import { engineBrowserFor, isPaneMode, isRealMode, realModeHint, requireRealBridge, splitTargetFlags, walledOffFromExtension } from "./bridge/real.js";
import { desktopPaneCtx, DesktopPaneUnavailable, PANE_TAB_NOTE } from "./desktopPane.js";
import { modelJudge, registerBrowserSubscriptions, type BrowserSubDeps } from "./subscribe.js";
import { registerHandoffCommand } from "./handoff.js";
import { currentSession } from "@platform/cli-kit/subscribe";
import { bridgeEndpoint, grantTab, requestBrowserProfile } from "./bridge/host.js";
import { readCdpJson, listTargets, type CdpEndpoint } from "./cdp.js";
import { BROWSER_START_HELP, prepareRealBrowserStart, registerBridgeCommands, targetFlags } from "./bridge/commands.js";
import { closeSessionTab, describeReap, detachSessionDaemon, listEngineSessions, reapEngineOrphans, scanLiveOwners, withEndedSession } from "./engineReap.js";
import { engineSnapshotJson, type EngineSnapshotPayload, matchRefs, nearMatches, ordinal, pickOrdinal, refLabel, splitOrdinalQuery } from "./snapshot.js";
import { type EngineRef, parseEngineRefs, rankByVisibility, withOrdinals } from "./engineRefs.js";
import {
  isStaleRefFailure, preflightRefPlan, recallSnapshotRef, recoverRefPlan, rememberedSnapshotUrl, rememberSnapshotRefs, SNAPSHOT_AGAIN,
} from "./refMemory.js";
import { redactHarFile, redactSnapshotOutput } from "./redaction.js";
import { captureSettled, type PageStamp, parseSettleProbe, settleProbeSource, sleepSync } from "./snapshotSettle.js";
import {
  awaitChallenge, CHALLENGE_PROBE_SOURCE, challengeReport, challengeWaitMs, parseChallengeProbe, type ChallengeOutcome, type ChallengeProbe,
} from "./challenge.js";
import { ensurePinnedTab, pinnedTabBrowser, readBoundTarget, recoverGoneTab, touchBoundTarget } from "./pinnedTab.js";
import { markChallengedTab } from "./humanInput.js";
import { tabIdOfTarget } from "./bridge/protocol.js";
import { retryOnStall, shouldRetryAfterStall, STALL_NOTE, STALL_RETRY_DELAY_MS } from "./stall.js";
import { formatBytes, keepsOwnLogin, listRealProfiles } from "./profile.js";
import { DEFAULT_START, startLocalBrowser, startManagedBrowser, stopRemoteManagedBrowser, type StartOptions } from "./managedBrowser.js";
import { hideCloneControls, registerAdvancedClone } from "./advanced.js";
import { clearState, probeLiveness, readState, stopInstance, writeState } from "./instance.js";
import { provisionLocalLogins } from "./credentials.js";
import { isPidAlive } from "../workspace/chrome.js";
import { authorizesTeardown } from "@codecast/shared/contracts";
import { auditExplicitLoads, auditLanding, browserJarRead, NAVIGATING_VERBS, refuseNavigation, signInHost, signInLandingNote, urlsLoadedBy, vaultJarRefusal, viaFor, webAuthnRefusal } from "./siteGuard.js";
import { focusBrowserTabBlocking } from "./focusHttp.js";
import { emitFailureBlock, engineSource } from "./capture.js";
import { registerAuditCommand } from "./auditCommand.js";
import { autoShotsEnabled, clearAutoShots, isMutatingStep, maybeAutoShot, setAutoShots, type AutoShotSource } from "./autoShot.js";
import { opensATab, tabFooterLines, TAB_AFFECTING_VERBS, TAB_CLEANUP_NOTE } from "./tabFooter.js";
import { tokenize } from "./batch.js";
import { readStepPlan } from "../stepBatch.js";
import { armVerbDeadline, deadlineSeconds, DEADLINE_ENV, DEFAULT_DEADLINE_S, setStage } from "./deadline.js";
import { captureFullPage, evalInPage, grantPermissions, type PageCtx } from "./pageEval.js";
import { ownerKey } from "./owner.js";
import { runBrowserSync, DEFAULT_SYNC_WAIT_S } from "./sync.js";
import { cloudHostSignInHint } from "../cloud/browserSync.js";
import { isRemoteDevice } from "../remote/device.js";
import { inlineImageMarker } from "../inlineImage.js";
import { defaultShotPath, imageSize, shotJson, SHOT_TEMP_KIND } from "./shotFile.js";
import { agentTempPath, secureTempFile } from "../tempFiles.js";
import { uploadOne } from "../imageCommand.js";
import { MAX_IMAGE_SIZE } from "../syncService.js";
import type { PublishDeps } from "../castApi.js";
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

export interface TargetChoice {
  real?: boolean;
  clone?: boolean;
  /** The desktop app's pane opened for this session (desktopPane.ts). */
  pane?: boolean;
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
  sync: "the human's Chrome already has its own cookies",
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
    hint: "Continue in the human's Chrome. Sign-ins and permission prompts there need the human; a separate browser requires their permission.",
  };
}

/**
 * Options every engine call carries: this session, and the browser it drives.
 * Real mode (bridge/real.ts isRealMode) is the ordinary default: a
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
  const session = engineSession(detectSessionId);
  const owner = auditOwner();
  if (isPaneMode(choice, owner)) {
    // The desktop pane: a `-pane` session key on the app's own CDP socket,
    // pinned to the pane the human opened for this session. A pane that was
    // closed is said once, and the verb goes on in the session's ordinary
    // browser; a session that never had one, or a machine without the app,
    // stops here with the one thing an agent can do about it.
    try {
      return await desktopPaneCtx(owner);
    } catch (err) {
      const unavailable = err instanceof DesktopPaneUnavailable ? err : null;
      if (!unavailable || unavailable.reason !== "closed") die((err as Error).message, unavailable?.hint);
      console.log(`${fmt.warning("!")} ${unavailable.message} — continuing in the human's Chrome`);
      choice = { ...choice, pane: false };
    }
  }
  if (!isRealMode(choice, owner)) return { session };
  try {
    setStage("connecting to the human's Chrome through the extension");
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

function targetChoiceOf(cmd: Command): TargetChoice {
  const o = cmd.opts() as TargetChoice;
  const raw = splitTargetFlags(cmd.args);
  return { real: o.real || raw.real, clone: o.clone || raw.clone, pane: o.pane || raw.pane };
}

/**
 * A passthrough verb's browser and its own arguments, from a raw argument
 * list that may carry `--real` or the retired `--clone` flag, which is rejected.
 */
async function targetOf(verb: string, args: string[]): Promise<{ ctx: Ctx; args: string[] }> {
  const t = splitTargetFlags(args);
  return { ctx: await ctxFor(verb, t), args: t.args };
}

/**
 * Make sure the managed browser is up before a verb needs it. `open` is where
 * a session's browsing begins, so it starts the browser when there is none —
 * quietly, behind the human's windows, reusing the profile clone. A live pid
 * is not a working browser: the probe replaces one that is provably hung, and
 * leaves a merely slow one for the verb to report.
 */
async function ensureBrowser(c: Ctx): Promise<void> {
  if (isRealSession(c.session) || isPaneSession(c.session)) return;
  if (!authorizesTeardown(await probeLiveness(readState()))) return;
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
      const out = agentTempPath(SHOT_TEMP_KIND, `cast-autoshot-${process.pid}.jpg`);
      const res = runEngine(["screenshot", out, "--screenshot-format", "jpeg", "--screenshot-quality", "60"], {
        ...o,
        timeoutMs: 20_000,
      });
      if (res.status !== 0) throw new Error(res.stderr || "screenshot failed");
      secureTempFile(out);
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
  { verb: "snapshot", args: "[args...]", desc: "The page as an accessibility tree with refs (-i interactive only, -s <sel> scope, -c compact, -d <n> depth, -u link urls, --redact-values hides every field value (passwords and codes always are), --json for {url, refs, text})" },
  { verb: "read", args: "[args...]", desc: 'The page, or a URL, as clean readable text (--outline, --filter <text>) — best for "what does this page say"' },
  { verb: "click", args: "[args...]", desc: "Click an element (#e42 ref or CSS selector)" },
  { verb: "type", args: "[args...]", desc: "Type into an element (--submit presses Enter after; --vault <name>[/field] or --stdin for a secret)" },
  { verb: "fill", args: "[args...]", desc: "Clear a field and fill it (--vault <name>[/username|/otp] types a Vault login unseen, --stdin a piped value)" },
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
  --tab <name>   A tab of your own under this name: parallel workers sharing one session each pass one
  --no-shot      Skip the automatic screenshot after a page-changing command
  --no-capture   Skip the failure context (console, network, screenshot) when a step fails`;

/** What `type` and `fill` add for a value that must never be an argument (secretInput.ts). */
const SECRET_INPUT_HELP = `A secret, never as an argument (ps and the transcript would keep it):
  --vault <name>[/field]   type a Vault value without seeing it: a login's password by default,
                           /username, /otp (its current 2FA code), /value (a key). Typed only on
                           a site the secret names, over https (cast vault show <name> lists them)
  --stdin                  the value from a pipe: cast vault get <name> | cast browser fill #e3 --stdin
  Any other --flag is an error; text that starts with -- goes after a bare --.

  cast browser fill #e12 --vault acme-login/username
  cast browser fill #e13 --vault acme-login --submit
  cast browser fill #e20 --vault acme-login/otp`;

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
  const secret = p.verb === "type" || p.verb === "fill" ? `\n\n${SECRET_INPUT_HELP}` : "";
  if (!raw) {
    return (
      `Usage: cast browser ${p.verb} [args...]\n\n${p.desc}\n\n` +
      `(run \`cast browser start\` once to install the engine — the per-flag help comes from it)${secret}\n\n${CAST_HELP_EXTRAS}`
    );
  }
  const body = castVoice(raw)
    .replace(new RegExp(`\\bcast browser ${engineVerb}\\b`, "g"), `cast browser ${p.verb}`)
    // cast picks the engine session itself (one per agent session); the
    // engine's own --session would point a verb at another agent's tab.
    // `--pin-tab` likewise: cast pins every session to its own tab already,
    // and recovers a closed one itself.
    .replace(/^[ \t]*--(?:session <name>|pin-tab\b).*\n?/gm, "")
    .replace(/\n[^\n]*remembers its active tab[\s\S]*?--no-pin-tab[^\n]*\n/, "");
  return `${body}${secret}\n\n${CAST_HELP_EXTRAS}`;
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

/**
 * A viewport argument as a width and height: a preset, `WxH` (also `W*H`,
 * `W,H`), or a bare width, which takes a preset's height when one has that
 * width and 900 otherwise. Null when it is none of those. Pure.
 */
export function parseViewportSize(size: string): { width: number; height: number; preset?: string } | null {
  const preset = VIEWPORTS[size];
  if (preset) return { width: preset[0], height: preset[1], preset: size };
  const explicit = /^(\d{2,5})\s*[x×*,]\s*(\d{2,5})$/i.exec(size.trim());
  if (explicit) return { width: parseInt(explicit[1]!, 10), height: parseInt(explicit[2]!, 10) };
  if (/^\d{2,5}$/.test(size.trim())) {
    const width = parseInt(size, 10);
    const match = Object.values(VIEWPORTS).find(([w]) => w === width);
    return { width, height: match ? match[1] : 900 };
  }
  return null;
}

/** Where a size asked for before any page is open waits for the next `open`. */
function pendingViewportPath(session: string): string {
  return path.join(engineHome(), "sessions", session, "viewport");
}

/**
 * `viewport <size>`, for the command and for a `do` step alike. With no page
 * open yet, the size is kept and the next `open` applies it, rather than
 * failing and leaving every later screenshot at the default size.
 */
async function setViewport(size: string, c: Ctx): Promise<{ ok: true; lines: string[] } | { ok: false; message: string; hint?: string }> {
  const parsed = size === "reset" ? { width: 1440, height: 900 } : parseViewportSize(size);
  if (!parsed) return { ok: false, message: `unknown size '${size}'`, hint: `use a preset (${Object.keys(VIEWPORTS).join(", ")}), WxH like 1440x900, or a width like 1440` };
  const { width, height } = parsed;
  const label = size === "reset" ? "viewport reset" : `${parsed.preset ? `${parsed.preset}: ` : ""}${width}x${height}`;
  const pinned = await ensurePinnedTab(c.session).then(() => null, (err: Error) => err);
  if (pinned && !/no open page/.test(pinned.message)) return { ok: false, message: pinned.message };
  if (pinned) {
    const file = pendingViewportPath(c.session);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${width} ${height}`);
    return { ok: true, lines: [`${OK} ${label}, applied when \`cast browser open\` opens this session's page`] };
  }
  const res = runEngine(["set", "viewport", String(width), String(height)], c);
  if (res.status !== 0) return { ok: false, message: castVoice((res.stderr || res.stdout).trim().split("\n")[0] || "could not resize") };
  const lines = [`${OK} ${label}`];
  // Say it plainly: a "mobile" page that is secretly non-touch can show a
  // hover menu no real phone would ever render.
  if (parsed.preset && MOBILE_PRESETS.has(parsed.preset)) lines.push(fmt.muted("  (size only — touch is not emulated, so hover-only menus still open)"));
  return { ok: true, lines };
}

/** The size a `viewport` before the first `open` asked for, applied now that
 *  the tab exists. A courtesy: the open goes on whatever happens. */
function applyPendingViewport(c: Ctx): void {
  const file = pendingViewportPath(c.session);
  let size: string;
  try {
    size = fs.readFileSync(file, "utf-8").trim();
  } catch {
    return;
  }
  fs.rmSync(file, { force: true });
  const [w, h] = size.split(/\s+/);
  if (w && h) runEngine(["set", "viewport", w, h], c);
}


/** The calling codecast session, for the audit trail — same key the built-in
 *  driver stamps, so `cast browser audit` reads one trail whichever engine drove. */
let auditOwner: () => string | null = () => ownerKey();
/** Same detector `auditOwner` uses, so the engine session key and the audit
 *  trail name one agent. Unset until registerEngineCommands. */
let detectSessionId: (() => string | null) | undefined;
/** For the verbs that read the Vault (type/fill --vault). Unset until registerEngineCommands. */
let engineDeps: PublishDeps | undefined;

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

/** `tab ls` and `tab rm <id>`, the shell spellings, in the engine's words.
 *  Unmapped, the engine reads `ls` as a tab label and fails. */
export function normalizeTabArgs(args: string[]): string[] {
  const op = ({ ls: "list", rm: "close" } as Record<string, string>)[args[0] ?? ""];
  return op ? [op, ...args.slice(1)] : args;
}

/** Engine text in cast's words: its messages name its own binary
 *  ("run `agent-browser tab`"), which agents must never run. */
export function castVoice(text: string): string {
  return text.replace(/\bagent-browser\b/g, "cast browser");
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

  // `tab switch <ref>` is the footer's wording; the engine switches on a bare
  // `tab <ref>` and reads `switch` as a tab label.
  if (verb === "tab" && a[0] === "switch") return [{ args: ["tab", ...a.slice(1)] }];
  if (verb === "tab") a = normalizeTabArgs(a);

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
  /** The pause before the one stall retry; tests shorten it. */
  stallRetryDelayMs?: number;
}

/** What a verb's engine run is waiting on, for the narration while it runs long. */
export function engineStepLabel(verb: string, engineArgs: string[]): string {
  const url = engineArgs.slice(1).find((x) => /^[a-z]+:\/\//i.test(x));
  if (verb === "open") return `opening ${url ?? "the page"} in Chrome (attach, navigate, load)`;
  return `waiting for the browser to finish \`${verb}\``;
}

/** The URL of this session's tab, as the engine reports it. */
function tabUrl(o: Ctx): string | null {
  const tabs = engineTabs(o);
  return (tabs.find((t) => t.active) ?? tabs[0])?.url ?? null;
}

/**
 * The gates an engine command passes before it runs, ours or `raw`: no CDP
 * WebAuthn method (an agent minting a passkey); every URL
 * it loads by itself (`open`, `read <url>`, `tab new <url>`, …) against the
 * site policy and the Vault page, so a refused page has no side door; and a
 * cookie or storage read that would hand this session an Ask first sign-in it
 * holds no approval for, in either Chrome (signInOnOpen loads into both). The
 * desktop pane never holds one.
 */
function refuseEngineCommand(verb: string, args: string[], o: Ctx, owner: string | null): void {
  const passkey = webAuthnRefusal(verb, args);
  if (passkey) die(passkey.message, passkey.hint);
  for (const url of urlsLoadedBy(verb, args, () => tabUrl(o))) {
    const deny = refuseNavigation(url, owner, "open");
    if (deny) die(deny.message, deny.hint);
  }
  const read = isPaneSession(o.session) ? null : browserJarRead(verb, args);
  const deny = read && vaultJarRefusal(read, read === "page" ? tabUrl(o) : null, detectSessionId?.() ?? null);
  if (deny) die(deny.message, deny.hint);
}

/**
 * `type`/`fill`: unknown flags are refused (the engine would type them as
 * text), and a `--vault` or `--stdin` value goes in over CDP, never as an
 * engine argument (secretInput.ts). Null means plain text for the engine.
 */
async function typeFromSecretSource(verb: string, args: string[], o: Ctx, run: RunOptions): Promise<number | null> {
  const { parseTypeArgs, runSecretInput } = await import("./secretInput.js");
  const parsed = parseTypeArgs(verb, args, recallFind(o.session));
  const fail = (message: string, hint?: string): never => {
    if (run.quiet) throw new Error(hint ? `${message} (${hint})` : message);
    die(message, hint);
  };
  if ("error" in parsed) return fail(parsed.error, parsed.hint);
  if (parsed.mode === "text") return null;
  if (parsed.mode === "stdin" && run.quiet) return fail("--stdin is not read inside `do`", `run \`cast browser ${verb} <target> --stdin\` as its own command`);
  if (!engineDeps) return fail("cast browser is not set up to read the Vault here");
  try {
    console.log(await runSecretInput(verb, parsed, o, engineDeps));
  } catch (err) {
    const { refusalText } = await import("./secretType.js");
    return fail(refusalText(err));
  }
  return parsed.submit ? runVerb("press", ["Enter", ...parsed.stepFlags], o, run) : 0;
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
  // The desktop pane is the human's view: nothing is started, carried or
  // reaped for it, and the engine only ever drives the target it was pinned to.
  const pane = isPaneSession(session);
  // Whichever browser this verb drives is the one the watch stream follows.
  touchBoundTarget(session);

  if (verb === "tab") args = normalizeTabArgs(args);
  if (verb === "tab" && opensATab(verb, args, false)) openedTab = true;
  if (verb === "tab" && real) {
    const ref = args[/^(close|switch)$/.test(args[0] ?? "") ? 1 : 0];
    if (ref && /^[0-9a-f]{8}$/i.test(ref)) await grantTab(await requireRealBridge(), session, ref.toUpperCase());
  }

  refuseEngineCommand(verb, args, o, owner);

  if (verb === "type" || verb === "fill") {
    const typed = await typeFromSecretSource(verb, args, o, run);
    if (typed !== null) return typed;
  }

  if (verb === "open") {
    const url = args.find((a) => !a.startsWith("--"));
    const wall = real && url ? walledOffFromExtension(url) : null;
    if (wall) die(wall, "the human opens this page in their own Chrome; hand them the URL and the steps.");
    // The real Chrome is the human's, already running; its bridge came up in
    // ctx. The clone is ours to start.
    await ensureBrowser(o);
    // Close abandoned tabs first so a reclaim cannot pick a dead session's
    // target and then have the reaper close it out from under us.
    // In the human's Chrome too: a dead session's Cast tab left open keeps
    // reloading against the dev server and piles up in their tab strip
    // (2026-09-17: ninety two bindings, sixteen live sessions). The reaper
    // closes only tabs whose owner is gone, never this session's own, and
    // never a tab the human opened. A pane is the human's view: untouched.
    const swept = pane ? "" : describeReap(await reapEngineOrphans({ keep: session }));
    if (swept) console.log(fmt.muted(`  ${swept}`));
    // The pre-action hook ran before the browser existed on a cold start;
    // now that it does, bind this session's tab quietly (pinnedTab.ts).
    const created = await ensurePinnedTab(session, url && (/^[a-z]+:/i.test(url) ? url : `https://${url}`));
    if (opensATab(verb, args, created)) openedTab = true;
    if (created) args = args.filter((arg) => arg !== "--new-tab");
    applyPendingViewport(o);
    // Your logins for this site, as your real Chrome holds them right now —
    // the clone the browser started from may be hours old (credentials.ts).
    if (url && !real && !pane) await carryLogins(url);
    // Then a sign-in the team saved in the Vault, where the browser still has
    // none for the site, in whichever Chrome this session drives: the human's
    // own through the bridge, or the agent browser (on a cloud host, the one
    // that applies). The desktop pane is the human's view and gets none.
    if (url && !pane) await useVaultSignin(url, real ? bridgeEndpoint(await requireRealBridge()) : undefined);
  } else {
    await ensurePinnedTab(session);
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
      const find = (tabs: ReturnType<typeof engineTabs>) =>
        tabs.find((t) => t.targetId.toLowerCase().startsWith(q)) ??
        tabs.find((t) => (t.url ?? "").toLowerCase().includes(q));
      const hit = find(engineTabs(o));
      if (hit) args = [...args.slice(0, at), hit.tabId || hit.targetId, ...args.slice(at + 1)];
    }
  }

  // Ours, never the engine's. `skills` never touches a page, so a failure
  // there gets no page evidence either way.
  const capture = !args.includes("--no-capture") && verb !== "skills";
  const shot = !args.includes("--no-shot");
  // `--redact-values` hides every field value in a snapshot, not only
  // passwords and codes (redaction.ts); ours, never forwarded.
  const redactValues = args.includes("--redact-values");
  const forwarded = args.filter((a) => a !== "--no-capture" && a !== "--no-shot" && a !== "--redact-values");

  // Did translate() have to reach for the last find? Then the remembered words
  // are also available to a stale-ref retry, as a fallback behind the ordinal.
  const positionals = forwarded.filter((x) => !x.startsWith("--")).length;
  const usedLastFind =
    TARGETED.has(verb) && (TARGET_PLUS_VALUE.has(verb) ? positionals === 1 : positionals === 0);

  const calls = translate(verb, forwarded, recallFind(session));
  const verbStarted = Date.now();
  let retried = false;
  let retriedStall = false;
  let retriedAttach = false;
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    // A snapshot is read until it describes one settled page (snapshotSettle.ts),
    // and the page it was read on goes into the ref table with it.
    let snapPage: PageStamp | null = null;
    let res: EngineRun;
    const target = call.args.find((x) => /^@e\d+$/.test(x));
    const refused = call.args[0] !== "snapshot" && target ? refuseShiftedRef(target, o) : null;
    if (refused) {
      res = { status: 1, stdout: "", stderr: `${target!.replace("@", "#")} was not used: ${refused}\n` };
    } else if (call.args[0] === "snapshot") {
      const snap = settledSnapshot(call.args, o, redactValues);
      res = snap.res;
      snapPage = snap.page;
    } else {
      res = await runEngine(call.args, { ...o, narrate: engineStepLabel(verb, call.args) });
    }
    // A ref the engine cannot resolve any more — the page re-rendered, or the
    // route changed since the snapshot. Re-find it and retry once. Gated on
    // the engine's own "no such element" wording, because a retry re-runs the
    // command and must never follow a failure that already touched the page.
    if (!refused && res.status !== 0 && target && !retried && i === 0 && isStaleRefFailure(res.stderr + res.stdout)) {
      retried = true;
      const again = recoverStaleRef(target, o, usedLastFind ? recallFindQuery(session) : null);
      if ("ref" in again) {
        console.log(fmt.muted(`  ${again.note}`));
        res = runEngine(call.args.map((x) => (x === target ? again.ref : x)), o);
      } else {
        res = { ...res, stderr: `${(res.stderr || res.stdout).trim().split("\n")[0]}\n  ${target.replace("@", "#")} went stale and was not retried: ${again.refused}\n` };
      }
    }
    // The session is pinned to one tab. When that tab is gone (closed by the
    // human, by `tab close`, or by a reap of an earlier incarnation of this
    // session), the daemon is moved to whatever the binding names now: another
    // tab of this session's, or for `open` a fresh one. tab_gone means the
    // engine never reached a page, so running the verb again repeats nothing.
    // Only a session with no tab left is asked to open first.
    if (res.status !== 0 && /tab_gone/.test(res.stderr + res.stdout)) {
      const open = call.args[0] === "open";
      const goneUrl = open ? call.args.slice(1).find((a) => a && !a.startsWith("-")) : undefined;
      const live = await recoverGoneTab(session, goneUrl && (/^[a-z]+:/i.test(goneUrl) ? goneUrl : `https://${goneUrl}`));
      if (open || live) res = await runEngine(call.args, { ...o, narrate: engineStepLabel(verb, call.args) });
      if (!open && res.status !== 0 && /tab_gone/.test(res.stderr + res.stdout)) {
        res = { ...res, stderr: `this session's tab is gone — \`cast browser open <url>\` starts a new one\n`, stdout: "" };
      }
    }
    // Chrome refused to attach to this session's tab (Target.attachToTarget:
    // "Cannot attach to this target"). The engine never reached the page, so
    // running again repeats nothing. An `open` does what `stop` then `open`
    // did by hand: close the tab and start on a fresh one. Any other verb lets
    // the daemon go and attaches again once, keeping the page it was on.
    if (res.status !== 0 && !retriedAttach && isUnattachableTab(res.stderr + res.stdout)) {
      retriedAttach = true;
      const opening = call.args[0] === "open";
      if (opening) {
        await closeSessionTab(session).catch(() => false);
        const url = call.args.slice(1).find((a) => a && !a.startsWith("-"));
        if (url) await ensurePinnedTab(session, /^[a-z]+:/i.test(url) ? url : `https://${url}`).then((made) => { if (made) openedTab = true; }, () => false);
      } else {
        detachSessionDaemon(session);
      }
      res = await runEngine(call.args, { ...o, narrate: engineStepLabel(verb, call.args) });
      if (res.status !== 0 && isUnattachableTab(res.stderr + res.stdout)) {
        res = { ...res, stdout: "", stderr: `${UNATTACHABLE_NOTE}\n` };
      }
    }
    // The bridge stalled before the verb reached the page: the extension's
    // process was not scheduled. Once, after a pause, the same verb again;
    // the human should see a slow command, not a failed one.
    if (res.status !== 0 && !retriedStall && shouldRetryAfterStall(verb, res.stderr + res.stdout)) {
      retriedStall = true;
      console.error(fmt.muted(`  ${STALL_NOTE}`));
      await new Promise((r) => setTimeout(r, run.stallRetryDelayMs ?? STALL_RETRY_DELAY_MS));
      res = await runEngine(call.args, { ...o, narrate: engineStepLabel(verb, call.args) });
    }
    // A snapshot is the one output we rewrite: names that repeat get their
    // ordinal so the agent can say which one it means, and the ref table is
    // remembered so a stale ref can be recovered by it (refMemory.ts).
    if (res.status === 0 && res.stdout && call.args[0] === "snapshot") {
      if (call.args.includes("--json")) {
        const snapshot = engineSnapshotJson(parseEngineJson<EngineSnapshotPayload>(res));
        const items = parseEngineRefs(snapshot.text);
        rememberSnapshotRefs(session, items, snapPage, snapshotScope(call.args));
        snapshot.text = withOrdinals(snapshot.text, items);
        res = { ...res, stdout: JSON.stringify(snapshot) + "\n" };
      } else {
        const items = parseEngineRefs(res.stdout);
        if (items.length) rememberSnapshotRefs(session, items, snapPage, snapshotScope(call.args));
        res = { ...res, stdout: withOrdinals(res.stdout, items) };
      }
    }
    if (res.status === 0 && call.args[0] === "network" && call.args[1] === "har" && call.args[2] === "stop") {
      res = { ...res, stdout: res.stdout + redactHarNote(call.args.slice(3), res.stdout) };
    }
    res = { ...res, stdout: castVoice(res.stdout), stderr: castVoice(res.stderr) };
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    if (res.status !== 0) {
      const msg = engineFailureMessage(res.stderr, res.stdout);
      await emitFailureBlock(engineSource(o), msg, { disabled: !capture });
      return res.status;
    }
  }

  // `tab new <url>`, `read <url>`, `pushstate`: loads the footer's landing audit never sees.
  auditExplicitLoads(verb, args, `engine:${o.session}`, owner, () => tabUrl(o));

  const mutating = isMutatingStep(verb, forwarded);
  if (mutating) settle(o);
  // Keystrokes into a field never navigate; only a page load or a mutating
  // step (which already paid for settle) pays for the probe.
  const challenge = LOADS_A_PAGE.has(verb) || (mutating && NAVIGATING_VERBS.has(verb)) ? await checkChallenge(verb, o, verbStarted) : null;
  if (mutating) {
    const file = await maybeAutoShot(engineAutoShotSource(o), shot);
    if (file) console.log(inlineImageMarker(file));
  }
  if (!run.quiet && (TAB_AFFECTING_VERBS.has(verb) || NAVIGATING_VERBS.has(verb))) {
    printFooter(o, verb, owner);
  }
  return challenge && !challenge.cleared ? 1 : 0;
}

/**
 * The HAR the engine just wrote, rewritten with every credential replaced by
 * a placeholder before anyone reads it (redaction.ts). The path is the one
 * asked for, else the one the engine reports. A file that cannot be read as a
 * HAR is said plainly, never passed off as redacted.
 */
function redactHarNote(rest: string[], stdout: string): string {
  const asked = rest.find((a) => !a.startsWith("-"));
  const reported = /(\S+\.har)\b/i.exec(stdout)?.[1];
  const file = [asked && path.resolve(asked), reported && path.resolve(reported)].find((f) => f && fs.existsSync(f));
  if (!file) return `${fmt.warning("!")} could not find the HAR to redact it; treat it as holding secrets\n`;
  const n = redactHarFile(file, fs);
  if (n === null) return `${fmt.warning("!")} ${file} is not a HAR this can redact; treat it as holding secrets\n`;
  return fmt.muted(`  redacted ${n} secret value${n === 1 ? "" : "s"} (auth, cookies, tokens, passwords, codes) in ${file}`) + "\n";
}

/** Verbs whose whole point is to load a document: always probed. Other
 *  navigating verbs (a click, a submit) are probed only when they did load
 *  one. */
const LOADS_A_PAGE = new Set(["open", "goto", "reload", "back", "forward"]);

/**
 * After a verb that navigated, look for a bot challenge or block page
 * (challenge.ts) and say what it means in the verb's output. A challenge that
 * clears itself is waited out; one that needs a person, or a block, makes the
 * verb fail with the instruction to hand it over or stop, so a `do` flow does
 * not carry on against it and nothing loops.
 */
async function checkChallenge(verb: string, o: Ctx, started: number): Promise<ChallengeOutcome | null> {
  const probe = async (): Promise<ChallengeProbe | null> => {
    const r = await runEngine(["eval", CHALLENGE_PROBE_SOURCE, "--json"], { ...o, narrate: "checking the page for a bot check" });
    return r.status === 0 ? parseChallengeProbe(r.stdout) : null;
  };
  const first = await probe().catch(() => null);
  if (!first) return null;
  // A click that did not load a new document cannot have landed on an interstitial.
  if (!LOADS_A_PAGE.has(verb) && first.sinceLoad >= Date.now() - started) return null;
  const outcome = await awaitChallenge(
    first,
    { probe, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now },
    challengeWaitMs(),
  );
  if (!outcome) return null;
  // That site scores input: pace it like a hand from now on, in the human's
  // Chrome where the host paces input (humanInput.ts).
  const tabId = isRealSession(o.session) ? tabIdOfTarget(readBoundTarget(o.session) ?? "") : null;
  if (tabId !== null) markChallengedTab(tabId);
  if (outcome.cleared) console.log(fmt.muted(`  ${challengeReport(outcome)}`));
  else console.log(`${fmt.warning("!")} ${challengeReport(outcome)}`);
  return outcome;
}

/**
 * Bring this machine's current cookies for the site into the managed browser.
 * Never on the cloud host: it has no Keychain, and its clone of the box's
 * own `~/.config/google-chrome` carries a sourceProfile, so the state guards
 * alone would let the carry run and fail late with a misleading Keychain
 * reason. There the carry is a request (`cast browser sync <site>`, sync.ts).
 */
export async function carryLogins(
  rawUrl: string,
  deps: { isRemote: () => boolean; readState: () => ReturnType<typeof readState>; provision: typeof provisionLocalLogins } =
    { isRemote: isRemoteDevice, readState, provision: provisionLocalLogins },
): Promise<void> {
  if (deps.isRemote()) return;
  const state = deps.readState();
  if (!state || state.remote || !state.sourceProfile) return;
  const url = /^[a-z]+:/i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  try {
    const r = await deps.provision(state.port, url, { profileDir: state.sourceProfile, channel: state.channel });
    if (r.injected) console.log(fmt.muted(`  carried ${r.injected} cookie${r.injected === 1 ? "" : "s"} for ${r.host} from your Chrome`));
  } catch {
    /* a courtesy: never fail the open over it */
  }
}

/**
 * A saved sign-in for the site (secrets/signinBrowser.ts), and a write-back of
 * newer cookies when the browser already uses it. Loaded only when `open`
 * runs, and never fails the open.
 */
async function useVaultSignin(url: string, bridge?: CdpEndpoint): Promise<void> {
  try {
    const { signInOnOpen } = await import("../secrets/signinBrowser.js");
    await signInOnOpen(url, () => detectSessionId?.() ?? null, (line) => console.log(fmt.muted(`  ${line}`)), bridge);
  } catch {
    /* a courtesy, like carryLogins */
  }
}

/** The budget each verb, and each `do` step, gets (deadline.ts). */
let verbDeadlineS = DEFAULT_DEADLINE_S;

/** This process opened a tab (a first `open`, or `--new-tab`): the cleanup
 *  reminder prints once, there, rather than after every verb. */
let openedTab = false;

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
  if (lines.length && isPaneSession(o.session)) lines[lines.length - 1] += fmt.muted(PANE_TAB_NOTE);
  for (const line of verb === "open" ? lines.slice(-1) : lines) console.log(line);
  if (lines.length && openedTab) console.log(fmt.muted(isPaneSession(o.session)
    ? "  When finished: `cast browser stop` releases this session's control; the human's desktop pane stays open."
    : TAB_CLEANUP_NOTE));
  if (NAVIGATING_VERBS.has(verb)) {
    const url = (tabs.find((t) => t.active) ?? tabs[0])?.url ?? "";
    // Tab identity on the engine path is the engine session: one active tab
    // per session, so per-session dedup is the same thing.
    const warn = url ? auditLanding({ url, tab: `engine:${o.session}`, session: owner, via: viaFor(verb) }) : null;
    if (warn) console.log(`${fmt.warning("!")} ${warn}`);
    // A login form where the work was expected. Named, with the fix, so an
    // agent does not read it as an empty page or restart the browser over it.
    const signIn = url ? (isRemoteDevice() ? cloudHostSignInHint(url) : signInLandingNote(url, keepsOwnLogin, { real: isRealSession(o.session), realHint: realModeHint(owner) })) : null;
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
    await ensureBrowser(o);
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
    const raised = await raiseTabForPerson(tab.targetId);
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
  console.log(`${fmt.warning("!")} still on a sign-in page after ${waitSeconds}s (${still}) — run \`cast browser login\` again to keep waiting, or report blocked on the sign-in`);
  return 1;
}

/**
 * Bring a tab to the front of the human's screen, in whichever browser holds
 * it — the same route the web's "open tab" link uses (focusHttp.ts), so the
 * clone, an agent-browser Chrome and the human's own Chrome through the
 * bridge all answer. Stamps the raise before it happens: the focus sentinel
 * (focusSentinel.ts) reads InstanceState.loginRaisedAt to tell a wanted
 * raise from a theft, so it must be on disk before the window ever moves.
 */
async function raiseTabForPerson(targetId: string): Promise<{ ok: boolean; reason?: string }> {
  const fresh = readState();
  if (fresh) writeState({ ...fresh, loginRaisedAt: Date.now() });
  return focusBrowserTabBlocking(targetId);
}

/**
 * `show`: put this session's tab in front of the human. The one verb that
 * takes their screen on purpose, so it is for the moments they asked to see
 * the page or have to act in it themselves — never a way to check work.
 */
async function showToPerson(choice: TargetChoice): Promise<number> {
  const o = await ctx(choice);
  await ensurePinnedTab(o.session);
  const tab = currentTab(o);
  if (!tab) die("this session has no tab to show", "open a page first: cast browser open <url>");
  const raised = await raiseTabForPerson(tab.targetId);
  const where = isPaneSession(o.session) ? "the desktop app's pane" : isRealSession(o.session) ? "your Chrome" : "the agent browser (a separate window from your Chrome)";
  if (raised.ok) console.log(`${OK} brought the tab to the front in ${where}: ${tab.url}`);
  else console.log(`${fmt.warning("!")} could not bring the tab to the front (${raised.reason}); it is ${tab.url} in ${where}`);
  printFooter(o, "show", auditOwner());
  return raised.ok ? 0 : 1;
}

/** Run a verb and exit with its status — the shape commander actions want. */
async function passthrough(verb: string, args: string[]): Promise<never> {
  const t = await targetOf(verb, args);
  // Whatever fails on the way (a stall that outlived its retry, a bridge
  // that is down) is one line for the human, never a stack trace.
  try {
    process.exit(await runVerb(verb, t.args, t.ctx));
  } catch (err) {
    die((err as Error).message);
  }
}

/** `find <text>`: refs on the page whose accessible name matches, best first.
 *  Parses the engine's snapshot lines into (role, name) and hands matching to
 *  the shared matcher, so both drivers rank identically. With several matches,
 *  hidden elements (zero-size box) sink to the bottom — the wrong-"huddle"
 *  class of miss, where a kept-alive background pane held the same label.
 *  Remembers the best hit AND the query, so a following bare action can use
 *  it and a stale ref can be re-found. */
function findRefs(text: string, o: Ctx, opts: { lenient?: boolean } = {}): { hits: string[]; near: string[]; total: number } {
  const { res, page } = settledSnapshot(["snapshot"], o);
  if (res.status !== 0) {
    if (opts.lenient) return { hits: [], near: [], total: 0 };
    die((res.stderr || res.stdout).trim().split("\n")[0] || "could not read the page");
  }
  const items = parseEngineRefs(res.stdout);
  if (items.length) rememberSnapshotRefs(o.session, items, page);
  // `find "Delete (2nd)"` asks for the second of the namesakes the snapshot
  // printed that way — one match, so the ranking below has nothing to do.
  const { text: query, nth } = splitOrdinalQuery(text);
  const matched = matchRefs(items, query);
  let hits = nth ? pickOrdinal(items, matched, nth) : matched;
  if (hits.length > 1) {
    const boxes = new Map<string, { width: number; height: number } | null>();
    for (const h of hits.slice(0, 5)) {
      if (!h.ref) continue;
      try {
        const box = runEngineJson<{ width?: number; height?: number }>(["get", "box", `@${h.ref}`], o);
        boxes.set(h.line, box?.width !== undefined ? { width: box.width ?? 0, height: box.height ?? 0 } : null);
      } catch {
        boxes.set(h.line, null);
      }
    }
    const { ordered, hidden } = rankByVisibility(hits, (h) => boxes.get(h.line) ?? null);
    hits = ordered.map((h) => (hidden.has(h) ? { ...h, line: `${h.line}  (hidden)` } : h));
  }
  const near = hits.length ? [] : nearMatches(items, query);
  if (hits[0]?.ref) rememberFind(o.session, `@${hits[0].ref}`, text);
  return { hits: hits.map(findLine), near: near.map(findLine), total: items.length };
}

/**
 * A ref the engine could not resolve, looked up again on a fresh snapshot.
 *
 * Fails closed. The retry runs only when the page is the one the ref was read
 * on and the ref's exact coordinate (the nth of the same number of namesakes)
 * is still there (refMemory.ts recoverRefPlan): the difference between
 * deleting the third row and deleting the first. The remembered words of a
 * `find` are the fallback, held to the same page and to a single match.
 * Anything less certain is refused with the instruction to snapshot again.
 */
function recoverStaleRef(target: string, o: Ctx, query: string | null): { ref: string; note: string } | { refused: string } {
  const was = recallSnapshotRef(o.session, target);
  const before = was?.url ?? rememberedSnapshotUrl(o.session);
  if (!was && !query) return { refused: `it is not in the last snapshot; ${SNAPSHOT_AGAIN}` };
  // Within the scope the ref was read in, so the namesake count compares like for like.
  const scoped = was?.scope ? ["snapshot", "-s", was.scope] : ["snapshot"];
  const { res, page } = settledSnapshot(scoped, o);
  const url = page?.url ?? null;
  if (res.status !== 0 || !res.stdout) return { refused: `the page could not be read again; ${SNAPSHOT_AGAIN}` };
  const items = parseEngineRefs(res.stdout);
  if (items.length) rememberSnapshotRefs(o.session, items, page, was?.scope);
  if (was) {
    const plan = recoverRefPlan(was, items, url);
    if ("refused" in plan) return plan;
    const which = was.nth ? `the ${ordinal(was.nth)} ` : "";
    return { ref: `@${plan.ref}`, note: `ref went stale — retried ${which}${was.role} ${JSON.stringify(was.name)} as #${plan.ref}` };
  }
  if (!before || before !== url) return { refused: `the page changed since the find; ${SNAPSHOT_AGAIN}` };
  const { text, nth } = splitOrdinalQuery(query!);
  const matched = nth ? pickOrdinal(items, matchRefs(items, text), nth) : matchRefs(items, text);
  if (matched.length !== 1 || !matched[0].ref || `@${matched[0].ref}` === target) {
    return { refused: `${JSON.stringify(query)} now matches ${matched.length} elements; ${SNAPSHOT_AGAIN}` };
  }
  const fresh = `@${matched[0].ref}`;
  rememberFind(o.session, fresh, query!);
  return { ref: fresh, note: `ref went stale — re-found ${JSON.stringify(query)} as ${fresh.replace("@", "#")}` };
}

/**
 * The engine's snapshot, recaptured while the page is mid-mutation or
 * mid-navigation (snapshotSettle.ts), with the URL it describes and the
 * values of sensitive fields taken out of its text. A main frame
 * that kept navigating through every attempt is a failure the agent can act
 * on, never a snapshot of a document that is already gone.
 */
function settledSnapshot(args: string[], o: Ctx, redactAllValues = false): { res: EngineRun; page: PageStamp | null } {
  const out = captureSettled({
    capture: () => runEngine(args, o),
    probe: () => probePage(o, redactAllValues),
    sleep: sleepSync,
    now: Date.now,
  });
  if (out.navigating) {
    return {
      res: { status: 1, stdout: "", stderr: "the page kept navigating while the snapshot was read; wait for it to land, then snapshot again\n" },
      page: null,
    };
  }
  // Password, one-time-code and card values never reach the agent's text.
  return { res: { ...out.res, stdout: redactSnapshotOutput(out.res.stdout, out.hidden) }, page: out.page };
}

/** One read of the page: its URL, document token, mutation clocks and the
 *  field values a snapshot must not show; asked about a ref's name, also when
 *  an element of that name last left the page. */
function probePage(o: PageCtx, redactAllValues = false, refName?: string) {
  const r = runEngine(["eval", settleProbeSource(redactAllValues, refName), "--json"], o);
  return r.status === 0 ? parseSettleProbe(r.stdout) : null;
}

/**
 * Why an action must not use this ref, checked before it is sent, or null
 * when it may (refMemory.ts preflightRefPlan: the engine would otherwise act
 * on whatever now holds the ref's position). Costs one probe, and only for a
 * ref the last snapshot printed. Every verb that hands a ref to the engine
 * goes through it, `type-secret`'s focus included (sessionTab.ts).
 */
export function refuseShiftedRef(target: string, o: PageCtx): string | null {
  const was = recallSnapshotRef(o.session, target);
  if (!was || was.at === undefined) return null;
  return preflightRefPlan(was, probePage(o, false, was.name))?.refused ?? null;
}

/** The `-s` selector a snapshot was scoped to, if any. */
function snapshotScope(args: string[]): string | undefined {
  const i = args.findIndex((a) => a === "-s" || a === "--selector");
  return i >= 0 ? args[i + 1] : undefined;
}

/** A find result as the agent reads it: the engine's own line, with the
 *  ordinal added when the name is one of several. */
function findLine(h: EngineRef): string {
  const label = refLabel(h);
  return label === h.name ? h.line : h.line.replace(/"[^"]*"/, JSON.stringify(label));
}

export interface ShotOptions {
  /** Where to write; the positional path, -o/--out or --path. */
  out?: string;
  full?: boolean;
  annotate?: boolean;
  share?: boolean;
  alt?: string;
  inline?: boolean;
  selector?: string;
  json?: boolean;
  format?: string;
  quality?: string;
}

/** Flags `shot` reads, with the spellings agents reach for. A value-taking
 *  flag maps to its option name; a bare one to true. */
const SHOT_FLAGS: Record<string, { key: keyof ShotOptions; value: boolean }> = {
  "-o": { key: "out", value: true }, "--out": { key: "out", value: true }, "--path": { key: "out", value: true },
  "-s": { key: "selector", value: true }, "--selector": { key: "selector", value: true }, "--ref": { key: "selector", value: true },
  "--full": { key: "full", value: false }, "--full-page": { key: "full", value: false },
  "--annotate": { key: "annotate", value: false }, "--json": { key: "json", value: false }, "--share": { key: "share", value: false },
  "--alt": { key: "alt", value: true }, "--format": { key: "format", value: true }, "--quality": { key: "quality", value: true },
};

/**
 * A `shot` command line (a `do` step, or what commander left unparsed) as
 * options. A flag `shot` does not have is refused, never passed on: the engine
 * read a stray `--out` as a selector and failed with "Element not found: --out".
 * Pure, so it is testable without a browser.
 */
export function parseShotArgs(args: readonly string[]): { opts: ShotOptions } | { error: string; hint: string } {
  const opts: Record<string, unknown> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]!;
    if (raw === "--no-inline") { opts.inline = false; continue; }
    if (raw === "--no-shot" || raw === "--no-capture") continue;
    if (!raw.startsWith("-") || raw === "-") { positional.push(raw); continue; }
    const [flag, inline] = raw.includes("=") ? [raw.slice(0, raw.indexOf("=")), raw.slice(raw.indexOf("=") + 1)] : [raw, undefined];
    const spec = SHOT_FLAGS[flag!];
    if (!spec) {
      return {
        error: `shot has no ${flag} flag`,
        hint: "write to a file with a path or -o: cast browser shot /tmp/page.png (--full for the whole page, -s <sel> for one element)",
      };
    }
    if (!spec.value) { opts[spec.key] = true; continue; }
    const value = inline ?? args[++i];
    if (value === undefined) return { error: `${flag} needs a value`, hint: "cast browser shot -o /tmp/page.png" };
    opts[spec.key] = value;
  }
  if (positional.length > 1) return { error: `shot takes one path, got ${positional.join(" ")}`, hint: "one element is -s <sel>: cast browser shot -s \"#pricing\" /tmp/pricing.png" };
  if (positional[0] && opts.out) return { error: `two paths: ${positional[0]} and ${String(opts.out)}`, hint: "give the path once" };
  if (positional[0]) opts.out = positional[0];
  return { opts: opts as ShotOptions };
}

/** `shot`: screenshot to a file, inline in the conversation, optionally shared. */
async function takeShot(o: ShotOptions, c: Ctx, deps: PublishDeps): Promise<string> {
  // The engine daemon writes a relative path against its own working
  // directory, not the agent's: resolve it here, where the agent is.
  const out = o.out ? path.resolve(o.out) : defaultShotPath();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const extra: string[] = [];
  if (o.full) extra.push("--full");
  if (o.annotate) extra.push("--annotate");
  if (o.json) extra.push("--json");
  if (o.format) extra.push("--screenshot-format", o.format);
  if (o.quality) extra.push("--screenshot-quality", o.quality);
  // The engine's screenshot takes `[selector] [path]`: a selector (or ref)
  // clips the capture to that element — one region readable at full size,
  // no post-hoc cropping.
  const target = o.selector ? [engineRef(quoteAttrValues(o.selector))] : [];
  const res = await runEngine(["screenshot", ...target, out, ...extra], { ...c, narrate: "taking a screenshot" });
  if (res.status !== 0) {
    die(castVoice((res.stderr || res.stdout).trim().split("\n")[0] || "the screenshot failed"));
  }
  if (!fs.existsSync(out) && o.full && !o.selector) {
    // Over the extension bridge the engine's full-page capture reports
    // success and writes nothing. CDP's captureBeyondViewport does the same
    // job; if that fails too, a viewport shot beats no picture.
    const page = await captureFullPage(c);
    if ("png" in page) fs.writeFileSync(out, page.png);
    else {
      const viewport = await runEngine(["screenshot", out, ...extra.filter((x) => x !== "--full")], { ...c, narrate: "taking a screenshot" });
      if (viewport.status === 0 && fs.existsSync(out)) console.log(`${fmt.warning("!")} the whole-page capture failed (${page.error}); this is the viewport only`);
    }
  }
  if (!fs.existsSync(out)) die(`the engine reported success but wrote no file at ${out}`, "try again without --full, or with -s <sel> for one region");
  if (!o.out) secureTempFile(out);
  if (o.json) {
    const payload = parseEngineJson<{ annotations?: unknown }>(res);
    const ratio = await runEngine(["eval", "devicePixelRatio", "--json"], { ...c, narrate: "reading screenshot scale" });
    const scale = ratio.status === 0 ? parseEngineJson<{ result?: unknown }>(ratio).result : null;
    const written = fs.readFileSync(out);
    console.log(JSON.stringify(shotJson({
      file: out,
      bytes: written.length,
      size: imageSize(written),
      scale: typeof scale === "number" ? scale : null,
      annotations: payload.annotations,
      url: o.share ? (await uploadOne(deps, out, o.alt || "screenshot")).url : undefined,
    })));
    return out;
  }

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
    // Each step gets the whole budget, so a long flow is bounded step by step.
    armVerbDeadline(verb, verbDeadlineS);
    let ok = true;
    console.log(`${fmt.highlight("›")} ${raw}`);
    try {
      // The same table the standalone verbs read (cloneOnlyRefusal): a step
      // the real Chrome cannot take fails here, before anything touches it.
      const refused = cloneOnlyRefusal(verb, isRealSession(c.session));
      if (refused) throw new Error(`${refused.message} (${refused.hint})`);
      if (verb !== "open" && verb !== "tab" && verb !== "viewport") await ensurePinnedTab(c.session);
      if (verb === "shot") {
        const shot = parseShotArgs(args);
        if ("error" in shot) throw new Error(`${shot.error} (${shot.hint})`);
        await takeShot(shot.opts, c, deps);
      } else if (verb === "viewport") {
        const sizeArgs = rest.filter((a) => !a.startsWith("--"));
        const r = await setViewport(rest.includes("--reset") ? "reset" : sizeArgs.join("x"), c);
        if (!r.ok) throw new Error(r.hint ? `${r.message} (${r.hint})` : r.message);
        for (const line of r.lines) console.log(line);
      } else if (verb === "eval") {
        const script = readEvalScript(rest, null);
        const out = await evalInPage(script, c);
        console.log(rest.includes("--json") ? out.output : out.display ?? out.output);
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
  if (!failed) printFooter(c, "batch", auditOwner());
  console.log(fmt.muted(`  ${steps.length} step${steps.length === 1 ? "" : "s"} in ${((Date.now() - started) / 1000).toFixed(1)}s${failed ? `, ${failed} failed` : ""}`));
  return failed ? 1 : 0;
}

/** Chrome refused the debugger on this session's tab. */
export function isUnattachableTab(output: string): boolean {
  return /Cannot attach to this target/i.test(output);
}

/** What to do when Chrome still refuses after the one retry. */
export const UNATTACHABLE_NOTE =
  "Chrome would not let this session attach to its tab, even on a retry (DevTools or another debugger on the tab, or a tab mid-close). " +
  "`cast browser stop`, then `cast browser open <url>` starts on a fresh tab; `cast browser extension status` checks the connection.";

/** The engine's one-line verdict, for failure classification. */
export function engineFailureMessage(stderr: string, stdout: string): string {
  const lines = `${stderr}\n${stdout}`.split("\n").map((l) => l.replace(/^\s*[✗×x]\s*/, "").trim()).filter(Boolean);
  return lines[0] ?? "the browser engine reported a failure";
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Flags agents write for "screenshot this element", which `shot` spells -s/--selector. */
const SHOT_ELEMENT_FLAGS = new Set(["--element", "--el", "--sel", "--target", "--clip", "--css"]);

/** A flag that names one element is the agent reaching for -s; passed on, its
 *  value would be read as the output path and the whole page shot. Checked
 *  before a tab is pinned, so the fix is the first thing the agent reads. */
function refuseMisnamedShotFlag(args: readonly unknown[]): void {
  const misnamed = args.find((a): a is string => typeof a === "string" && SHOT_ELEMENT_FLAGS.has(a.split("=")[0]!));
  if (misnamed) die(`shot has no ${misnamed.split("=")[0]} flag`, `screenshot one element with -s: cast browser shot -s "#pricing" (a CSS selector or a #eNN ref)`);
}

export function registerEngineCommands(br: Command, deps: PublishDeps): void {
  registerAdvancedClone(br, (program) => registerEngineCommands(program.command("browser"), deps));
  detectSessionId = deps.detectCurrentSessionId;
  engineDeps = deps;
  auditOwner = () => ownerKey(deps.detectCurrentSessionId);
  registerAuditCommand(br, auditOwner);
  registerBridgeCommands(br, { me: auditOwner });
  const subscriptionDeps: BrowserSubDeps & { session: () => string | undefined } = {
    session: () => currentSession(),
    currentTab: () => ctx(),
    tabFor: async (tab) => (isRealSession(tab) ? await engineBrowserFor(tab, await requireRealBridge()) : { session: tab }),
    judge: (session) => modelJudge(
      async (spec) => (await import("../judgingCommand.js")).callModel(deps, session ? { conversation_id: session } : {}, spec, "browser subscription"),
      async (spec) => (await import("../subscriptionCall.js")).subscriptionModelCall(spec, { timeoutMs: 40_000 }),
    ),
  };
  registerBrowserSubscriptions(br, subscriptionDeps);
  registerHandoffCommand(br, subscriptionDeps);

  // Any verb that reaches the page can be the one that starts this session's
  // daemon, and a daemon attaching with no live bound tab creates one in the
  // FOREGROUND — raising Chrome over the human's work. Bind a background tab
  // first (pinnedTab.ts). Verbs that never touch this session's page skip it,
  // and a clone-only verb asked for the real Chrome dies in ctxFor before a
  // tab is pinned in a browser it will then refuse.
  // `pane` offers a page to the reader over the backend and never opens a tab.
  const NO_TAB_NEEDED = new Set(["open", "do", "viewport", "status", "tab", "tabs", "start", "stop", "reap", "profiles", "shots", "dialogs", "audit", "target", "bridge-host", "pane", "unsubscribe", "subscriptions", "subscription", "handoff"]);
  br.option("--tab <name>", "A tab of your own under this name, for parallel workers sharing one session (or CAST_BROWSER_TAB)")
    .addOption(new Option("--session <name>", "Same as --tab").hideHelp())
    .option("--deadline <seconds>", `Give up on a verb after this long, naming what it waited on (default ${DEFAULT_DEADLINE_S}, 0 for none; or ${DEADLINE_ENV})`);
  br.hook("preAction", async (thisCommand, actionCommand) => {
    const verb = actionCommand.name();
    // `--browser <id>` parsed by commander (targetFlags); passthrough verbs carry it raw (splitTargetFlags).
    // `--tab`, `--session` and `--deadline` belong to `browser` itself, which
    // reads them anywhere on the line, before or after the verb.
    const opts = actionCommand.opts() as { browser?: string };
    const parent = thisCommand.opts() as { tab?: string; session?: string; deadline?: string };
    const seconds = deadlineSeconds(parent.deadline);
    if (seconds === null) die(`--deadline takes seconds, not '${parent.deadline ?? process.env[DEADLINE_ENV]}'`, "cast browser --deadline 180 open <url>  (0 for none)");
    verbDeadlineS = seconds;
    // Direct verbs, and the connection check; other groups (extension setup
    // waits for the human's Pair click) bound their own waits.
    const bounded = actionCommand.parent === br || (verb === "status" && actionCommand.parent?.name() === "extension");
    if (bounded) armVerbDeadline(verb, seconds);
    if (opts.browser) requestBrowserProfile(opts.browser);
    try {
      requestTabName(parent.tab ?? parent.session);
      splitTargetFlags(actionCommand.args);
    } catch (err) {
      die((err as Error).message);
    }
    if (verb === "shot") {
      refuseMisnamedShotFlag(actionCommand.args);
      const parsed = parseShotArgs(actionCommand.args.filter((a): a is string => typeof a === "string"));
      if ("error" in parsed) die(parsed.error, parsed.hint);
    }
    if (NO_TAB_NEEDED.has(verb) || actionCommand.parent !== br || actionCommand.args.some((arg) => arg === "--help" || arg === "-h")) return;
    try {
      await ensurePinnedTab((await ctxFor(verb, targetChoiceOf(actionCommand))).session);
    } catch (err) {
      // One line for the human, never a stack trace: a bridge that is down,
      // or a stall that outlived its retry (stall.ts).
      die((err as Error).message);
    }
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
  shot -s <sel>            screenshot ONE element (--annotate numbers refs on a full shot;
                           --share prints a link to paste elsewhere)

When the human must act on the page, or you wait on it (both return at once; end your turn):

  handoff "<step>"         a card on this tab with Continue (a sign-in, a code, a captcha);
                           wakes this session when they press it (--show also raises the tab)
  subscribe --signed-in    wake when the tab leaves its sign-in page; or --text <t>, --url <glob>,
                           --selector <css>, --change, or a plain description a model judges

The human's Chrome is always the default, including before pairing and after restarts:

  target                   show which browser this session uses and why
  target real              restore this session to the human's Chrome
  start                    connect to the extension; never silently launches a separate Chrome
  status / tabs            inspect without creating a tab; page actions need an open URL first
  show                     bring this session's tab to the front, only when the human asked to
                           see it (for a step they must do, use handoff)
  open <url>               a tab of its own there, in the "Cast" tab group;
                           created directly at the URL, without a blank setup tab;
                           act only on tabs you opened. Needs the extension paired once by
                           the human: cast browser extension setup
                           Commands wait for reconnect, then report what needs fixing.
                           They never fall back to a separate browser.

\`cast browser help <command>\` documents the command's flags.`,
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
      const at = t.args.findIndex((a) => !a.startsWith("-"));
      if (at >= 0) refuseEngineCommand(t.args[at], t.args.slice(at + 1), t.ctx, auditOwner());
      const res = runEngine(t.args, t.ctx);
      if (res.stdout) process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
      process.exit(res.status);
    });

  // -------------------------------------------------------------- screenshots

  targetFlags(br.command("shot [pathArg]"))
    .alias("screenshot")
    .description("Screenshot the page — appears inline in this conversation (--annotate labels refs on it, -s clips to one element)")
    .option("-o, --out <path>", "Where to write the image (same as the positional path; --path works too)")
    .option("-s, --selector <sel>", "Screenshot just this element (CSS selector or #eNN ref)")
    .option("--ref <ref>", "Same as -s")
    .option("--full", "Whole scroll height, not just the viewport (--full-page works too)")
    .option("--format <fmt>", "png (default) or jpeg")
    .option("--quality <n>", "JPEG quality, 0-100")
    .option("--annotate", "Number every interactive element on the image; each [N] label is snapshot ref #eN, with a legend")
    .option("--share", "Also upload it and print a link you can paste elsewhere")
    .option("--alt <text>", "Caption for the shared image — say what it shows")
    .option("--no-inline", "Do not show the image in the conversation")
    .option("--json", "Print file metadata as JSON, without image bytes")
    .allowUnknownOption(true)
    .action(async (pathArg: string | undefined, o: any, cmd: any) => {
      // What commander left over: the aliases it does not declare (--path,
      // --full-page) and anything `shot` lacks, which parseShotArgs refuses.
      const more = parseShotArgs(((cmd.args ?? []) as unknown[]).filter((a): a is string => typeof a === "string"));
      if ("error" in more) die(more.error, more.hint);
      const out = more.opts.out ?? pathArg;
      if (o.out && out && o.out !== out) die(`two paths: ${out} and ${o.out}`, "give the path once");
      const opts: ShotOptions = { ...o, ...more.opts, out: o.out ?? out, selector: o.selector ?? o.ref ?? more.opts.selector, full: o.full || more.opts.full };
      await takeShot(opts, await ctx(o), deps);
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
      const plan = await readStepPlan(steps);
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

  targetFlags(br.command("show"))
    .description("Bring this session's tab to the front of the human's screen, only when they asked to see the page (a step they must do on it is `handoff`)")
    .action(async (o: TargetChoice) => {
      process.exit(await showToPerson(o));
    });

  targetFlags(br.command("login [url]"))
    .description("Run this yourself when a page needs a sign-in: raises the agent browser on the page for the human and waits until it leaves the sign-in page")
    .option("--wait <seconds>", "How long to wait for the sign-in; 0 returns at once", "300")
    .action(async (url: string | undefined, o: { wait: string } & TargetChoice) => {
      process.exit(await loginAsPerson(url, Math.max(0, parseInt(o.wait, 10) || 0), o));
    });

  targetFlags(br.command("sync [url]"))
    .description("Carry your Chrome's current logins into the running agent browser: one site, or every site with no URL (Google excepted — it signs in on its own); on the cloud host it asks your laptop to carry the login")
    .option("--all", "On the cloud host: carry every site (refused while a site allowlist is active)")
    .option("--via <device-id>", "On the cloud host: the laptop that carries it (default: your most recently seen online laptop)")
    .option("--wait <seconds>", "On the cloud host: how long to wait for the laptop; 0 returns at once", String(DEFAULT_SYNC_WAIT_S))
    .action(async (url: string | undefined, o: { all?: boolean; via?: string; wait: string } & TargetChoice) => {
      const c = await ctxFor("sync", o);
      process.exit(await runBrowserSync(url, o, { ensureBrowser: () => ensureBrowser(c), me: auditOwner, isRemote: isRemoteDevice }));
    });

  targetFlags(br.command("tabs"))
    .description("List this session's tabs; --all lists every agent's")
    .option("--all", "Every agent session's tab in the browser, not only this session's")
    .action(async (o: TargetChoice & { all?: boolean }) => {
      const c = await ctx(o);
      if (isRealSession(c.session)) {
        // The host's HTTP face lists every tab with cast's own annotations;
        // the engine's own list is scoped to this session on purpose.
        let bridge;
        try {
          bridge = await requireRealBridge();
        } catch (err) {
          die((err as Error).message);
        }
        // The listing is answered by the extension's worker, whose process
        // may be frozen (stall.ts): once more after a stall, then one line.
        let raw: Array<{ id: string; title: string; url: string; cast?: boolean; sessions?: string[] }>;
        try {
          raw = await retryOnStall(() => readCdpJson<typeof raw>({ port: bridge.port, token: bridge.token }, "/json/list"));
        } catch (err) {
          die((err as Error).message);
        }
        const tabs = raw.filter((t) => t.cast && (o.all || t.sessions?.includes(c.session)));
        if (!tabs.length) console.log(fmt.muted("  no agent tabs in your Chrome"));
        for (const t of tabs) {
          const mine = (t.sessions ?? []).includes(c.session);
          // A named tab (--tab) of this same agent: its own tab, still this agent's.
          const sibling = (t.sessions ?? []).find((sid) => ownerOfSessionKey(sid) === ownerOfSessionKey(c.session));
          const who = mine ? "this session" : sibling ? `this agent's tab ${tabNameOf(sibling) ?? "(default)"}` : (t.sessions ?? []).join(", ") || "no session";
          console.log(`  ${mine ? "*" : "~"} [${t.id}] ${t.title || t.url} - ${t.url}  ${fmt.muted(who)}`);
        }
        console.log(fmt.muted("  * = this session's, ~ = another agent's — `cast browser tab switch <id>` shares one with this session; the human's own tabs are never listed"));
        process.exit(0);
      }
      const code = await runVerb("tab", ["list"], c);
      if (code === 0 && isPaneSession(c.session)) console.log(fmt.muted("  the desktop app's pane opened for this session, driven over the app's CDP port"));
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
  --json            Print the value JSON-encoded exactly (a string comes quoted)

A string prints as itself, newlines and quotes intact, so there is no need to
wrap a result in JSON.stringify; other values print as JSON. A script that
throws prints the page's exception and exits 1.`;

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
      await ensureBrowser(c);
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
      // A script given longer than the budget keeps its own limit.
      if (verbDeadlineS > 0 && timeout / 1000 + 30 > verbDeadlineS) armVerbDeadline("eval", Math.ceil(timeout / 1000) + 30);
      const rest = ti >= 0 ? scriptArgs.filter((_, i) => i !== ti && i !== ti + 1) : scriptArgs;
      let script: string;
      try {
        script = readEvalScript(rest, stdinBody);
      } catch (err) {
        die((err as Error).message);
      }
      const out = await evalInPage(script, c, timeout);
      console.log(rest.includes("--json") ? out.output : out.display ?? out.output);
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
      await ensureBrowser(c);
      await ensurePinnedTab(c.session);
      const out = await grantPermissions(permissions, c, o);
      console.log(`${out.ok ? OK : BAD} ${out.output}`);
      if (out.hint) console.log(fmt.muted(`  ${out.hint}`));
      process.exit(out.ok ? 0 : 1);
    });

  targetFlags(br.command("viewport [size] [height]"))
    .description("Resize the page, or emulate a device: desktop, laptop, wide, tablet, mobile, mobile-small")
    .option("--reset", "Back to the default size")
    .addHelpText(
      "after",
      `
  cast browser viewport 1440x900      # width x height in CSS pixels
  cast browser viewport 390           # a width alone takes the matching preset's height, else 900
  cast browser viewport mobile        # a preset
  cast browser do "viewport 390x844" "open example.com" shot

Before any page is open, the size is kept and applied by the next \`open\`.`,
    )
    .action(async (size: string | undefined, height: string | undefined, o: { reset?: boolean } & TargetChoice) => {
      const c = await ctx(o);
      if (!size && !o.reset) {
        await ensurePinnedTab(c.session).catch((err) => die((err as Error).message));
        const res = runEngine(["eval", "JSON.stringify([innerWidth,innerHeight,devicePixelRatio])"], c);
        console.log(res.stdout.trim());
        console.log(fmt.muted(`  presets: ${Object.keys(VIEWPORTS).join(", ")}  ·  or a size like 1024x768`));
        return;
      }
      const r = await setViewport(o.reset ? "reset" : [size, height].filter(Boolean).join("x"), c);
      if (!r.ok) die(r.message, r.hint);
      for (const line of r.lines) console.log(line);
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

  targetFlags(br.command("start"))
    .description("Connect to the human's Chrome through the extension")
    .addHelpText("after", BROWSER_START_HELP)
    .option("--profile <dir>", "Chrome profile to inherit logins from (see `cast browser profiles`)")
    .option("--fresh", "Start signed out of everything")
    .option("--resync", "Re-copy the profile even if a clone already exists")
    .option("--headless", "Run without a visible window")
    .option("--fake-media", "Fake camera/mic devices (test pattern + tone) — for machines without real ones; permission prompts are auto-accepted")
    .option("--size <WxH>", "Window size for the separate browser")
    .option("--remote [host]", "Run the browser on a remote host (see `cast browser hosts`)")
    .action(async (o: Partial<StartOptions> & TargetChoice) => {
      const real = await prepareRealBrowserStart(o, auditOwner()).catch((err) => die((err as Error).message));
      let install;
      try {
        install = ensureEngine();
      } catch (err) {
        die((err as Error).message);
      }
      if (install.installed) console.log(`${OK} browser engine installed (${ENGINE_PACKAGE})`);
      const session = engineSession(detectSessionId);
      const swept = describeReap(await reapEngineOrphans({ force: true, keep: session }));
      if (swept) console.log(fmt.muted(`  ${swept}`));
      if (real) return;

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
      const pane = isPaneSession(c.session);
      // Real mode has no managed browser behind it: the human's Chrome is
      // the browser, and the bridge is what can be up or down. A pane's
      // browser is the desktop app, already answering on its port.
      if (!binary || (!state && !real && !pane)) {
        console.log(`${fmt.muted(icons.dot)} not set up yet — run \`cast browser start\``);
        return;
      }
      let alive = true;
      if (real) {
        console.log(`${OK} real Chrome via the bridge on ${new URL(c.cdp!).host} — \`cast browser extension status\` says whether it is connected`);
      } else if (pane) {
        console.log(`${OK} the desktop app's pane over its CDP port ${new URL(c.cdp!).host} — the human opened it for this session`);
      } else if (state) {
        alive = isPidAlive(state.pid);
        console.log(`${alive ? OK : BAD} browser ${alive ? "up" : "gone"} — pid ${state.pid}, CDP 127.0.0.1:${state.port}${state.headless ? ", headless" : ""}${state.fakeMedia ? ", fake media devices" : ""}`);
      }
      console.log(`  engine: ${ENGINE_PACKAGE} ${engineVersion() ?? "?"}  ${fmt.muted(binary)}`);
      console.log(`  session: ${c.session}`);
      if (!real && !pane && state) {
        console.log(`  profile: ${state.sourceProfile ? `${state.sourceProfile} (logins inherited; Google is its own — \`cast browser login\` once)` : "fresh — signed out"}`);
      }
      if (!alive) return;
      const browser = await pinnedTabBrowser(c.session);
      const tabs = browser ? await listTargets(browser.endpoint) : [];
      if (tabs.length) {
        console.log(`  tabs:`);
        for (const tab of tabs) console.log(`    [${tab.targetId}] ${tab.title || tab.url} - ${tab.url}`);
      }
      const others = listEngineSessions().filter((x) => x.running && x.key !== c.session);
      if (others.length) {
        console.log(fmt.muted(`  ${others.length} other session${others.length === 1 ? " is" : "s are"} browsing here too — abandoned tabs close on the next start`));
      }
    });

  // The daemon runs this on its maintenance tick, in a child process so the
  // tmux and ps reads never block its loop. Without it, engines outlived their
  // agents until some session happened to start a browser: 12 orphans, the
  // oldest 42 hours, on 2026-09-17. Throttled inside reapEngineOrphans, and no
  // session is kept: the daemon drives no tab of its own.
  br.command("reap", { hidden: true })
    .description("Close engine browsers whose agent is gone")
    .option("--ended <session id>", "This agent session was just killed: close its tabs now")
    .action(async (o: { ended?: string }) => {
      const live = o.ended ? withEndedSession(scanLiveOwners(), o.ended) : undefined;
      const swept = describeReap(await reapEngineOrphans({ keep: null, force: !!o.ended, live }));
      if (swept) console.log(swept);
    });

  targetFlags(br.command("stop"))
    .description("Close this session's tab; --all closes every session's and the browser")
    .option("--all", "Close every session's tab and the browser itself")
    .option("--wipe", "Also remove the cloned profile (implies --all)")
    .action(async (o: { all?: boolean; wipe?: boolean } & TargetChoice) => {
      // The profile cannot be removed under a running browser, so --wipe means
      // --all, as it means --force on the built-in driver. Alone it used to
      // close one tab, remove nothing and say nothing.
      if (o.wipe) o.all = true;
      const { session } = await ctx(o);
      if ((isRealSession(session) || isPaneSession(session)) && (o.all || o.wipe)) die("Ordinary browser commands cannot stop or wipe a separate browser.");
      // Detach the engine and close the tab it was pinned to; the browser
      // stays for everyone else. A pane is the human's: only the engine lets
      // go of it, and the pane stays where they put it.
      await closeSessionTab(session);
      console.log(isPaneSession(session) ? `${OK} let go of the desktop pane; it stays open for the human` : `${OK} closed this session's tab`);
      if (isPaneSession(session)) return;
      const swept = describeReap(await reapEngineOrphans({ force: true, keep: o.all ? null : session, idleMs: o.all ? 0 : undefined }));
      if (swept) console.log(fmt.muted(`  ${swept}`));
      if (isRealSession(session)) return;
      if (o.all) {
        const state = readState();
        if (state?.remote) {
          const { wiped } = await stopRemoteManagedBrowser(state);
          console.log(wiped
            ? `${OK} remote browser stopped and its profile wiped`
            : `${OK} closed the tunnel to ${state.remote.user}@${state.remote.host}; that host is no longer registered here, so its browser profile was not wiped`);
        } else if (state) {
          await stopInstance(state);
          // Forget it, or the next command reads a browser that is gone.
          clearState();
          console.log(`${OK} browser stopped`);
        }
        if (state && o.wipe) {
          fs.rmSync(state.userDataDir, { recursive: true, force: true });
          console.log(`${OK} removed the cloned profile`);
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
      console.log(fmt.muted("\n  * = the separate browser's profile, used only when explicitly selected. Normal commands use the human's Chrome."));
    });
  hideCloneControls(br);
}
