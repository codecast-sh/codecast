const { test, expect } = require("bun:test");
const { createNotarizeHook, notarizeCredentials, NOTARIZE_ENV } = require("./notarize");

const ctx = (platform = "darwin") => ({
  electronPlatformName: platform,
  appOutDir: "/out",
  packager: { appInfo: { productFilename: "Codecast" } },
});

test("credentials: keychain profile wins, then Apple ID pair, else none", () => {
  expect(notarizeCredentials({})).toBeNull();
  expect(notarizeCredentials({ APPLE_ID: "a" })).toBeNull();
  expect(notarizeCredentials({ NOTARIZE_KEYCHAIN_PROFILE: "codecast", APPLE_ID: "a", APPLE_PASSWORD: "p" }))
    .toEqual({ kind: "keychainProfile", keychainProfile: "codecast" });
  expect(notarizeCredentials({ APPLE_ID: "a", APPLE_PASSWORD: "p", APPLE_TEAM_ID: "T" }))
    .toEqual({ kind: "appleId", appleId: "a", appleIdPassword: "p", teamId: "T" });
  expect(Object.values(NOTARIZE_ENV).sort()).toEqual(["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID", "NOTARIZE_KEYCHAIN_PROFILE"]);
});

test("hook skips loudly without credentials and off macOS", async () => {
  const logs = [];
  const calls = [];
  const hook = createNotarizeHook({ env: {}, log: (m) => logs.push(m), notarize: async (o) => calls.push(o) });
  await hook(ctx());
  expect(calls).toEqual([]);
  expect(logs[0]).toMatch(/Skipping notarization/);
  await createNotarizeHook({ env: { NOTARIZE_KEYCHAIN_PROFILE: "x" }, log: () => {}, notarize: async (o) => calls.push(o) })(ctx("win32"));
  expect(calls).toEqual([]);
});

test("hook notarizes the built app with the chosen credentials", async () => {
  const calls = [];
  const notarize = async (o) => calls.push(o);
  await createNotarizeHook({ env: { NOTARIZE_KEYCHAIN_PROFILE: "codecast" }, log: () => {}, notarize })(ctx());
  await createNotarizeHook({ env: { APPLE_ID: "a", APPLE_PASSWORD: "p", APPLE_TEAM_ID: "WRG9THCK9Q" }, log: () => {}, notarize })(ctx());
  expect(calls).toEqual([
    { appPath: "/out/Codecast.app", keychainProfile: "codecast" },
    { appPath: "/out/Codecast.app", appleId: "a", appleIdPassword: "p", teamId: "WRG9THCK9Q" },
  ]);
});
