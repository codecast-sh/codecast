// What a from-source run of Codecast may point elsewhere for installed apps
// (the e2e harness in installedApps/e2e and host.electron.test.js): the page
// origin, the folder bundles go to, and the bundle id shims name as their
// host. A packaged build takes none of them from the environment, so nothing
// a customer's environment holds can move its pages, its bundles, or the app
// its shims launch.
const { originOf } = require("../shellAuthority");

const PAGE_ORIGIN = "https://a.codecast.sh";

/** {pageOrigin, mac: {root?, hostBundleId?}} for a run that is `packaged` or not. */
function appsOverrides({ packaged, env = process.env }) {
  if (packaged) return { pageOrigin: PAGE_ORIGIN, mac: {} };
  const mac = {};
  if (env.CODECAST_APPS_ROOT) mac.root = env.CODECAST_APPS_ROOT;
  if (env.CODECAST_APPS_HOST_BUNDLE_ID) mac.hostBundleId = env.CODECAST_APPS_HOST_BUNDLE_ID;
  return { pageOrigin: originOf(env.CODECAST_APPS_PAGE_ORIGIN) || PAGE_ORIGIN, mac };
}

module.exports = { appsOverrides, PAGE_ORIGIN };
