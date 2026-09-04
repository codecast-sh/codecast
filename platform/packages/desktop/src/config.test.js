const { test, expect } = require("bun:test");
const { resolveDesktopConfig, DesktopConfigError } = require("./config");

const base = () => ({
  productName: "Codecast",
  appId: "sh.codecast.desktop",
  protocol: "codecast",
  urls: { prod: "https://codecast.sh", local: "https://local.codecast.sh" },
  update: { baseUrl: "https://dl.codecast.sh/desktop/", teamId: "WRG9THCK9Q" },
});

test("a full config resolves with derived names", () => {
  const cfg = resolveDesktopConfig(base());
  expect(cfg.slug).toBe("codecast");
  expect(cfg.bridgeGlobal).toBe("__CODECAST_ELECTRON__");
  expect(cfg.events.navigate).toBe("codecast-navigate");
  expect(cfg.events.newSession).toBe("__CODECAST_NEW_SESSION");
  expect(cfg.env).toEqual({
    url: "CODECAST_URL",
    userData: "CODECAST_USER_DATA",
    claimProtocol: "CODECAST_CLAIM_PROTOCOL",
  });
  expect(cfg.localDevHost).toBe("local.codecast.sh");
  expect(cfg.trustedHosts.sort()).toEqual(["codecast.sh", "local.codecast.sh"]);
  expect(cfg.update.baseUrl).toBe("https://dl.codecast.sh/desktop");
  expect(cfg.update.channel).toBe("latest");
  expect(cfg.update.intervalMs).toBe(3600000);
  expect(cfg.menu.newSessionLabel).toBe("New Session");
  expect(cfg.palette).toBeNull();
  expect(Object.isFrozen(cfg)).toBe(true);
});

test("required fields fail loudly", () => {
  for (const key of ["productName", "appId", "protocol"]) {
    const c = base();
    delete c[key];
    expect(() => resolveDesktopConfig(c)).toThrow(DesktopConfigError);
  }
  expect(() => resolveDesktopConfig({ ...base(), urls: { prod: "http://codecast.sh" } })).toThrow(/https/);
  expect(() => resolveDesktopConfig({ ...base(), appId: "codecast" })).toThrow(/reverse DNS/);
  expect(() => resolveDesktopConfig({ ...base(), protocol: "9bad" })).toThrow(/scheme/);
});

test("updater config is validated unless disabled", () => {
  expect(() => resolveDesktopConfig({ ...base(), update: { baseUrl: "https://x.y" } })).toThrow(/teamId/);
  expect(() => resolveDesktopConfig({ ...base(), update: { teamId: "WRG9THCK9Q" } })).toThrow(/baseUrl/);
  expect(() => resolveDesktopConfig({ ...base(), update: { baseUrl: "https://x.y", teamId: "WRG9THCK9Q", minVersion: "1.0" } })).toThrow(/minVersion/);
  const off = resolveDesktopConfig({ ...base(), update: { enabled: false } });
  expect(off.update.enabled).toBe(false);
  expect(off.update.baseUrl).toBeNull();
});

test("channel, kill switch source and overrides pass through", async () => {
  const minVersion = async () => "1.2.0";
  const cfg = resolveDesktopConfig({
    ...base(),
    slug: "cc",
    bridgeGlobal: "__X__",
    update: { ...base().update, channel: "beta", minVersion },
    menu: { navItems: [{ label: "Inbox", path: "/inbox" }], settingsPath: "/settings", newSessionLabel: null },
    palette: { path: "/palette" },
    extraPermissions: ["geolocation"],
  });
  expect(cfg.update.channel).toBe("beta");
  expect(await cfg.update.minVersion()).toBe("1.2.0");
  expect(cfg.bridgeGlobal).toBe("__X__");
  expect(cfg.events.navigate).toBe("cc-navigate");
  expect(cfg.env.url).toBe("CC_URL");
  expect(cfg.menu.newSessionLabel).toBeNull();
  expect(cfg.menu.dockItems).toEqual([{ label: "Inbox", path: "/inbox" }]);
  expect(cfg.palette).toEqual({ path: "/palette", width: 1000, height: 680 });
  expect(cfg.permissions).toContain("geolocation");
  expect(cfg.permissions).toContain("media");
});

test("menu entries are validated", () => {
  expect(() => resolveDesktopConfig({ ...base(), menu: { navItems: [{ label: "x", path: "inbox" }] } })).toThrow(/navItems/);
  expect(() => resolveDesktopConfig({ ...base(), menu: { helpLinks: [{ label: "x", url: "http://a.b" }] } })).toThrow(/helpLinks/);
  expect(() => resolveDesktopConfig({ ...base(), palette: { path: "palette" } })).toThrow(/palette/);
});

test("default shortcut settings merge and diff against defaults", () => {
  const cfg = resolveDesktopConfig({ ...base(), shortcuts: { defaults: { toggleWindow: "Alt+Space" } } });
  const s = cfg.shortcuts.settings;
  expect(s.mergeShortcuts(undefined)).toEqual({ toggleWindow: "Alt+Space" });
  expect(s.mergeShortcuts({ toggleWindow: "" })).toEqual({ toggleWindow: "" });
  expect(s.diffOverrides({ toggleWindow: "Alt+Space", stale: "x" })).toEqual({});
  expect(s.diffOverrides({ toggleWindow: "Ctrl+K" })).toEqual({ toggleWindow: "Ctrl+K" });
});

test("injected shortcut settings win", () => {
  const settings = { DEFAULT_SHORTCUTS: { a: "A" }, mergeShortcuts: () => ({ a: "B" }), diffOverrides: () => ({ a: "B" }) };
  const cfg = resolveDesktopConfig({ ...base(), shortcuts: { settings } });
  expect(cfg.shortcuts.settings).toBe(settings);
  expect(() => resolveDesktopConfig({ ...base(), shortcuts: { settings: { mergeShortcuts: 1 } } })).toThrow(/mergeShortcuts/);
});

test("app defined ipc and menu items resolve, and bad shapes fail", () => {
  const cfg = resolveDesktopConfig({
    ...base(),
    ipc: { handlers: { permissions: () => 1 }, events: ["permissions-changed"] },
    menu: { appItems: [{ label: "Mac Setup…", action: () => {} }, { type: "separator" }] },
  });
  expect(Object.keys(cfg.ipc.handlers)).toEqual(["permissions"]);
  expect(cfg.ipc.events).toEqual(["permissions-changed"]);
  expect(cfg.menu.appItems).toHaveLength(2);
  expect(resolveDesktopConfig(base()).ipc).toEqual({ handlers: {}, events: [] });
  expect(() => resolveDesktopConfig({ ...base(), ipc: { handlers: { "bad name": () => {} } } })).toThrow(/word characters/);
  expect(() => resolveDesktopConfig({ ...base(), ipc: { handlers: { x: 1 } } })).toThrow(/function/);
  expect(() => resolveDesktopConfig({ ...base(), menu: { appItems: [{ label: "x" }] } })).toThrow(/appItems/);
});
