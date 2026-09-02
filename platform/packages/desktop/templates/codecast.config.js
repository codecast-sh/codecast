// Codecast's desktop config: what packages/electron/main.js hardcoded, as data.
// The app's main.js becomes:
//
//   const path = require("path");
//   const { createDesktopApp } = require("@platform/desktop");
//   createDesktopApp(require("./desktop.config"));
//
// Paths are resolved relative to the file that requires this one; adjust
// `assets` when the app keeps its icons elsewhere.

const path = require("path");

module.exports = {
  productName: "Codecast",
  appId: "sh.codecast.desktop",
  protocol: "codecast", // codecast://… deep links; also the slug → __CODECAST_ELECTRON__, codecast-navigate
  urls: {
    prod: "https://codecast.sh",
    local: "https://local.codecast.sh", // mkcert host; trusted for its dev cert only
  },
  assets: {
    icon: path.join(__dirname, "assets", "icon.png"),
    tray: path.join(__dirname, "assets", "trayTemplate.png"), // @2x picked up by AppKit
  },
  menu: {
    navItems: [
      { label: "Dashboard", path: "/dashboard" },
      { label: "Inbox", path: "/inbox" },
      { label: "Tasks", path: "/tasks" },
      { label: "Plans", path: "/plans" },
      { label: "Docs", path: "/docs" },
    ],
    // Tray shows the first three; the dock shows the first two unless dockItems is set.
    dockItems: [
      { label: "Dashboard", path: "/dashboard" },
      { label: "Inbox", path: "/inbox" },
    ],
    helpLinks: [
      { label: "Documentation", url: "https://codecast.sh/documentation" },
      { label: "What's New", url: "https://codecast.sh/changelog" },
    ],
    settingsPath: "/settings",
    newSessionLabel: "New Session",
  },
  palette: { path: "/palette" },
  shortcuts: {
    defaults: {
      toggleWindow: "CommandOrControl+Alt+Space",
      togglePalette: "Control+Alt+Space",
      newSession: "Control+Shift+N",
      toggleEnv: "CommandOrControl+Alt+L",
    },
    // Codecast's merge carries a legacy key migration (toggleCompose → newSession).
    // That module is @platform/keys' to own; pass it here once it lands:
    // settings: require("@platform/keys/shortcutSettings"),
  },
  update: {
    baseUrl: "https://dl.codecast.sh/desktop",
    channel: "latest", // latest-mac.yml
    teamId: "WRG9THCK9Q",
    // The kill switch. Codecast keeps the fleet floor in Convex systemConfig
    // (min_desktop_version, set by `cast desktop-force-update <version>`).
    // Read it through any https endpoint the app can reach anonymously, for
    // example a web route that proxies the query:
    minVersion: async () => {
      const res = await fetch("https://codecast.sh/api/desktop/min-version", { cache: "no-store" });
      if (!res.ok) return null;
      const data = await res.json();
      return typeof data?.version === "string" ? data.version : null;
    },
  },
  about: {
    copyright: "Codecast",
    website: "https://codecast.sh",
  },
};
