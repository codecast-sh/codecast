/**
 * `cast app` — drive and verify the codecast app itself, the way a user would,
 * on top of `cast browser`. `cast browser` knows pages; this knows codecast:
 * which surface is which, what "signed in" and "settled" mean, which build is
 * loaded, and how to become a known account for a run.
 *
 * Two targets, one page session:
 *   - web (default): this session's tab in the managed Chrome, at --origin
 *     (local dev when it answers, else production).
 *   - --desktop: the Electron app over its own CDP port (opened by a
 *     from-source run, or by CODECAST_CDP_PORT on a packaged build).
 *
 * Every verb attaches to that page over CDP and reads the app's own handles
 * (window.__CODECAST_BUILD, __syncActivity, __syncReplication, __navLog, and
 * the dev-only __inboxStore), so nothing here scrapes the DOM for state.
 */
import { Command } from "commander";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "../proc.js";
import { c, fmt } from "../colors.js";
import { inlineImageMarker } from "../inlineImage.js";
import { APP_SURFACES, findAppSurface, type AppSurface } from "@codecast/shared/contracts";
import { CdpConnection, listTargets, isCdpAlive, type CdpClient } from "../browser/cdp.js";
import { engineSession, engineTabs } from "../browser/engine.js";
import { engineBrowserFor } from "../browser/bridge/real.js";
import { runVerb } from "../browser/cliEngine.js";
import { connectToTab, evaluateOn, type EvalOutcome, type PageCtx } from "../browser/pageEval.js";
import { repoRootFor } from "../gitPlane.js";

const OK = `${c.green}✓${c.reset}`;
const BAD = `${c.red}✗${c.reset}`;
const WARN = `${c.yellow}!${c.reset}`;

const PROD_ORIGIN = "https://codecast.sh";
const LOCAL_ORIGIN = "https://local.codecast.sh";
const LOCAL_VITE_PORT = 3200;
const DESKTOP_CDP_PORT = Number(process.env.CODECAST_CDP_PORT || 9333);
/** Chromeless desktop windows that are never the page a driver wants. */
const DESKTOP_SIDE_WINDOWS = /\/(palette|people|call-panel|faces|meeting-offer|call-ring)(\?|$)/;

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

type Attached = { conn: CdpClient; sessionId: string; url: string };
type AttachResult = Attached | { error: string; hint?: string };

interface AppTarget {
  kind: "web" | "desktop";
  origin: string;
  label: string;
  /** Attach to the app page. Caller closes `conn`. */
  attach(): Promise<AttachResult>;
  /** Make sure a page exists to attach to (the web target needs a tab first). */
  ensurePage(): Promise<void>;
}

interface TargetOpts {
  desktop?: boolean;
  origin?: string;
}

async function originFor(o: TargetOpts): Promise<string> {
  if (o.origin) return o.origin.replace(/\/+$/, "");
  if (process.env.CAST_APP_ORIGIN) return process.env.CAST_APP_ORIGIN.replace(/\/+$/, "");
  // Local dev when it answers; the tree an agent is editing is what it
  // should be driving. Probe vite directly: the nginx origin carries a
  // self-signed certificate that this process would refuse.
  try {
    const res = await fetch(`http://localhost:${LOCAL_VITE_PORT}/`, { method: "HEAD", signal: AbortSignal.timeout(1500) });
    if (res.ok || res.status === 304) return LOCAL_ORIGIN;
  } catch {}
  return PROD_ORIGIN;
}

async function webTarget(o: TargetOpts): Promise<AppTarget> {
  const origin = await originFor(o);
  const ctx: PageCtx = await engineBrowserFor(engineSession());
  return {
    kind: "web",
    origin,
    label: `web ${origin} (session tab)`,
    attach: () => connectToTab(ctx),
    ensurePage: async () => {
      const tabs = engineTabs(ctx);
      const tab = tabs.find((t) => t.active) ?? tabs[0];
      if (tab?.url?.startsWith(origin)) return;
      // `open` starts the browser, pins the tab and carries logins; the one
      // path every page-touching verb takes.
      const code = await runVerb("open", [`${origin}/inbox`], ctx, { quiet: true });
      if (code !== 0) die(`could not open ${origin}`, "cast browser start");
    },
  };
}

async function desktopTarget(o: TargetOpts): Promise<AppTarget> {
  const port = DESKTOP_CDP_PORT;
  const pick = async () => {
    const targets = await listTargets(port);
    const pages = targets.filter((t) => t.type === "page" && !DESKTOP_SIDE_WINDOWS.test(t.url));
    const wanted = o.origin ? pages.find((t) => t.url.startsWith(o.origin!)) : undefined;
    return wanted ?? pages.find((t) => /codecast\.sh|localhost/.test(t.url)) ?? pages[0] ?? null;
  };
  const alive = await isCdpAlive(port);
  if (!alive) {
    die(
      `no desktop app answers on 127.0.0.1:${port}`,
      "run it from source (cd packages/electron && bun run dev) or set CODECAST_CDP_PORT on a packaged build",
    );
  }
  const first = await pick();
  const origin = o.origin?.replace(/\/+$/, "") ?? (first ? new URL(first.url).origin : PROD_ORIGIN);
  return {
    kind: "desktop",
    origin,
    label: `desktop (cdp 127.0.0.1:${port}) ${origin}`,
    ensurePage: async () => {
      if (!(await pick())) die("the desktop app has no main window to drive");
    },
    attach: async () => {
      const page = await pick();
      if (!page) return { error: "the desktop app has no main window to drive" };
      const conn = await CdpConnection.fromPort(port, 8000);
      try {
        const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", {
          targetId: page.targetId,
          flatten: true,
        });
        return { conn, sessionId, url: page.url };
      } catch (err) {
        conn.close();
        return { error: `could not attach to the desktop window: ${(err as Error).message}` };
      }
    },
  };
}

async function targetFor(o: TargetOpts): Promise<AppTarget> {
  return o.desktop ? desktopTarget(o) : webTarget(o);
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

function die(msg: string, hint?: string): never {
  console.error(`${BAD} ${msg}`);
  if (hint) console.error(fmt.muted(`  ${hint}`));
  process.exit(1);
}

/** Run a script that returns a JSON value; parsed, or a refusal. */
async function evalJson<T>(at: Attached, script: string, timeoutMs = 15_000): Promise<{ ok: true; value: T } | { ok: false; error: string; hint?: string }> {
  const out: EvalOutcome = await evaluateOn(at.conn, at.sessionId, script, timeoutMs);
  if (!out.ok) return { ok: false, error: out.output, hint: out.hint };
  try {
    return { ok: true, value: JSON.parse(out.output) as T };
  } catch {
    return { ok: false, error: `the page answered something that is not JSON: ${out.output.slice(0, 200)}` };
  }
}

/** Attach, run, close — for verbs that need one round trip. */
async function withPage<T>(target: AppTarget, fn: (at: Attached) => Promise<T>): Promise<T> {
  await target.ensurePage();
  const at = await target.attach();
  if ("error" in at) die(at.error, at.hint);
  try {
    return await fn(at);
  } finally {
    at.conn.close();
  }
}

async function navigate(at: Attached, url: string): Promise<void> {
  await at.conn.send("Page.enable", {}, at.sessionId, 5000);
  await at.conn.send("Page.navigate", { url }, at.sessionId, 10_000);
  await at.conn.waitFor((ev) => ev.method === "Page.loadEventFired" && ev.sessionId === at.sessionId, 20_000).catch(() => {});
}

/** Uncaught errors on the page from now until `stop()`. */
function collectErrors(at: Attached): { stop: () => string[] } {
  const errors: string[] = [];
  const off = at.conn.on((ev) => {
    if (ev.sessionId !== at.sessionId) return;
    if (ev.method === "Runtime.exceptionThrown") {
      const d = (ev.params as any)?.exceptionDetails;
      errors.push(d?.exception?.description?.split("\n")[0] ?? d?.text ?? "uncaught exception");
    } else if (ev.method === "Log.entryAdded") {
      const e = (ev.params as any)?.entry;
      if (e?.level === "error") errors.push(`${e.source}: ${e.text}`);
    }
  });
  void at.conn.send("Runtime.enable", {}, at.sessionId, 5000).catch(() => {});
  void at.conn.send("Log.enable", {}, at.sessionId, 5000).catch(() => {});
  return { stop: () => { off(); return errors; } };
}

// ---------------------------------------------------------------------------
// The scripts the page runs
// ---------------------------------------------------------------------------

/** One read of everything doctor and sweep look at. */
const PROBE = `(() => {
  const w = window;
  const store = w.__inboxStore && w.__inboxStore.getState ? w.__inboxStore.getState() : null;
  const cu = store && store.currentUser;
  const sr = w.__syncReplication ? w.__syncReplication() : null;
  const sa = w.__syncActivity || null;
  const nav = w.__navLog ? w.__navLog() : null;
  const jwtKey = Object.keys(localStorage).find((k) => k.startsWith("__convexAuthJWT"));
  const boundary = document.querySelector("[data-error-boundary]");
  const root = document.getElementById("root");
  return {
    href: location.href,
    title: document.title,
    readyState: document.readyState,
    build: w.__CODECAST_BUILD || null,
    devHandles: !!store,
    electron: !!w.__CODECAST_ELECTRON__,
    rootRendered: !!(root && root.children.length > 0),
    crashed: boundary ? boundary.getAttribute("data-error-boundary") : null,
    signedIn: !!(jwtKey && localStorage.getItem(jwtKey)),
    user: cu ? { id: String(cu._id), email: cu.email || null, name: cu.name || null } : null,
    activeTeam: store && store.clientState && store.clientState.ui ? store.clientState.ui.active_team_id || null : null,
    syncRole: (store && store.syncRole) || (sr && sr.role) || null,
    replication: sr,
    pendingSends: store ? Object.values(store.pendingMessages || {}).flat().length : null,
    inflight: sa ? sa.inflight().total : null,
    clientStateInitialized: store ? store.clientStateInitialized : null,
    lastNav: nav && nav.length ? nav[nav.length - 1] : null,
  };
})()`;

/** Wait until catch-up is quiet: nothing in flight, no pending sends, no row apply for QUIET ms. */
function settleScript(timeoutMs: number, quietMs: number): string {
  return `(async () => {
  const started = Date.now();
  const deadline = started + ${timeoutMs};
  const sa = window.__syncActivity || null;
  const st = () => (window.__inboxStore && window.__inboxStore.getState ? window.__inboxStore.getState() : null);
  let quietSince = null, lastSeq = -1, last = null;
  while (Date.now() < deadline) {
    const s = st();
    const seq = sa ? sa.applySeq() : 0;
    const inflight = sa ? sa.inflight().total : 0;
    const pending = s ? Object.values(s.pendingMessages || {}).flat().length : 0;
    const init = s ? s.clientStateInitialized !== false : document.readyState === "complete";
    last = { inflight, pending, init, seq };
    const quiet = init && inflight === 0 && pending === 0 && seq === lastSeq;
    if (quiet) {
      if (quietSince == null) quietSince = Date.now();
      if (Date.now() - quietSince >= ${quietMs}) return { settled: true, waitedMs: Date.now() - started, ...last };
    } else {
      quietSince = null;
    }
    lastSeq = seq;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { settled: false, waitedMs: Date.now() - started, ...last };
})()`;
}

interface Probe {
  href: string;
  title: string;
  readyState: string;
  build: { sha: string; builtAt: string; mode: string } | null;
  devHandles: boolean;
  electron: boolean;
  rootRendered: boolean;
  crashed: string | null;
  signedIn: boolean;
  user: { id: string; email: string | null; name: string | null } | null;
  activeTeam: string | null;
  syncRole: string | null;
  replication: { role: string; elected: boolean; holdsLock: boolean; synced: boolean } | null;
  pendingSends: number | null;
  inflight: number | null;
  clientStateInitialized: boolean | null;
  lastNav: { field: string; from: string | null; to: string | null; source: string; blocked?: string } | null;
}

interface Settle {
  settled: boolean;
  waitedMs: number;
  inflight: number;
  pending: number;
  init: boolean;
  seq: number;
}

async function probe(at: Attached): Promise<Probe> {
  const r = await evalJson<Probe>(at, PROBE);
  if (!r.ok) die(`could not read the app: ${r.error}`, r.hint);
  return r.value;
}

async function settle(at: Attached, timeoutMs: number, quietMs = 400): Promise<Settle> {
  const r = await evalJson<Settle>(at, settleScript(timeoutMs, quietMs), timeoutMs + 5000);
  if (!r.ok) die(`could not wait for the app to settle: ${r.error}`, r.hint);
  return r.value;
}

// ---------------------------------------------------------------------------
// CLI-side facts
// ---------------------------------------------------------------------------

function cliConfig(): { user_id?: string; convex_url?: string; web_url?: string } {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".codecast", "config.json"), "utf-8"));
  } catch {
    return {};
  }
}

/** The repo checkout that owns packages/convex/run.sh, or null. */
async function codecastCheckout(): Promise<string | null> {
  const root = await repoRootFor(process.env.CODECAST_CWD || process.cwd());
  if (root && fs.existsSync(path.join(root, "packages", "convex", "run.sh"))) return root;
  return null;
}

/** The web's localStorage key layout (lib/localAuth.ts): base + "_" + url with non-alphanumerics stripped. */
function authKeys(convexUrl: string): { jwt: string; refresh: string } {
  const ns = convexUrl.replace(/[^a-zA-Z0-9]/g, "");
  return { jwt: `__convexAuthJWT_${ns}`, refresh: `__convexAuthRefreshToken_${ns}` };
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

function short(sha: string | undefined): string {
  return sha ? sha.slice(0, 10) : "unknown";
}

async function doctor(o: TargetOpts & { json?: boolean }): Promise<void> {
  const target = await targetFor(o);
  const cfg = cliConfig();
  const checks: { name: string; status: "pass" | "warn" | "fail"; detail: string }[] = [];
  const add = (name: string, status: "pass" | "warn" | "fail", detail: string) => checks.push({ name, status, detail });

  const p = await withPage(target, async (at) => {
    const pr = await probe(at);
    const s = await settle(at, 10_000);
    return { pr, s };
  });
  const { pr, s } = p;

  add("target", "pass", target.label);
  add("page", pr.rootRendered && !pr.crashed ? "pass" : "fail",
    pr.crashed ? `${pr.href} — "${pr.crashed}" crashed into its error boundary` : `${pr.href} (${pr.readyState})`);
  add("build", pr.build ? "pass" : "warn",
    pr.build ? `${short(pr.build.sha)} ${pr.build.mode}, built ${pr.build.builtAt}` : "no build identity on the page (bundle predates window.__CODECAST_BUILD)");
  if (pr.build && target.origin === LOCAL_ORIGIN) {
    const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).stdout?.trim();
    if (head && pr.build.sha !== "unknown" && head !== pr.build.sha) {
      add("freshness", "warn", `page built from ${short(pr.build.sha)}, tree is at ${short(head)} — the dev server started on another commit`);
    } else if (head) {
      add("freshness", "pass", `page and tree agree on ${short(head)}`);
    }
  }
  add("handles", pr.devHandles ? "pass" : "warn",
    pr.devHandles ? "dev handles present (__inboxStore); store-level verbs available" : "production bundle: no __inboxStore, drive through the UI only");
  add("signed in", pr.signedIn ? "pass" : "fail",
    pr.signedIn
      ? pr.user ? `${pr.user.email ?? pr.user.name ?? "?"} (${pr.user.id})` : "token present (identity unreadable without dev handles)"
      : "no auth token in localStorage — cast browser login, or cast app as-user <email>");
  if (pr.user && cfg.user_id) {
    add("daemon owner", pr.user.id === cfg.user_id ? "pass" : "warn",
      pr.user.id === cfg.user_id
        ? "the page's user owns this machine's daemon"
        : `page user ${pr.user.id} is not this daemon's user ${cfg.user_id} — daemon-backed surfaces (terminal, vault, device commands) will read as offline`);
  }
  add("workspace", "pass", pr.activeTeam ? `team ${pr.activeTeam}` : "personal");
  add("sync", pr.syncRole ? "pass" : "warn",
    pr.syncRole
      ? `${pr.syncRole}${pr.replication ? ` (elected ${pr.replication.elected}, synced ${pr.replication.synced})` : ""}`
      : "no sync role reported");
  add("settled", s.settled ? "pass" : "warn",
    s.settled
      ? `quiet after ${s.waitedMs}ms`
      : `still busy after ${s.waitedMs}ms: inflight ${s.inflight}, pending sends ${s.pending}, client state ${s.init ? "ready" : "hydrating"}`);
  add("desktop", pr.electron ? "pass" : "pass", pr.electron ? "page runs inside the desktop shell" : "browser page");

  const failed = checks.filter((k) => k.status === "fail");
  if (o.json) {
    console.log(JSON.stringify({ ok: failed.length === 0, target: target.label, origin: target.origin, checks, probe: pr, settle: s }, null, 2));
  } else {
    console.log(`\n  ${c.bold}cast app doctor${c.reset}\n`);
    for (const k of checks) {
      const glyph = k.status === "pass" ? OK : k.status === "warn" ? WARN : BAD;
      console.log(`  ${glyph} ${k.name.padEnd(13)} ${k.detail}`);
    }
    console.log("");
    console.log(failed.length ? `${BAD} not drivable: ${failed.map((k) => k.name).join(", ")}` : `${OK} drivable`);
  }
  process.exit(failed.length ? 1 : 0);
}

function surfaces(o: { json?: boolean; kind?: string }): void {
  const list = o.kind ? APP_SURFACES.filter((s) => s.kind === o.kind) : APP_SURFACES;
  if (o.json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  for (const s of list) console.log(`  ${s.name.padEnd(22)} ${fmt.muted(s.kind.padEnd(11))} ${s.what}`);
}

const SHORT_ID = /^[a-z0-9]{7}$/;
const CONVEX_ID = /^[a-z0-9]{32}$/;

/** Navigate by surface name, path, or conversation id; confirm where the app landed. */
async function goto(what: string, o: TargetOpts & { timeout?: string; json?: boolean }): Promise<void> {
  const target = await targetFor(o);
  const timeoutMs = Number(o.timeout ?? 15_000);
  const surface = findAppSurface(what);
  const isId = SHORT_ID.test(what) || CONVEX_ID.test(what);

  const result = await withPage(target, async (at) => {
    const errs = collectErrors(at);
    let how: string;
    if (surface) {
      how = `open ${surface.path}`;
      await navigate(at, `${target.origin}${surface.path}`);
    } else if (isId) {
      // A conversation. With the store handle, go through the app's own
      // navigation guard so the move is audited like a click; without it, the
      // URL route does the same thing with a reload.
      const before = await probe(at);
      if (before.devHandles) {
        const r = await evalJson<{ ok: boolean; id?: string; reason?: string }>(at, `(() => {
          const s = window.__inboxStore.getState();
          const want = ${JSON.stringify(what)};
          const rows = Object.values(s.conversations || {}).concat(Object.values(s.sessions || {}));
          const row = rows.find((r) => r && String(r._id) === want) || rows.find((r) => r && String(r._id).startsWith(want));
          if (!row) return { ok: false, reason: "no conversation with that id in the local store" };
          s.requestNavigate(String(row._id));
          return { ok: true, id: String(row._id) };
        })()`);
        if (!r.ok) die(`could not navigate: ${r.error}`, r.hint);
        if (!r.value.ok) {
          how = `open /conversation/${what} (${r.value.reason})`;
          await navigate(at, `${target.origin}/conversation/${what}`);
        } else {
          how = `requestNavigate(${r.value.id})`;
        }
      } else {
        how = `open /conversation/${what}`;
        await navigate(at, `${target.origin}/conversation/${what}`);
      }
    } else if (what.startsWith("/")) {
      how = `open ${what}`;
      await navigate(at, `${target.origin}${what}`);
    } else {
      die(`"${what}" is not a surface, a path, or a conversation id`, "cast app surfaces");
    }
    const s = await settle(at, timeoutMs);
    const after = await probe(at);
    const errors = errs.stop();
    return { how, settle: s, probe: after, errors };
  });

  const { how, probe: after, errors } = result;
  const blocked = after.lastNav?.blocked;
  const ok = after.rootRendered && !after.crashed && !blocked && !/\/login(\?|$)/.test(after.href);
  if (o.json) {
    console.log(JSON.stringify({ ok, how, href: after.href, title: after.title, crashed: after.crashed, blocked: blocked ?? null, settled: result.settle, errors }, null, 2));
  } else {
    console.log(`${ok ? OK : BAD} ${how} → ${after.href}${after.title ? fmt.muted(` — ${after.title}`) : ""}`);
    if (after.crashed) console.log(`  ${BAD} "${after.crashed}" crashed into its error boundary`);
    if (blocked) console.log(`  ${BAD} the navigation guard blocked the move: ${blocked}`);
    if (/\/login(\?|$)/.test(after.href)) console.log(`  ${BAD} landed on /login — not signed in (cast app as-user <email>)`);
    if (!result.settle.settled) console.log(`  ${WARN} not settled after ${result.settle.waitedMs}ms (inflight ${result.settle.inflight}, pending ${result.settle.pending})`);
    for (const e of errors.slice(0, 6)) console.log(`  ${WARN} ${e}`);
  }
  process.exit(ok ? 0 : 1);
}

async function waitSettle(o: TargetOpts & { timeout?: string; quiet?: string; json?: boolean }): Promise<void> {
  const target = await targetFor(o);
  const s = await withPage(target, (at) => settle(at, Number(o.timeout ?? 30_000), Number(o.quiet ?? 400)));
  if (o.json) console.log(JSON.stringify(s));
  else if (s.settled) console.log(`${OK} settled after ${s.waitedMs}ms`);
  else console.log(`${BAD} not settled after ${s.waitedMs}ms: inflight ${s.inflight}, pending sends ${s.pending}, client state ${s.init ? "ready" : "hydrating"}`);
  process.exit(s.settled ? 0 : 1);
}

interface SweepRow {
  name: string;
  path: string;
  ok: boolean;
  href: string;
  ms: number;
  problems: string[];
}

/** Walk every surface: open, settle, check it rendered without crashing or erroring. */
async function sweep(o: TargetOpts & { only?: string; kind?: string; timeout?: string; json?: boolean }): Promise<void> {
  const target = await targetFor(o);
  const timeoutMs = Number(o.timeout ?? 15_000);
  let list: AppSurface[] = o.kind ? APP_SURFACES.filter((s) => s.kind === o.kind) : APP_SURFACES;
  if (o.only) {
    const names = o.only.split(",").map((n) => n.trim()).filter(Boolean);
    list = names.map((n) => findAppSurface(n) ?? die(`"${n}" is not a surface`, "cast app surfaces"));
  }

  const rows: SweepRow[] = [];
  await withPage(target, async (at) => {
    const first = await probe(at);
    if (!first.signedIn) die("not signed in — a sweep of signed-in surfaces would only measure the login page", "cast app as-user <email>");
    if (!o.json) console.log(`\n  ${c.bold}cast app sweep${c.reset} ${fmt.muted(`${list.length} surfaces on ${target.label}`)}\n`);
    for (const s of list) {
      const t0 = Date.now();
      const errs = collectErrors(at);
      const problems: string[] = [];
      let href = "";
      try {
        await navigate(at, `${target.origin}${s.path}`);
        const st = await settle(at, timeoutMs);
        const pr = await probe(at);
        href = pr.href;
        if (!pr.rootRendered) problems.push("nothing rendered under #root");
        if (pr.crashed) problems.push(`"${pr.crashed}" crashed into its error boundary`);
        if (/\/login(\?|$)/.test(pr.href)) problems.push("redirected to /login");
        else if (!pr.href.startsWith(`${target.origin}${s.path}`)) problems.push(`landed on ${new URL(pr.href).pathname} instead`);
        if (!st.settled) problems.push(`not settled after ${st.waitedMs}ms (inflight ${st.inflight}, pending ${st.pending})`);
      } catch (err) {
        problems.push((err as Error).message);
      }
      for (const e of errs.stop().slice(0, 4)) problems.push(`error: ${e}`);
      const row: SweepRow = { name: s.name, path: s.path, ok: problems.length === 0, href, ms: Date.now() - t0 };
      rows.push({ ...row, problems });
      if (!o.json) {
        console.log(`  ${row.ok ? OK : BAD} ${s.name.padEnd(22)} ${fmt.muted(`${row.ms}ms`)}`);
        for (const p of problems) console.log(`      ${p}`);
      }
    }
  });

  const failed = rows.filter((r) => !r.ok);
  if (o.json) {
    console.log(JSON.stringify({ ok: failed.length === 0, target: target.label, origin: target.origin, surfaces: rows }, null, 2));
  } else {
    console.log("");
    console.log(failed.length ? `${BAD} ${failed.length} of ${rows.length} surfaces failed: ${failed.map((r) => r.name).join(", ")}` : `${OK} all ${rows.length} surfaces render`);
  }
  process.exit(failed.length ? 1 : 0);
}

/** Become a named account for this run (or `--restore` the one that was there). */
async function asUser(who: string | undefined, o: TargetOpts & { restore?: boolean; json?: boolean }): Promise<void> {
  const target = await targetFor(o);
  const cfg = cliConfig();
  const convexUrl = cfg.convex_url || "https://convex.codecast.sh";
  const keys = authKeys(convexUrl);
  const landing = `${target.origin}/inbox`;

  if (o.restore) {
    const r = await withPage(target, (at) => evalJson<{ ok: boolean; reason?: string }>(at, `(() => {
      const saved = localStorage.getItem("__castApp_savedAuth");
      if (!saved) return { ok: false, reason: "nothing saved by a previous cast app as-user" };
      const pair = JSON.parse(saved);
      if (pair.jwt) localStorage.setItem(${JSON.stringify(keys.jwt)}, pair.jwt); else localStorage.removeItem(${JSON.stringify(keys.jwt)});
      if (pair.refresh) localStorage.setItem(${JSON.stringify(keys.refresh)}, pair.refresh); else localStorage.removeItem(${JSON.stringify(keys.refresh)});
      localStorage.removeItem("__castApp_savedAuth");
      location.replace(${JSON.stringify(landing)});
      return { ok: true };
    })()`));
    if (!r.ok) die(`could not restore: ${r.error}`, r.hint);
    if (!r.value.ok) die(r.value.reason!);
    console.log(`${OK} restored the previous identity; reloading ${landing}`);
    return;
  }

  if (!who) die("who? an email or a user id", "cast app as-user someone@example.com");
  const root = await codecastCheckout();
  if (!root) die("minting a session needs the codecast checkout (packages/convex/run.sh with the admin key)", "run from ~/src/codecast");
  const args = who.includes("@") ? { email: who } : { user_id: who };
  const res = spawnSync("bash", [path.join(root, "packages", "convex", "run.sh"), "verification:mintSession", JSON.stringify(args)], {
    encoding: "utf-8", cwd: root, timeout: 60_000,
  });
  if (res.status !== 0) die(`minting failed: ${(res.stderr || res.stdout).trim().split("\n").slice(-3).join(" | ")}`, "is verification.ts deployed? packages/convex/deploy.sh");
  let minted: { user: { _id: string; email?: string; name?: string }; token: string; refreshToken: string };
  try {
    const jsonStart = res.stdout.indexOf("{");
    minted = JSON.parse(res.stdout.slice(jsonStart));
  } catch {
    die(`could not read the minted session: ${res.stdout.slice(0, 200)}`);
  }

  // Save the current pair, swap in the new one and reload in the SAME task:
  // if the live auth client gets a turn in between, it rotates the fresh
  // refresh token and the reloaded document boots signed out.
  const r = await withPage(target, (at) => evalJson<{ ok: boolean; hadIdentity: boolean }>(at, `(() => {
    const jwtKey = ${JSON.stringify(keys.jwt)}, refKey = ${JSON.stringify(keys.refresh)};
    if (!localStorage.getItem("__castApp_savedAuth")) {
      localStorage.setItem("__castApp_savedAuth", JSON.stringify({ jwt: localStorage.getItem(jwtKey), refresh: localStorage.getItem(refKey) }));
    }
    const had = !!localStorage.getItem(jwtKey);
    localStorage.setItem(jwtKey, ${JSON.stringify(minted.token)});
    localStorage.setItem(refKey, ${JSON.stringify(minted.refreshToken)});
    location.replace(${JSON.stringify(landing)});
    return { ok: true, hadIdentity: had };
  })()`));
  if (!r.ok) die(`could not sign in on the page: ${r.error}`, r.hint);
  const label = minted.user.email ?? minted.user.name ?? minted.user._id;
  if (o.json) console.log(JSON.stringify({ ok: true, user: minted.user, restoredBy: "cast app as-user --restore" }));
  else {
    console.log(`${OK} signed in as ${label} (${minted.user._id}); reloading ${landing}`);
    console.log(fmt.muted(`  the previous identity is saved on the page — cast app as-user --restore puts it back`));
  }
}

async function shot(pathArg: string | undefined, o: TargetOpts & { inline?: boolean }): Promise<void> {
  const target = await targetFor(o);
  const out = pathArg ?? path.join(os.tmpdir(), `cast-app-${Date.now()}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await withPage(target, async (at) => {
    const res = await at.conn.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, at.sessionId, 20_000);
    fs.writeFileSync(out, Buffer.from(res.data, "base64"));
  });
  console.log(`${OK} ${out}`);
  if (o.inline !== false) console.log(inlineImageMarker(path.resolve(out)));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function targetFlags<T extends Command>(cmd: T): T {
  cmd.option("--desktop", `drive the desktop app over its CDP port (${DESKTOP_CDP_PORT}) instead of this session's tab`);
  cmd.option("--origin <url>", "app origin (default: local dev when it answers, else production)");
  return cmd;
}

export function registerAppCommand(program: Command): void {
  const app = program
    .command("app")
    .description("Drive and verify the codecast app itself: doctor, goto, sweep, wait-settle, as-user")
    .addHelpText("after", `
The loop: doctor (is this page worth driving?), goto a surface or conversation,
wait-settle, then prove with cast browser (snapshot, get text, shot) or eval.

  cast app doctor                      origin, build, account, sync role, settled?
  cast app goto tasks                  a surface by name (cast app surfaces lists them)
  cast app goto jx7abcd                a conversation by short id, through the app's own guard
  cast app wait-settle                 catch-up quiet, outbox empty
  cast app sweep --json                every surface: rendered, no crash, no errors
  cast app as-user demo@example.com    a known identity for the run (--restore puts yours back)
  cast app --desktop doctor            the same against the desktop app (from-source run, port 9333)
`);

  targetFlags(app.command("doctor").description("Is this page worth driving? origin, build, account, daemon owner, sync role, settled; exit 1 if not"))
    .option("--json", "machine-readable report")
    .action((o) => doctor(o));

  app.command("surfaces").description("The surfaces cast app goto accepts and sweep walks")
    .option("--json", "as JSON")
    .option("--kind <kind>", "dashboard | standalone | settings")
    .action((o) => surfaces(o));

  targetFlags(app.command("goto").description("Navigate to a surface name, a path, or a conversation id; wait for settle; confirm where it landed"))
    .argument("<what>", "surface name (cast app surfaces), /path, or conversation id")
    .option("--timeout <ms>", "settle timeout", "15000")
    .option("--json", "machine-readable result")
    .action((what, o) => goto(what, o));

  targetFlags(app.command("wait-settle").description("Wait until sync catch-up is quiet and the outbox is empty"))
    .option("--timeout <ms>", "give up after", "30000")
    .option("--quiet <ms>", "how long it must stay quiet", "400")
    .option("--json", "as JSON")
    .action((o) => waitSettle(o));

  targetFlags(app.command("sweep").description("Open every surface and report the ones that fail to render, crash, redirect or throw"))
    .option("--only <names>", "comma-separated surface names")
    .option("--kind <kind>", "dashboard | standalone | settings")
    .option("--timeout <ms>", "settle timeout per surface", "15000")
    .option("--json", "machine-readable report")
    .action((o) => sweep(o));

  targetFlags(app.command("as-user").description("Sign the page in as a named account for this run (mints a real session; needs the codecast checkout)"))
    .argument("[who]", "email or user id")
    .option("--restore", "put back the identity that was there before")
    .option("--json", "as JSON")
    .action((who, o) => asUser(who, o));

  targetFlags(app.command("shot").description("Screenshot the app page into the conversation (works for --desktop too)"))
    .argument("[path]", "where to write the png")
    .option("--no-inline", "do not show it in the conversation")
    .action((p, o) => shot(p, o));
}
