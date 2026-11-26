// The installed-app host in Codecast's main process
// (docs/architecture/installed-apps.md). It wires the one engine (engine.js)
// to the registry (registry.js), the facts the shell's web app feeds in, the
// consent sheet (consentWindow.js) and a platform host, and answers the shell's
// apps.* bridge.
//
// createAppsHost(deps)
//   registry            createRegistry(...)
//   consent             createConsentWindows(...)
//   ipc                 the shell's IPC door (shellAuthority.ipc): it admits only
//                       shell windows' main frames, so every apps.* call here
//                       comes from codecast's own web app
//   broadcast(ch, data) send to every shell window
//   createPlatform(d)   builds the platform host from the deps below (d):
//                         {call(slug, frame, msg), onFocus(slug), onClosed(slug),
//                          pageUrl(slug, surface), pageOrigin, registry,
//                          uninstallApp(slug), signedIn(), onStatus(slug),
//                          openInCodecast(slug)}
//   pageOrigin          https://a.codecast.sh (a from-source run may point elsewhere)
//   appsDir             <userData>/apps: per-app icons
//   imaging             icons.nativeImaging(nativeImage)
//   shell               electron.shell (cast.app.shell.open)
//   askAgent(slug, prompt, {name}) -> {answer}  (cast.app.agent.ask); absent refuses
//   openInCodecast(slug) shows the page inside Codecast's main window
//   openRoute(route)    shows a codecast path (cast.app.openInCodecast) in
//                       Codecast's window and brings it forward
//   showCodecast()      brings Codecast's main window forward (a launch for an
//                       app that is not installed here)
//   confirmUninstall(name) -> Promise<boolean>  the native "Uninstall <Name>?"
//                       question a codecast://uninstall/<slug> link asks
//   settings            settingsFile.js's load/update: keeps the last sign-in
//                       state the web app reported (installedAppsSignedIn)
//   shellAlive()        whether a shell window is up to feed facts
//   fetchImpl           fetch, for the icon and the ?app=1 fallback
//
// A platform host (electronHost.js, macHost.js) returns:
//   name, emit(slug, event, data), open(slug, {surface}), reload(slug),
//   isOpen(slug), anchor(slug) -> bounds | null, install({record, info, icons})
//   -> record patch, uninstall(record), closeAll(), and every engine host
//   method (engine.HOST_METHODS) except engine.MAIN_METHODS (agent.ask,
//   shell.open, app.openInCodecast), which run here for both. Optional:
//   resealAll(), serve() (the mac host's shim socket,
//   <userData>/apps.sock, mode 0600), stop(), reregisterShortcuts(),
//   setSignedIn(on) (Codecast's sign-in changed), status(slug) -> {running,
//   notifications, notificationSettingsUrl, ...} (what Settings shows).
const fs = require("node:fs");
const path = require("node:path");
const { createEngine, grantsFor, HOST_METHODS, MAIN_METHODS } = require("./engine");
const { AppError } = require("./protocol");
const { isSlug } = require("./registry");
const { resolvePath } = require("./fullAccess");
const { fetchPng, writeIconSet } = require("./icons");

const APP_ARG = "--codecast-app=";
const POLL_MS = 60_000;
const SIGNED_IN_KEY = "installedAppsSignedIn";
/** What Settings shows from a platform's status(slug), beside the record. */
const STATUS_FIELDS = ["running", "notifications", "notificationSettingsUrl"];
const RELATIONS = new Set(["owner", "team", "other", "anonymous"]);

/** The facts the engine decides by, from a stored appInfo answer. */
function engineFacts(info) {
  if (!info) return null;
  return {
    version: Number(info.version) || 0,
    relation: RELATIONS.has(info.relation) ? info.relation : "anonymous",
    policy: info.policy && typeof info.policy === "object" ? info.policy : { install: true, fullAccess: false },
    requested: (info.app && Array.isArray(info.app.permissions)) ? info.app.permissions : [],
  };
}

const RELATION_RANK = { anonymous: 0, other: 1, team: 2, owner: 3 };

/**
 * A fallback ?app=1 answer held to the facts the shell's signed-in appInfo
 * last gave. The fallback proves no one at this computer: its viewer is
 * whoever the stored keys name (a team gate's m token is minted for one
 * member, and a link the page's owner forwards carries the owner's), so its
 * relation could say "owner" for a page that is not the person's. It may
 * lower the relation and tighten the policy, never raise or loosen them; the
 * shell's next answer sets both again.
 */
function heldToStored(info, stored) {
  const was = (stored && stored.relation) || "anonymous";
  const now = RELATION_RANK[info.relation] === undefined ? "anonymous" : info.relation;
  const relation = (RELATION_RANK[now] <= (RELATION_RANK[was] ?? 0)) ? now : was;
  const a = (info.policy && typeof info.policy === "object") ? info.policy : {};
  const b = (stored && stored.policy && typeof stored.policy === "object") ? stored.policy : {};
  return { ...info, relation, policy: { install: a.install !== false && b.install !== false, fullAccess: a.fullAccess === true && b.fullAccess === true } };
}

/** facts with their icon URLs carrying the install's gate keys again (registry.factsOf keeps them out of settings.json). */
function withIconKeys(facts, gate) {
  if (!facts || !facts.icons || typeof facts.icons !== "object") return facts;
  const icons = {};
  for (const [size, url] of Object.entries(facts.icons)) {
    if (typeof url !== "string" || !URL.canParse(url)) continue;
    const u = new URL(url);
    for (const k of ["k", "e", "m"]) if (gate[k]) u.searchParams.set(k, gate[k]);
    icons[size] = u.toString();
  }
  return { ...facts, icons };
}

/** Why an appInfo answer cannot be installed from, or null. */
function appInfoProblem(info) {
  if (!info || typeof info !== "object") return "no app info";
  if (info.error) return String(info.error);
  if (!isSlug(info.slug)) return "app info has no page slug";
  if (!Number.isFinite(Number(info.version))) return "app info has no version";
  if (!info.app || typeof info.app.name !== "string") return "app info has no app block";
  return null;
}

/** The slug a launch asks for (`--codecast-app=<slug>`), or null. */
function appFromArgv(argv) {
  const arg = (argv || []).find((a) => typeof a === "string" && a.startsWith(APP_ARG));
  const slug = arg ? arg.slice(APP_ARG.length) : null;
  return isSlug(slug) ? slug : null;
}

/** The slug a codecast://uninstall/<slug> link names, or null. */
function uninstallSlugFromUrl(url) {
  if (typeof url !== "string" || !URL.canParse(url)) return null;
  const u = new URL(url);
  if (u.protocol !== "codecast:" || u.hostname !== "uninstall") return null;
  // A slug is plain [a-z0-9], so the raw segment is checked as it stands:
  // decoding a malformed escape would throw in the main process.
  const slug = u.pathname.replace(/^\/+|\/+$/g, "");
  return isSlug(slug) ? slug : null;
}

/**
 * The app and tag a clicked Windows toast names (codecast://app-notification/<slug>?tag=<tag>,
 * electronHost.toastLaunchUrl), or null. Any program can open such a link, so it
 * only focuses an installed app and hands its page a notification-click.
 */
function notificationClickFromUrl(url) {
  if (typeof url !== "string" || !URL.canParse(url)) return null;
  const u = new URL(url);
  if (u.protocol !== "codecast:" || u.hostname !== "app-notification") return null;
  const slug = u.pathname.replace(/^\/+|\/+$/g, "");
  if (!isSlug(slug)) return null;
  let tag = null;
  try {
    tag = u.searchParams.get("tag");
  } catch {}
  return { slug, tag: tag ? tag.slice(0, 64) : null };
}

/** The gate keys appInfo takes (k, e, m); the identity token stays in main. */
const pickGate = (gate) => Object.fromEntries(["k", "e", "m"].filter((k) => gate[k]).map((k) => [k, gate[k]]));

const gateQuery = (gate, keys) => keys.filter((k) => gate[k]).map((k) => `&${k}=${encodeURIComponent(gate[k])}`).join("");

function createAppsHost(deps) {
  const { registry, consent, ipc, broadcast, pageOrigin, appsDir, fetchImpl = fetch, shellAlive = () => true } = deps;
  const log = deps.log || ((...a) => console.warn("[apps]", ...a));
  const reviewAsked = new Map(); // slug -> version a review was opened for
  let engine = null;
  let platform = null;
  let pendingUrls = [];
  // The web app reports Codecast's sign-in (apps.setSignedIn). Until it has,
  // the last value it reported holds, and a computer that never heard counts
  // as signed in, so a first launch does not cover every app.
  let signedIn = (() => {
    try {
      const stored = deps.settings && deps.settings.load()[SIGNED_IN_KEY];
      return typeof stored === "boolean" ? stored : true;
    } catch {
      return true;
    }
  })();

  const pageUrl = (slug, surface = "window") =>
    `${pageOrigin}/${slug}?host=app&surface=${surface}${gateQuery(registry.gateOf(slug), ["k", "e", "m"])}`;

  // ── the engine's view of an app ──
  const adapter = {
    consent: (req) => askConsent(req),
    emit: (slug, event, data) => platform.emit(slug, event, data),
    "agent.ask": async (ctx, prompt) => {
      if (!deps.askAgent) throw new AppError("failed", "asking your agent is not available in this version of Codecast");
      return deps.askAgent(ctx.slug, prompt, { name: ctx.record.name });
    },
    "app.openInCodecast": async (_ctx, route) => {
      if (typeof deps.openRoute !== "function") throw new AppError("failed", "opening codecast pages is not available in this version of Codecast");
      await deps.openRoute(route);
    },
    "shell.open": async (_ctx, target) => {
      if (/^(https?|mailto):/i.test(target)) return void (await deps.shell.openExternal(target));
      const problem = await deps.shell.openPath(resolvePath(target));
      if (problem) throw new AppError("failed", problem);
    },
  };

  async function askConsent({ slug, version, requested, granted, fullAccessOffered }) {
    const record = registry.get(slug);
    if (!record || !record.facts) return null;
    const answer = await consent.ask(
      {
        kind: "request",
        info: { ...withIconKeys(record.facts, registry.gateOf(slug)), version },
        asked: requested,
        current: granted,
        added: requested.filter((p) => !granted.includes(p)),
        fullAccessOffered,
      },
      platform.anchor(slug),
    );
    return answer ? answer.grants : null;
  }

  // ── facts ──
  function factsFor(slug) {
    const record = registry.get(slug);
    return record ? engineFacts(record.facts) : null;
  }

  /**
   * A new appInfo answer for an installed slug, from the shell or (`fallback`)
   * the ?app=1 fetch, which may not raise what the shell's answer allowed.
   */
  function takeFacts(slug, info, { fallback = false } = {}) {
    if (!isSlug(slug) || !info || info.slug !== slug || appInfoProblem(info)) return false;
    const record = registry.get(slug);
    if (!record) return false;
    const { changed, prevVersion } = registry.setFacts(slug, fallback ? heldToStored(info, record.facts) : info);
    if (!changed) return false;
    const version = Number(info.version) || 0;
    if (prevVersion !== null && version > prevVersion) {
      platform.emit(slug, "version", { version });
      platform.reload(slug);
      maybeReview(slug);
    }
    return true;
  }

  async function fetchFacts(slug) {
    const gate = registry.gateOf(slug);
    try {
      const res = await fetchImpl(`${pageOrigin}/${slug}?app=1${gateQuery(gate, ["k", "e", "m", "i"])}`, { cache: "no-store" });
      if (!res.ok) return;
      takeFacts(slug, await res.json(), { fallback: true });
    } catch (err) {
      log(`facts fetch for ${slug} failed: ${err.message}`);
    }
  }

  /** Re-asks once per version when the grants an open app holds went stale. */
  async function maybeReview(slug) {
    const record = registry.get(slug);
    if (!record || !record.facts || !platform.isOpen(slug)) return;
    const version = Number(record.facts.version) || 0;
    const held = Array.isArray(record.grants) ? record.grants : [];
    if (!held.length || grantsFor(record, version).length || reviewAsked.get(slug) === version) return;
    reviewAsked.set(slug, version);
    const requested = engineFacts(record.facts).requested;
    const answer = await consent.ask(
      {
        kind: "review",
        info: withIconKeys(record.facts, registry.gateOf(slug)),
        asked: [...new Set([...held, ...requested])],
        current: held,
        added: requested.filter((p) => !held.includes(p)),
      },
      platform.anchor(slug),
    );
    if (answer && registry.get(slug)) engine.grant(slug, answer.grants, version, engineFacts(registry.get(slug).facts));
  }

  // ── the shell's view: apps.list and onChange ──
  function statusOf(slug) {
    if (!platform || typeof platform.status !== "function") return {};
    try {
      const status = platform.status(slug) || {};
      return Object.fromEntries(STATUS_FIELDS.filter((k) => k in status).map((k) => [k, status[k]]));
    } catch (err) {
      log(`status for ${slug}: ${err.message}`);
      return {};
    }
  }

  function list() {
    return registry.list().map((record) => {
      const facts = record.facts || {};
      const version = Number(facts.version) || 0;
      const grants = Array.isArray(record.grants) ? record.grants : [];
      const icons = withIconKeys(facts, registry.gateOf(record.slug)).icons || {};
      return {
        slug: record.slug,
        name: record.name,
        iconUrl: icons["512"] || icons["1024"] || null,
        version,
        grantedVersion: Number(record.grantedVersion) || 0,
        grants,
        requested: engineFacts(facts).requested,
        needsReview: grants.length > 0 && (Number(record.grantedVersion) || 0) < version,
        platform: process.platform,
        // The page's gate keys, so the shell's facts feed can read a gated page.
        gate: pickGate(registry.gateOf(record.slug)),
        ...statusOf(record.slug),
      };
    });
  }

  let changeQueued = false;
  function queueChange() {
    if (changeQueued) return;
    changeQueued = true;
    setImmediate(() => {
      changeQueued = false;
      broadcast("apps:changed", list());
    });
  }
  registry.onChange(queueChange);

  // ── install, open, uninstall ──
  async function makeIcons(slug, info) {
    const url = info.icons && (info.icons["1024"] || info.icons["512"]);
    if (!url || !appsDir || !deps.imaging) return null;
    const png = await fetchPng(url, fetchImpl);
    let trayPng = null;
    const trayIcon = info.app.tray && info.app.tray.icon;
    if (trayIcon) {
      // The bundle file at its page path, behind the same gates.
      trayPng = await fetchPng(`${pageOrigin}/${slug}/${trayIcon}?${gateQuery(registry.gateOf(slug), ["k", "e", "m"]).slice(1)}`, fetchImpl).catch(() => null);
    }
    return writeIconSet({ dir: path.join(appsDir, slug), png, trayPng, imaging: deps.imaging });
  }

  async function install(info) {
    const problem = appInfoProblem(info);
    if (problem) throw new Error(problem);
    if (info.policy && info.policy.install === false) throw new Error("your team does not allow installing apps");
    const slug = info.slug;
    if (registry.get(slug)) {
      // The new answer may carry rotated gate keys and newer facts.
      if (info.gate && typeof info.gate === "object" && Object.keys(info.gate).length) {
        registry.update(slug, { gate: { ...registry.gateOf(slug), ...info.gate } });
      }
      takeFacts(slug, info);
      await open(slug);
      return { installed: true, already: true };
    }
    const requested = engineFacts(info).requested;
    const answer = await consent.ask({ kind: "install", info, asked: requested, current: [], added: requested }, null);
    if (!answer) return { installed: false };
    const record = registry.add({ slug, name: info.app.name, gate: info.gate || {}, facts: info });
    try {
      const icons = await makeIcons(slug, info).catch((err) => (log(`icons for ${slug}: ${err.message}`), null));
      const patch = (await platform.install({ record: registry.get(slug), info, icons })) || {};
      registry.update(slug, { iconPath: icons ? icons.png : null, icons, ...patch });
    } catch (err) {
      registry.remove(slug);
      throw err;
    }
    engine.grant(slug, answer.grants, Number(info.version) || 0, engineFacts(info));
    reviewAsked.set(slug, Number(info.version) || 0);
    await open(slug);
    return { installed: true, slug: record.slug };
  }

  async function open(slug, opts = {}) {
    if (!registry.get(slug)) throw new Error(`${slug} is not installed`);
    await platform.open(slug, opts);
    maybeReview(slug);
  }

  async function uninstall(slug) {
    const record = registry.get(slug);
    if (!record) return false;
    consent.cancelAll(slug);
    await platform.uninstall(record);
    engine.release(slug);
    if (appsDir) fs.rmSync(path.join(appsDir, slug), { recursive: true, force: true });
    reviewAsked.delete(slug);
    registry.remove(slug);
    return true;
  }

  function setGrants(slug, grants) {
    const record = registry.get(slug);
    if (!record || !record.facts) throw new Error(`${slug} is not installed`);
    if (!Array.isArray(grants)) throw new Error("grants must be a list");
    return engine.grant(slug, grants, Number(record.facts.version) || 0, engineFacts(record.facts));
  }

  /** The web app reported Codecast's sign-in. Open apps cover or uncover their page. */
  function setSignedIn(on) {
    const next = !!on;
    if (next === signedIn) return;
    signedIn = next;
    try {
      if (deps.settings) deps.settings.update({ [SIGNED_IN_KEY]: next });
    } catch (err) {
      log(`saving sign-in state: ${err.message}`);
    }
    if (platform && typeof platform.setSignedIn === "function") platform.setSignedIn(next);
  }

  /** codecast://uninstall/<slug>: ask the person natively, then uninstall. */
  // One dialog per slug: a repeat link while it is open is ignored.
  const confirming = new Set();
  async function confirmAndUninstall(slug) {
    const record = registry.get(slug);
    if (!record) return log(`uninstall link for ${slug}: not installed here`);
    if (typeof deps.confirmUninstall !== "function" || confirming.has(slug)) return;
    confirming.add(slug);
    let yes;
    try {
      yes = await deps.confirmUninstall(record.name);
    } finally {
      confirming.delete(slug);
    }
    if (yes) await uninstall(slug);
  }

  /** A codecast:// link this host answers itself. True when it took the link. */
  function handleUrl(url) {
    const click = notificationClickFromUrl(url);
    if (click) {
      if (!engine) pendingUrls.push(url);
      else if (registry.get(click.slug) && platform.notificationClicked) platform.notificationClicked(click.slug, click.tag);
      return true;
    }
    const slug = uninstallSlugFromUrl(url);
    if (!slug) return false;
    if (!engine) pendingUrls.push(url);
    else confirmAndUninstall(slug).catch((err) => log(`uninstall ${slug}: ${err.message}`));
    return true;
  }

  // ── wiring ──
  /** Builds the platform host and the engine. Call once, when Electron is ready. */
  function start() {
    platform = deps.createPlatform({
      registry,
      pageOrigin,
      pageUrl,
      uninstallApp: (slug) => uninstall(slug),
      signedIn: () => signedIn,
      onStatus: () => queueChange(),
      openInCodecast: (slug) => {
        if (typeof deps.openInCodecast !== "function") throw new Error("Codecast cannot open pages yet");
        return deps.openInCodecast(slug);
      },
      call: (slug, frame, msg) => engine.handle(slug, frame, msg),
      onFocus: (slug) => {
        if (!shellAlive()) fetchFacts(slug);
      },
      onClosed: (slug) => {
        if (!platform.isOpen(slug)) engine.release(slug);
      },
    });
    const full = { ...adapter };
    // The platform's own wins, except for the methods main answers on every
    // platform; a method it lacks (other than those) leaves a gap the engine
    // refuses at startup.
    for (const key of HOST_METHODS) {
      if (!MAIN_METHODS.has(key) && typeof platform[key] === "function") full[key] = (...args) => platform[key](...args);
    }
    engine = createEngine({ registry, page: factsFor, adapter: full, ops: deps.ops });
    if (platform.resealAll) {
      try {
        platform.resealAll();
      } catch (err) {
        log(`reseal failed: ${err.message}`);
      }
    }
    // Without a shell window to feed facts, an open app asks the server itself.
    const timer = setInterval(() => {
      if (shellAlive()) return;
      for (const record of registry.list()) if (platform.isOpen(record.slug)) fetchFacts(record.slug);
    }, POLL_MS);
    if (timer.unref) timer.unref();
    if (platform.serve) platform.serve().catch((err) => log(`shim socket: ${err.message}`));
    const held = pendingUrls;
    pendingUrls = [];
    for (const url of held) handleUrl(url);
    return api;
  }

  /** The shell's apps.* bridge. Safe to call before start(): handlers wait for it. */
  function installIpc() {
    const ready = () => {
      if (!engine) throw new Error("installed apps are still starting");
    };
    ipc.handle("apps:list", () => list());
    ipc.handle("apps:install", (_e, info) => (ready(), install(info)));
    ipc.handle("apps:open", (_e, slug, opts) => (ready(), open(slug, { surface: opts && opts.surface === "tray" ? "tray" : "window" })));
    ipc.handle("apps:uninstall", (_e, slug) => (ready(), uninstall(slug)));
    ipc.handle("apps:set-grants", (_e, slug, grants) => (ready(), setGrants(slug, grants)));
    ipc.on("apps:facts", (_e, slug, info) => {
      if (engine) takeFacts(slug, info);
    });
    ipc.on("apps:signed-in", (_e, on) => {
      if (typeof on === "boolean") setSignedIn(on);
    });
    ipc.handle("apps:consent-get", (_e, id) => consent.get(id));
    ipc.handle("apps:consent-answer", (_e, id, answer) => consent.answer(id, answer));
    ipc.on("apps:consent-resize", (_e, id, height) => consent.resize && consent.resize(id, height));
  }

  /**
   * A launch or second instance carrying --codecast-app=<slug>: open it. True
   * when it asked for an app. A slug not installed here (a stale shortcut)
   * brings Codecast forward instead of leaving it hidden.
   */
  function handleArgv(argv) {
    const slug = appFromArgv(argv);
    if (!slug) return false;
    if (engine && registry.get(slug)) open(slug).catch((err) => log(`open ${slug}: ${err.message}`));
    else if (engine) {
      log(`launch for ${slug}: not installed here`);
      if (typeof deps.showCodecast === "function") deps.showCodecast();
    }
    return true;
  }

  function stop() {
    consent.cancelAll();
    if (!platform) return;
    platform.closeAll();
    if (platform.stop) platform.stop();
  }

  const api = {
    start,
    installIpc,
    handleArgv,
    handleUrl,
    setSignedIn,
    get signedIn() {
      return signedIn;
    },
    stop,
    list,
    install,
    open,
    uninstall,
    setGrants,
    takeFacts,
    fetchFacts,
    reregisterShortcuts: () => platform && platform.reregisterShortcuts && platform.reregisterShortcuts(),
    get engine() {
      return engine;
    },
    get platform() {
      return platform;
    },
  };
  return api;
}

module.exports = { createAppsHost, heldToStored, withIconKeys, engineFacts, appInfoProblem, appFromArgv, uninstallSlugFromUrl, notificationClickFromUrl, APP_ARG };
