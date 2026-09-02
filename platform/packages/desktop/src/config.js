// Desktop shell configuration: validation and defaults. Pure — no Electron.
//
// Everything product specific that main.js used to hardcode lives here:
// names, ids, URLs, paths, menus, icons. The behavior (single instance lock,
// deep link buffering, notification routing, the updater) is shared.

const fs = require("fs");
const path = require("path");

class DesktopConfigError extends Error {}

function fail(msg) {
  throw new DesktopConfigError(`@platform/desktop config: ${msg}`);
}

function isHttpsUrl(u) {
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
}

function hostOf(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
}

// Bridge and event names derive from `slug`: codecast → __CODECAST_ELECTRON__,
// codecast-navigate, __CODECAST_NEW_SESSION. A consumer may override each.
function upperSlug(slug) {
  return slug.replace(/[^a-z0-9]/gi, "_").toUpperCase();
}

// Minimal shortcut settings when the consumer does not inject its own. The
// real thing (defaults plus the legacy key migration) belongs to @platform/keys;
// codecast passes that module in `shortcuts.settings`.
function plainShortcutSettings(defaults) {
  return {
    DEFAULT_SHORTCUTS: defaults,
    mergeShortcuts: (persisted) => ({ ...defaults, ...persisted }),
    diffOverrides: (shortcuts) => {
      const overrides = {};
      for (const [key, acc] of Object.entries(shortcuts)) {
        if (!(key in defaults)) continue;
        if (acc !== defaults[key]) overrides[key] = acc;
      }
      return overrides;
    },
  };
}

const BASELINE_PERMISSIONS = [
  "media", "audioCapture", "videoCapture", // huddles: mic + camera
  "display-capture",                       // screen share
  "notifications",
  "clipboard-read", "clipboard-sanitized-write",
  "fullscreen",
  "speaker-selection",                     // audio output picker
];

function resolveDesktopConfig(input) {
  if (!input || typeof input !== "object") fail("expected an object");
  const c = input;

  for (const key of ["productName", "appId", "protocol"]) {
    if (typeof c[key] !== "string" || !c[key].trim()) fail(`${key} is required`);
  }
  if (!/^[a-z][a-z0-9+.-]*$/i.test(c.protocol)) fail(`protocol "${c.protocol}" is not a valid URL scheme`);
  if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/i.test(c.appId)) fail(`appId "${c.appId}" must be reverse DNS (sh.codecast.desktop)`);

  const urls = c.urls || {};
  if (!isHttpsUrl(urls.prod)) fail("urls.prod must be an https URL");
  if (urls.local !== undefined && !isHttpsUrl(urls.local)) fail("urls.local must be an https URL when set");

  const slug = (c.slug || c.protocol).toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) fail(`slug "${slug}" must be lowercase letters, digits, dashes`);
  const envPrefix = c.envPrefix || upperSlug(slug);

  const update = c.update || {};
  if (update.enabled !== false) {
    if (!isHttpsUrl(update.baseUrl)) fail("update.baseUrl must be an https URL (or set update.enabled = false)");
    if (typeof update.teamId !== "string" || !/^[A-Z0-9]{10}$/.test(update.teamId)) {
      fail("update.teamId must be the 10 character Apple Team ID that signs the bundle");
    }
    if (update.minVersion !== undefined && typeof update.minVersion !== "function") {
      fail("update.minVersion must be a function returning a version string or null");
    }
  }

  const assets = c.assets || {};
  for (const key of ["icon", "tray"]) {
    if (assets[key] !== undefined && typeof assets[key] !== "string") fail(`assets.${key} must be a path`);
  }

  const shortcuts = c.shortcuts || {};
  const shortcutDefaults = shortcuts.defaults || {};
  for (const [k, v] of Object.entries(shortcutDefaults)) {
    if (typeof v !== "string") fail(`shortcuts.defaults.${k} must be an accelerator string`);
  }
  const settings = shortcuts.settings || plainShortcutSettings(shortcutDefaults);
  for (const fn of ["mergeShortcuts", "diffOverrides"]) {
    if (typeof settings[fn] !== "function") fail(`shortcuts.settings.${fn} must be a function`);
  }

  const menu = c.menu || {};
  const navItems = Array.isArray(menu.navItems) ? menu.navItems : [];
  for (const item of navItems) {
    if (!item || typeof item.label !== "string" || typeof item.path !== "string" || !item.path.startsWith("/")) {
      fail("menu.navItems entries need { label, path } with an app-relative path");
    }
  }
  const helpLinks = Array.isArray(menu.helpLinks) ? menu.helpLinks : [];
  for (const item of helpLinks) {
    if (!item || typeof item.label !== "string" || !isHttpsUrl(item.url)) {
      fail("menu.helpLinks entries need { label, url } with an https URL");
    }
  }

  const palette = c.palette || null;
  if (palette && (typeof palette.path !== "string" || !palette.path.startsWith("/"))) {
    fail("palette.path must be an app-relative path");
  }

  const nr = c.notificationRouter || null;
  if (nr && nr.areas !== undefined && !Array.isArray(nr.areas)) fail("notificationRouter.areas must be an array of [area, [prefixes]]");

  const window = c.window || {};
  const localHost = urls.local ? hostOf(urls.local) : null;
  const trustedHosts = new Set([hostOf(urls.prod), ...(c.trustedHosts || [])].filter(Boolean));
  if (localHost) trustedHosts.add(localHost);

  return Object.freeze({
    productName: c.productName,
    appId: c.appId,
    protocol: c.protocol,
    slug,
    envPrefix,
    env: {
      url: `${envPrefix}_URL`,
      userData: `${envPrefix}_USER_DATA`,
      claimProtocol: `${envPrefix}_CLAIM_PROTOCOL`,
    },
    urls: { prod: urls.prod, local: urls.local || null },
    localDevHost: localHost,
    trustedHosts: [...trustedHosts],
    bridgeGlobal: c.bridgeGlobal || `__${upperSlug(slug)}_ELECTRON__`,
    events: {
      navigate: c.events?.navigate || `${slug}-navigate`,
      newSession: c.events?.newSession || `__${upperSlug(slug)}_NEW_SESSION`,
      htmlClass: c.events?.htmlClass || "electron-desktop",
    },
    assets: {
      icon: assets.icon || null,
      tray: assets.tray || null,
    },
    window: {
      width: window.width || 1200,
      height: window.height || 800,
      minWidth: window.minWidth || 800,
      minHeight: window.minHeight || 600,
      backgroundColor: window.backgroundColor || "#002b36",
      trafficLightPosition: window.trafficLightPosition || { x: 16, y: 12 },
    },
    menu: {
      navItems,
      helpLinks,
      settingsPath: typeof menu.settingsPath === "string" ? menu.settingsPath : null,
      // "New Session" entries (tray, dock, File menu, palette hand-off) call the
      // web's `events.newSession` global. null removes them for apps without one.
      newSessionLabel: menu.newSessionLabel === null ? null : (menu.newSessionLabel || "New Session"),
      dockItems: Array.isArray(menu.dockItems) ? menu.dockItems : navItems.slice(0, 2),
    },
    palette: palette
      ? {
          path: palette.path,
          width: palette.width || 1000,
          height: palette.height || 680,
        }
      : null,
    shortcuts: {
      defaults: shortcutDefaults,
      settings,
      actions: shortcuts.actions || {},
    },
    update: {
      enabled: update.enabled !== false,
      baseUrl: update.baseUrl ? String(update.baseUrl).replace(/\/+$/, "") : null,
      channel: update.channel || "latest",
      teamId: update.teamId || null,
      minVersion: update.minVersion || null,
      initialDelayMs: update.initialDelayMs ?? 8000,
      intervalMs: update.intervalMs ?? 60 * 60 * 1000,
    },
    notificationRouter: nr,
    permissions: [...BASELINE_PERMISSIONS, ...(c.extraPermissions || [])],
    about: {
      copyright: c.about?.copyright || c.productName,
      website: c.about?.website || urls.prod,
    },
  });
}

// True when the file exists; used by callers that want a loud failure for a
// missing icon instead of an Electron window with no icon.
function assetExists(p) {
  return !!p && fs.existsSync(path.resolve(p));
}

module.exports = {
  resolveDesktopConfig,
  DesktopConfigError,
  BASELINE_PERMISSIONS,
  plainShortcutSettings,
  assetExists,
};
