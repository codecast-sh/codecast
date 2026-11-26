// The one permission engine for installed apps
// (docs/architecture/installed-apps.md). Every cast.app call from either host
// comes through handle(); this module decides it and hands allowed calls to
// the host. Neither host re-decides policy. No electron imports: the Windows
// host calls it in-process, the macOS host on behalf of its shims.
//
// createEngine({registry, page, adapter, ops?, platform?})
//
//   registry.get(slug)           -> the installed-app record or null
//                                   ({slug, name, grantedVersion, grants, ...})
//   registry.update(slug, patch) -> persists a merge over the record
//   page(slug)                   -> (promise of) what the host knows about the page now:
//                                   {version, relation: "owner"|"team"|"other"|"anonymous"
//                                    (appInfo's own words),
//                                    policy: {install, fullAccess}, requested: string[]}
//
//   adapter: the host. Each method gets (ctx, ...args), ctx = {slug, frame, record, page},
//   and returns (a promise of) the value the page receives. Throw an AppError to
//   refuse with a code; anything else thrown becomes `failed`.
//     "app.notify"({title, body?, tag?, silent?})
//     "app.badge"(count)                      0 clears
//     "app.openInCodecast"(route)             a codecast path ("/tasks/ct-1"), shown in Codecast's window
//     "tray.set"({title?, tooltip?, badge?})  "tray.remove"()
//     "shortcuts.register"(accelerator)       "shortcuts.unregister"(accelerator)
//     "window.setSize"(width, height)  "window.setTitle"(title)  "window.focus"()
//     "window.minimize"()  "window.close"()   "window.setAlwaysOnTop"(on)
//     "window.setVisibleOnAllWorkspaces"(on)  "window.setIgnoreMouseEvents"(on)
//     "agent.ask"(prompt) -> {answer}
//     "login.set"(on)
//     "shell.open"(pathOrUrl)
//     consent({slug, name, version, requested, granted, fullAccessOffered})
//                                   -> the complete grant list the person approved for
//                                      this version, or null when they said no
//     emit(slug, event, data)       -> push a host event to the app's open surfaces
//
//   ops: files and programs (fullAccess.js); the engine runs them itself, so full
//   access executes in Codecast's main process on both platforms.
//
// handle(slug, frame, msg) -> reply envelope. `frame` is what the host saw load
// in the calling surface: {version, surface}. The host reads it from the page
// response, never from the page's own word.
//
// tiers.json maps every method to its tier. Its permission list is
// APP_PERMISSIONS in shared/contracts/pageApp.ts, repeated because the packaged
// app runs plain JS; engine.test.js keeps the two equal.
const TIERS = require("./tiers.json");
const { AppError, ok, replyFor } = require("./protocol");
const { createFullAccess } = require("./fullAccess");

const DEFAULT = "default";
const FULL = "full-access";
const ENGINE_METHODS = new Set(["app.info", "permissions.request", "fs.watch", "fs.unwatch"]);
const isOps = (key) => key.startsWith("fs.") || key === "process.run";
/** Methods the host adapter must implement. */
const HOST_METHODS = Object.keys(TIERS.methods).filter((k) => !ENGINE_METHODS.has(k) && !isOps(k));
/** Host methods Codecast's main process answers on every platform (host.js), never a platform host or the shim. */
const MAIN_METHODS = new Set(["agent.ask", "shell.open", "app.openInCodecast"]);

// ── global shortcuts: at least two modifiers and one key ──
const MODIFIERS = {
  command: "cmd", cmd: "cmd", control: "ctrl", ctrl: "ctrl",
  commandorcontrol: "cmdorctrl", cmdorctrl: "cmdorctrl",
  alt: "alt", option: "alt", altgr: "altgr", shift: "shift", super: "super", meta: "super",
};
const KEY = /^([a-z0-9]|f([1-9]|1[0-9]|2[0-4])|space|tab|enter|return|backspace|delete|insert|home|end|pageup|pagedown|up|down|left|right|escape|esc|plus|[-=[\];',./`\\])$/i;

// Chords the system keeps for itself or that a person needs to get out of a
// misbehaving app: Force Quit, screenshots, lock and log out on macOS; Task
// Manager, the secure attention sequence and Snip on Windows. An app may not
// hold them even with the shortcuts grant. Modifiers sorted, key lowercase.
const RESERVED_CHORDS = new Set([
  "alt+cmd+escape", "alt+cmd+esc",
  "cmd+shift+3", "cmd+shift+4", "cmd+shift+5", "cmd+shift+6",
  "cmd+ctrl+q", "cmd+shift+q", "alt+cmd+shift+q",
  "ctrl+shift+escape", "ctrl+shift+esc", "alt+ctrl+delete",
  "shift+super+s",
]);

/** Why an accelerator is unusable as a global shortcut, or null. */
function acceleratorProblem(accel) {
  const parts = accel.split("+");
  // "Shift+Plus" spells "+" as Plus; a trailing "+" is the key itself.
  if (accel.endsWith("++")) parts.splice(-2, 2, "+");
  const key = parts.pop();
  if (!key || MODIFIERS[key.toLowerCase()] || !(KEY.test(key) || key === "+")) return `"${accel}" needs one key after its modifiers`;
  const mods = parts.map((p) => MODIFIERS[p.toLowerCase()]);
  if (mods.some((m) => !m)) return `"${accel}" has an unknown modifier`;
  const set = new Set(mods);
  if (set.size !== mods.length || (set.has("cmdorctrl") && (set.has("cmd") || set.has("ctrl")))) return `"${accel}" repeats a modifier`;
  if (set.size < 2) return `"${accel}" needs at least two modifiers`;
  // CmdOrCtrl is Cmd on macOS and Ctrl elsewhere: reserved if either is.
  const chords = set.has("cmdorctrl") ? ["cmd", "ctrl"].map((m) => [...set].map((x) => (x === "cmdorctrl" ? m : x))) : [[...set]];
  if (chords.some((mods) => RESERVED_CHORDS.has([...mods.sort(), key.toLowerCase()].join("+")))) return `"${accel}" is reserved by the system`;
  return null;
}

// ── argument schemas ──
//
// One entry per method: the positional args. A type name ends in "?" when the
// arg may be left out; an object spec checks its fields and refuses unknown
// ones ("?" on the key makes the whole object optional).
const TYPES = {
  string: (v) => typeof v === "string",
  text: (v) => typeof v === "string" && v.trim().length > 0,
  number: (v) => typeof v === "number" && Number.isFinite(v),
  size: (v) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 20_000,
  count: (v) => Number.isInteger(v) && v >= 0,
  boolean: (v) => typeof v === "boolean",
  "string[]": (v) => Array.isArray(v) && v.every((s) => typeof s === "string"),
  record: (v) => !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((s) => typeof s === "string"),
  // A path inside codecast's web app: one leading slash, no host, no whitespace or backslash.
  route: (v) => typeof v === "string" && v.length <= 2048 && /^\/(?![/\\])[^\s\\]*$/.test(v),
  path: (v) => typeof v === "string" && (v === "~" || v.startsWith("~/") || v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v) || v.startsWith("\\\\")),
  permissions: (v) => Array.isArray(v) && v.length > 0 && v.every((p) => TIERS.permissions.includes(p)),
  accelerator: (v) => typeof v === "string" && !acceleratorProblem(v),
};
const OPTIONAL = "?";

const ARGS = {
  "app.info": [],
  "app.badge": ["count"],
  "app.openInCodecast": ["route"],
  "app.notify": [{ title: "text", body: "string?", tag: "string?", silent: "boolean?" }],
  "permissions.request": ["permissions"],
  "window.setSize": ["size", "size"],
  "window.setTitle": ["string"],
  "window.focus": [],
  "window.minimize": [],
  "window.close": [],
  "window.setAlwaysOnTop": ["boolean"],
  "window.setVisibleOnAllWorkspaces": ["boolean"],
  "window.setIgnoreMouseEvents": ["boolean"],
  "tray.set": [{ [OPTIONAL]: true, title: "string?", tooltip: "string?", badge: "string|count?" }],
  "tray.remove": [],
  "shortcuts.register": ["accelerator"],
  "shortcuts.unregister": ["accelerator"],
  "agent.ask": ["text"],
  "login.set": ["boolean"],
  "fs.readText": ["path"],
  "fs.writeText": ["path", "string"],
  "fs.list": ["path"],
  "fs.stat": ["path"],
  "fs.remove": ["path"],
  "fs.watch": ["path"],
  "fs.unwatch": ["text"],
  "process.run": ["text", "string[]?", { [OPTIONAL]: true, cwd: "path?", env: "record?", timeoutMs: "count?" }],
  "shell.open": ["text"],
};

const absent = (v) => v === undefined || v === null;

function checkValue(spec, value, where) {
  if (typeof spec === "object") {
    if (absent(value)) return spec[OPTIONAL] ? null : `${where} is required`;
    if (typeof value !== "object" || Array.isArray(value)) return `${where} must be an object`;
    for (const k of Object.keys(value)) if (!Object.prototype.hasOwnProperty.call(spec, k) || k === OPTIONAL) return `${where} has an unknown field "${k}"`;
    for (const [k, s] of Object.entries(spec)) {
      if (k === OPTIONAL) continue;
      const problem = checkValue(s, value[k], `${where}.${k}`);
      if (problem) return problem;
    }
    return null;
  }
  const optional = spec.endsWith("?");
  if (absent(value)) return optional ? null : `${where} is required`;
  const names = spec.replace(/\?$/, "").split("|");
  if (names.some((n) => TYPES[n](value))) return null;
  if (names.includes("accelerator") && typeof value === "string") return acceleratorProblem(value);
  return `${where} must be ${names.join(" or ")}`;
}

/** Why `args` do not fit `key`'s schema, or null. */
function argsProblem(key, args) {
  const spec = ARGS[key];
  if (!Array.isArray(args)) return "args must be an array";
  let last = args.length;
  while (last > 0 && absent(args[last - 1])) last--;
  if (last > spec.length) return `${key} takes ${spec.length} argument${spec.length === 1 ? "" : "s"}`;
  for (let i = 0; i < spec.length; i++) {
    const problem = checkValue(spec[i], args[i], `argument ${i + 1}`);
    if (problem) return problem;
  }
  return null;
}

/** The grants that hold at `version`: none once the page has moved past the version they were given for. */
function grantsFor(record, version) {
  if (!record || !Array.isArray(record.grants)) return [];
  return Number(record.grantedVersion) >= Number(version) ? record.grants.slice() : [];
}

/** Whether full access may be offered for this page at all, or the refusal that applies. */
function fullAccessRefusal(facts) {
  if (facts.relation !== "owner" && facts.relation !== "team") {
    return new AppError("not-your-page", "full access is only for your own pages and your teams' pages");
  }
  if (!facts.policy || facts.policy.fullAccess !== true) {
    return new AppError("not-allowed-by-team", "this team does not allow full access for installed apps");
  }
  return null;
}

function createEngine({ registry, page, adapter, ops = createFullAccess(), platform = process.platform }) {
  const missing = [...HOST_METHODS, "consent", "emit"].filter((k) => typeof adapter[k] !== "function");
  if (missing.length) throw new Error(`installed-app adapter is missing: ${missing.join(", ")}`);

  /**
   * Decide a call. Resolves to {key, tier, record, facts, version} when it may
   * run, and rejects with an AppError carrying the refusal otherwise.
   */
  async function decide(slug, frame, msg) {
    const key = msg && typeof msg.module === "string" && typeof msg.method === "string" ? `${msg.module}.${msg.method}` : "";
    if (!Object.prototype.hasOwnProperty.call(TIERS.methods, key)) {
      throw new AppError("unknown-method", `cast.app has no ${key || "such method"}`);
    }
    const tier = TIERS.methods[key];
    const record = registry.get(slug);
    if (!record) throw new AppError("not-installed", `${slug} is not installed on this computer`);
    const facts = await page(slug);
    if (!facts) throw new AppError("failed", `no details for ${slug} yet`);
    if (facts.policy && facts.policy.install === false) {
      throw new AppError("not-allowed-by-team", "this team does not allow installed apps");
    }
    const args = msg.args === undefined ? [] : msg.args;
    const problem = argsProblem(key, args);
    if (problem) throw new AppError("bad-args", `${key}: ${problem}`);

    const frameVersion = Number(frame && frame.version) || 0;
    const factsVersion = Number(facts.version) || 0;
    const version = Math.max(frameVersion, factsVersion);
    const decided = { key, tier, args, record, facts, version };
    if (tier === DEFAULT && key !== "permissions.request") return decided;
    if (frameVersion < version) {
      throw new AppError("mixed-version", `this window shows version ${frameVersion}; version ${version} is live and loads first`);
    }
    // A frame ahead of the server's facts is refused until the facts catch up
    // (the shell's feed within a second, or the fallback fetch). The frame
    // version is the page response's X-Cast-Version, which a page's own
    // service worker can forge; trusting it would record consent for a
    // version the server never published, and grants given "for v9999" would
    // then hold across every real republish below it.
    if (frameVersion > factsVersion) {
      throw new AppError("mixed-version", `this window shows version ${frameVersion}, which Codecast has not confirmed yet`);
    }
    if (key === "permissions.request") return decided;
    if (tier === FULL) {
      const refusal = fullAccessRefusal(facts);
      if (refusal) throw refusal;
    }
    if (!grantsFor(record, version).includes(tier)) {
      const stale = Array.isArray(record.grants) && record.grants.includes(tier);
      throw new AppError("needs-consent", stale ? `version ${version} needs your approval again` : `${key} needs the "${tier}" permission`);
    }
    return decided;
  }

  /**
   * Record the grants the person approved for `version`. Full access is
   * dropped where it may not be offered (or when `facts`, the page facts, are
   * missing). Used by permissions.request and by
   * the host's own consent screens (install sheet, Settings, re-ask).
   */
  function grant(slug, grants, version, facts) {
    const record = registry.get(slug);
    if (!record) throw new AppError("not-installed", `${slug} is not installed on this computer`);
    const allowed = [...new Set(grants)].filter((p) => TIERS.permissions.includes(p) && (p !== FULL || !fullAccessRefusal(facts || {})));
    registry.update(slug, { grants: allowed, grantedVersion: version });
    adapter.emit(slug, "grants", { grants: allowed, version });
    return allowed;
  }

  async function requestPermissions(ctx, requested) {
    const { slug, record, page: facts, version } = ctx;
    if (requested.includes(FULL)) {
      const refusal = fullAccessRefusal(facts);
      if (refusal) throw refusal;
    }
    const granted = grantsFor(record, version);
    if (requested.every((p) => granted.includes(p))) return granted;
    const answer = await adapter.consent({
      slug,
      name: record.name,
      version,
      requested,
      granted,
      fullAccessOffered: !fullAccessRefusal(facts),
    });
    if (!Array.isArray(answer)) throw new AppError("denied", "the person declined");
    return grant(slug, answer, version, facts);
  }

  function info(ctx) {
    return {
      slug: ctx.slug,
      name: ctx.record.name,
      version: ctx.version,
      surface: (ctx.frame && ctx.frame.surface) || "window",
      platform,
      grants: grantsFor(ctx.record, ctx.version),
      requested: Array.isArray(ctx.page.requested) ? ctx.page.requested : [],
    };
  }

  function run(ctx, key, args) {
    if (key === "app.info") return info(ctx);
    if (key === "permissions.request") return requestPermissions(ctx, args[0]);
    if (key === "fs.watch") return ops.watch(ctx.slug, args[0], (data) => adapter.emit(ctx.slug, "fs-change", data));
    if (key === "fs.unwatch") return ops.unwatch(ctx.slug, args[0]);
    if (isOps(key)) return ops[key](...args);
    return adapter[key](ctx, ...args);
  }

  /** Decide and run one call; always resolves to a reply envelope. */
  async function handle(slug, frame, msg) {
    const id = msg && msg.id !== undefined ? msg.id : null;
    try {
      const { key, args, record, facts, version } = await decide(slug, frame, msg);
      const ctx = { slug, frame: frame || {}, record, page: facts, version };
      return ok(id, await run(ctx, key, args));
    } catch (err) {
      return replyFor(id, err);
    }
  }

  /** Drop what an app holds in the engine (its watches) when its last surface closes. */
  function release(slug) {
    ops.unwatchAll(slug);
  }

  return { decide, handle, grant, release };
}

module.exports = {
  createEngine,
  grantsFor,
  acceleratorProblem,
  argsProblem,
  ARGS,
  HOST_METHODS,
  MAIN_METHODS,
  TIERS,
};
