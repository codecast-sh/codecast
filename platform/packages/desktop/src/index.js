// @platform/desktop — codecast's Electron shell, parameterized.
//
// Main process: createDesktopApp(config). Renderer: the preload at
// `@platform/desktop/preload` exposes createBridge's object on the configured
// window global. Build: templates/electron-builder.js + createNotarizeHook.

const { createDesktopApp } = require("./main");
const { resolveDesktopConfig, DesktopConfigError, BASELINE_PERMISSIONS, plainShortcutSettings } = require("./config");
const { createBridge, bufferedChannel, BRIDGE_METHODS } = require("./bridge");
const notificationRouter = require("./notificationRouter");
const updaterNet = require("./updaterNet");
const updaterLogic = require("./updaterLogic");
const { createNotarizeHook, notarizeCredentials, NOTARIZE_ENV } = require("./notarize");
const webCache = require("./webCache");
const path = require("path");

module.exports = {
  createDesktopApp,
  resolveDesktopConfig,
  DesktopConfigError,
  BASELINE_PERMISSIONS,
  plainShortcutSettings,
  // Renderer bridge
  createBridge,
  bufferedChannel,
  BRIDGE_METHODS,
  preloadPath: path.join(__dirname, "preload.js"),
  // Notification routing policy
  notificationRouter,
  createNotificationRouter: notificationRouter.createNotificationRouter,
  // Updater: network layer + pure decisions
  updaterNet,
  updaterLogic,
  // The offline copy of the site (see webCache.js); the Vite plugin that
  // publishes its manifest is `@platform/desktop/vite`.
  webCache,
  createWebCache: webCache.createWebCache,
  // Build
  createNotarizeHook,
  notarizeCredentials,
  NOTARIZE_ENV,
};
