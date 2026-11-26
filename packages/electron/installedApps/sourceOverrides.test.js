const test = require("node:test");
const assert = require("node:assert/strict");
const { appsOverrides } = require("./sourceOverrides");

const ENV = {
  CODECAST_APPS_PAGE_ORIGIN: "http://127.0.0.1:4318/ignored/path",
  CODECAST_APPS_ROOT: "/tmp/cc-apps-e2e/Apps",
  CODECAST_APPS_HOST_BUNDLE_ID: "com.github.Electron",
};

test("a packaged build ignores every override in its environment", () => {
  assert.deepEqual(appsOverrides({ packaged: true, env: ENV }), { pageOrigin: "https://a.codecast.sh", mac: {} });
});

test("a from-source run takes the page origin, the bundle root and the host bundle id", () => {
  assert.deepEqual(appsOverrides({ packaged: false, env: ENV }), {
    pageOrigin: "http://127.0.0.1:4318",
    mac: { root: "/tmp/cc-apps-e2e/Apps", hostBundleId: "com.github.Electron" },
  });
});

test("a from-source run without overrides gets the real defaults", () => {
  assert.deepEqual(appsOverrides({ packaged: false, env: {} }), { pageOrigin: "https://a.codecast.sh", mac: {} });
  assert.deepEqual(appsOverrides({ packaged: false, env: { CODECAST_APPS_PAGE_ORIGIN: "not a url" } }).pageOrigin, "https://a.codecast.sh");
});
