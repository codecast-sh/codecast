import { describe, expect, test } from "bun:test";
import { APP_PERMISSIONS, APP_PERMISSION_LABEL, APP_PERMISSION_TIER, appIconSize, newPermissions, parsePageApp, resolvePageApp } from "./pageApp";
import { parsePageDataDeclaration } from "./pageData";

const ok = (raw: unknown) => {
  const r = parsePageApp(raw);
  if (!r.ok) throw new Error(r.error);
  return r.app;
};
const err = (raw: unknown) => {
  const r = parsePageApp(raw);
  if (r.ok) throw new Error("expected a refusal");
  return r.error;
};

describe("parsePageApp", () => {
  test("the doc's example parses to itself", () => {
    const app = {
      name: "Vitals",
      icon: "icon.png",
      window: { width: 420, height: 640, minWidth: 320, minHeight: 400, resizable: true, titleBar: "default" },
      tray: { icon: "tray.png", width: 360, height: 480, tooltip: "Vitals" },
      permissions: ["notifications", "menu-bar", "shortcuts"],
    };
    expect(ok(app)).toEqual(app as never);
  });

  test("an empty block is valid and keeps nothing", () => {
    expect(ok({})).toEqual({});
    expect(ok({ window: {}, tray: {} })).toEqual({});
  });

  test("sizes are clamped, rounded, and a minimum never exceeds its size", () => {
    expect(ok({ window: { width: 50, height: 99999.4, minWidth: 9000 } }).window).toEqual({ width: 200, height: 4096, minWidth: 200 });
    expect(ok({ tray: { width: 5, height: 5000 } }).tray).toEqual({ width: 120, height: 1200 });
  });

  test("unknown permissions refuse with the allowed list", () => {
    const e = err({ permissions: ["notifications", "camera", "root"] });
    expect(e).toContain(`"camera", "root"`);
    for (const p of APP_PERMISSIONS) expect(e).toContain(p);
  });

  test("permissions come back once each in catalog order", () => {
    expect(ok({ permissions: ["full-access", "notifications", "notifications"] }).permissions).toEqual(["notifications", "full-access"]);
  });

  test("unknown fields refuse, so a typo is caught at publish", () => {
    expect(err({ permision: [] })).toContain(`unknown field "permision"`);
    expect(err({ window: { widht: 300 } })).toContain(`"app.window": unknown field "widht"`);
  });

  test("bad types refuse with the field's name", () => {
    expect(err([])).toBe(`"app" must be an object`);
    expect(err({ window: { width: "wide" } })).toContain(`"app.window.width"`);
    expect(err({ window: { resizable: "yes" } })).toContain(`"app.window.resizable"`);
    expect(err({ window: { titleBar: "none" } })).toContain("default, hidden");
    expect(err({ permissions: "notifications" })).toContain("must be a list");
    expect(err({ name: 3 })).toContain(`"app.name"`);
  });

  test("icons are bundle-relative PNG paths", () => {
    expect(ok({ icon: "./img/icon.png" }).icon).toBe("img/icon.png");
    for (const bad of ["https://x.com/i.png", "/icon.png", "../icon.png", "a/../../b.png", "data:image/png;base64,AA", "icon.jpg"]) {
      expect(err({ icon: bad })).toContain(`"app.icon"`);
    }
    expect(err({ tray: { icon: "tray.svg" } })).toContain(`"app.tray.icon"`);
  });

  test("names collapse whitespace and are capped", () => {
    expect(ok({ name: "  My\n  App " }).name).toBe("My App");
    expect(ok({ name: "x".repeat(200) }).name).toHaveLength(60);
    expect(ok({ name: "   " }).name).toBeUndefined();
  });
});

describe("tiers", () => {
  test("every permission has a tier and a label; only full-access is full", () => {
    for (const p of APP_PERMISSIONS) {
      expect(APP_PERMISSION_TIER[p]).toBe(p === "full-access" ? "full" : "app");
      expect(APP_PERMISSION_LABEL[p]).toBeTruthy();
    }
  });
});

describe("resolvePageApp", () => {
  test("no block installs with the defaults, named after the page", () => {
    expect(resolvePageApp(undefined, "  Team vitals ")).toEqual({
      name: "Team vitals",
      icon: null,
      window: { width: 1024, height: 768, minWidth: 320, minHeight: 240, resizable: true, titleBar: "default" },
      tray: { icon: null, width: 360, height: 480, tooltip: "Team vitals" },
      permissions: [],
    });
  });

  test("the page's fields win, and a small window pulls the default minimums down", () => {
    const r = resolvePageApp({ name: "V", window: { width: 250, height: 200 }, permissions: ["overlay"] }, "ignored");
    expect(r.name).toBe("V");
    expect(r.window).toMatchObject({ width: 250, height: 200, minWidth: 250, minHeight: 200 });
    expect(r.tray.tooltip).toBe("V");
    expect(r.permissions).toEqual(["overlay"]);
  });
});

test("newPermissions names what a version adds", () => {
  expect(newPermissions(["notifications"], ["notifications", "agent"])).toEqual(["agent"]);
  expect(newPermissions(["notifications", "agent"], ["agent"])).toEqual([]);
});

test("appIconSize rounds up to a rendered size", () => {
  expect(appIconSize(null)).toBe(512);
  expect(appIconSize("abc")).toBe(512);
  expect(appIconSize("100")).toBe(128);
  expect(appIconSize("1024")).toBe(1024);
  expect(appIconSize("5000")).toBe(1024);
});

describe("parsePageDataDeclaration with an app block", () => {
  test("an app-only declaration is valid and carries the parsed app", () => {
    const r = parsePageDataDeclaration({ app: { name: "V", permissions: ["login"] } });
    expect(r).toEqual({ ok: true, queries: [], app: { name: "V", permissions: ["login"] } });
  });

  test("a bad app block refuses the whole declaration", () => {
    const r = parsePageDataDeclaration({ queries: {}, app: { permissions: ["camera"] } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(`unknown permission "camera"`);
  });

  test("a declaration with neither queries, state nor app still refuses", () => {
    expect(parsePageDataDeclaration({}).ok).toBe(false);
  });
});
