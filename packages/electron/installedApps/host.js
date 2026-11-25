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
//                          uninstallApp(slug)}
//   pageOrigin          https://a.codecast.sh (a from-source run may point elsewhere)
//   appsDir             <userData>/apps: per-app icons
//   imaging             icons.nativeImaging(nativeImage)
//   shell               electron.shell (cast.app.shell.open)
//   askAgent(slug, prompt) -> {answer}  (cast.app.agent.ask); absent refuses
//   shellAlive()        whether a shell window is up to feed facts
//   fetchImpl           fetch, for the icon and the ?app=1 fallback
//
// A platform host (electronHost.js, macHost.js) returns:
//   name, emit(slug, event, data), open(slug, {surface}), reload(slug),
//   isOpen(slug), anchor(slug) -> bounds | null, install({record, info, icons})
//   -> record patch, uninstall(record), closeAll(), and every engine host
//   method (engine.HOST_METHODS) except agent.ask and shell.open, which run
//   here for both. Optional: resealAll(), serve() (the mac host's shim socket,
//   <userData>/apps.sock, mode 0600), stop(), reregisterShortcuts().
const fs = require("node:fs");
const path = require("node:path");
const { createEngine, grantsFor, HOST_METHODS } = require("./engine");
const { AppError } = require("./protocol");
const { isSlug } = require("./registry");
const { resolvePath } = require("./fullAccess");
const { fetchPng, writeIconSet } = require("./icons");

const APP_ARG = "--codecast-app=";
const POLL_MS = 60_000;

/** appInfo's relation in the engine's words. */
const RELATION = { owner: "own", team: "team", other: "outside", anonymous: "outside" };

/** The facts the engine decides by, from a stored appInfo answer. */
function engineFacts(info) {
  if (!info) return null;
  return {
    version: Number(info.version) || 0,
    relation: RELATION[info.relation] || "outside",
    policy: info.policy && typeof info.policy === "object" ? info.policy : { install: true, fullAccess: false },
    requested: (info.app && Array.isArray(info.app.permissions)) ? info.app.permissions : [],
  };
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

const gateQuery = (gate, keys) => keys.filter((k) => gate[k]).map((k) => `&${k}=${encodeURIComponent(gate[k])}`).join("");

function createAppsHost(deps) {
  const { registry, consent, ipc, broadcast, pageOrigin, appsDir, fetchImpl = fetch, shellAlive = () => true } = deps;
  const log = deps.log || ((...a) => console.warn("[apps]", ...a));
  const reviewAsked = new Map(); // slug -> version a review was opened for
  let engine = null;
  let platform = null;

  const pageUrl = (slug, surface = "window") =>
    `${pageOrigin}/${slug}?host=app&surface=${surface}${gateQuery(registry.gateOf(slug), ["k", "e", "m"])}`;

  // ── the engine's view of an app ──
  const adapter = {
    consent: (req) => askConsent(req),
    emit: (slug, event, data) => platform.emit(slug, event, data),
    "agent.ask": async (ctx, prompt) => {
      if (!deps.askAgent) throw new AppError("failed", "asking your agent is not available in this version of Codecast");
      return deps.askAgent(ctx.slug, prompt);
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
        info: { ...record.facts, version },
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

  /** A new appInfo answer for an installed slug, from the shell or the fallback fetch. */
  function takeFacts(slug, info) {
    if (!isSlug(slug) || !info || info.slug !== slug || appInfoProblem(info)) return false;
    if (!registry.get(slug)) return false;
    const { changed, prevVersion } = registry.setFacts(slug, info);
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
      takeFacts(slug, await res.json());
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
        info: record.facts,
        asked: [...new Set([...held, ...requested])],
        current: held,
        added: requested.filter((p) => !held.includes(p)),
      },
      platform.anchor(slug),
    );
    if (answer && registry.get(slug)) engine.grant(slug, answer.grants, version, engineFacts(registry.get(slug).facts));
  }

  // ── the shell's view: apps.list and onChange ──
  function list() {
    return registry.list().map((record) => {
      const facts = record.facts || {};
      const version = Number(facts.version) || 0;
      const grants = Array.isArray(record.grants) ? record.grants : [];
      return {
        slug: record.slug,
        name: record.name,
        iconUrl: (facts.icons && (facts.icons["512"] || facts.icons["1024"])) || null,
        version,
        grantedVersion: Number(record.grantedVersion) || 0,
        grants,
        requested: engineFacts(facts).requested,
        needsReview: grants.length > 0 && (Number(record.grantedVersion) || 0) < version,
        platform: process.platform,
      };
    });
  }

  let changeQueued = false;
  registry.onChange(() => {
    if (changeQueued) return;
    changeQueued = true;
    setImmediate(() => {
      changeQueued = false;
      broadcast("apps:changed", list());
    });
  });

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

  // ── wiring ──
  /** Builds the platform host and the engine. Call once, when Electron is ready. */
  function start() {
    platform = deps.createPlatform({
      registry,
      pageOrigin,
      pageUrl,
      uninstallApp: (slug) => uninstall(slug),
      call: (slug, frame, msg) => engine.handle(slug, frame, msg),
      onFocus: (slug) => {
        if (!shellAlive()) fetchFacts(slug);
      },
      onClosed: (slug) => {
        if (!platform.isOpen(slug)) engine.release(slug);
      },
    });
    const full = { ...adapter };
    // The platform's own wins; a method it lacks (other than the shared two)
    // leaves a gap the engine refuses at startup.
    for (const key of HOST_METHODS) {
      if (typeof platform[key] === "function") full[key] = (...args) => platform[key](...args);
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
    ipc.handle("apps:consent-get", (_e, id) => consent.get(id));
    ipc.handle("apps:consent-answer", (_e, id, answer) => consent.answer(id, answer));
  }

  /** A launch or second instance carrying --codecast-app=<slug>: open it. True when it asked for an app. */
  function handleArgv(argv) {
    const slug = appFromArgv(argv);
    if (!slug) return false;
    if (engine && registry.get(slug)) open(slug).catch((err) => log(`open ${slug}: ${err.message}`));
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

module.exports = { createAppsHost, engineFacts, appInfoProblem, appFromArgv, APP_ARG };
