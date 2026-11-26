import { describe, expect, test } from "bun:test";
import { resolvePageApp, type AppPermission } from "@codecast/shared/contracts/pageApp";
import {
  consentGrants,
  consentLedger,
  consentToggles,
  flipGrant,
  fullAccessBlock,
  grantRows,
  heldGrants,
  installDeepLink,
  installedAppState,
  madeBy,
  parseInstallDeepLink,
  permissionEffect,
  permissionLabel,
  reviewRequest,
  type AppInfo,
  type ConsentRequest,
} from "../installedApps";

const info = (o: Partial<AppInfo> = {}, permissions: AppPermission[] = ["notifications", "menu-bar", "full-access"]): AppInfo => ({
  slug: "k3j2h4",
  title: "Vitals",
  version: 7,
  updated_at: 0,
  app: resolvePageApp({ name: "Vitals", permissions, window: { width: 420, height: 640 } }, "Vitals"),
  owner: { name: "Ada" },
  icons: { "512": "https://a.codecast.sh/k3j2h4?icon=512", "1024": "https://a.codecast.sh/k3j2h4?icon=1024" },
  relation: "owner",
  policy: { install: true, fullAccess: true },
  ...o,
});

const req = (kind: ConsentRequest["kind"], i: AppInfo, asked: AppPermission[], current: AppPermission[] = []): ConsentRequest => ({
  id: "c1", kind, info: i, asked, current, added: asked.filter((p) => !current.includes(p)),
});

describe("full access", () => {
  test("is offered only for the person's own or a teammate's page, under team policy (engine.js fullAccessRefusal)", () => {
    expect(fullAccessBlock(info())).toBeNull();
    expect(fullAccessBlock(info({ relation: "team" }))).toBeNull();
    expect(fullAccessBlock(info({ relation: "other" }))).toBe("Not your page");
    expect(fullAccessBlock(info({ relation: "anonymous" }))).toBe("Not your page");
    expect(fullAccessBlock(info({ relation: "team", policy: { install: true, fullAccess: false } }))).toBe("Off for your team");
  });
});

describe("the install sheet", () => {
  test("app permissions start on, full access starts off, and a blocked full access shows its reason", () => {
    const allowed = consentToggles(req("install", info(), info().app.permissions));
    expect(allowed).toEqual([
      { perm: "notifications", on: true, block: null },
      { perm: "menu-bar", on: true, block: null },
      { perm: "full-access", on: false, block: null },
    ]);
    const blocked = consentToggles(req("install", info({ relation: "team", policy: { install: true, fullAccess: false } }), info().app.permissions));
    expect(blocked.at(-1)).toEqual({ perm: "full-access", on: false, block: "Off for your team" });
  });

  test("grants are what the person left on, in catalog order, and a blocked full access never gets through", () => {
    const r = req("install", info({ relation: "other" }), info().app.permissions);
    expect(consentGrants(r, new Set<AppPermission>(["full-access", "notifications"]))).toEqual(["notifications"]);
    expect(consentGrants(req("install", info(), info().app.permissions), new Set<AppPermission>(["full-access", "menu-bar"]))).toEqual(["menu-bar", "full-access"]);
  });

  test("the confirm names the act, and full access adds its line below the switches", () => {
    const r = req("install", info(), info().app.permissions);
    const plain = consentLedger(r, new Set<AppPermission>(["notifications"]), "codecast.sh/a/k3j2h4", "darwin");
    expect(plain.confirm).toBe("Install Vitals");
    expect(plain.alert).toBeUndefined();
    expect(plain.subject).toBe("codecast.sh/a/k3j2h4");
    expect(plain.blocked).toBeUndefined();
    const full = consentLedger(r, new Set<AppPermission>(["full-access"]), "x", "darwin");
    expect(full.alert).toBeUndefined();
    expect(full.rows.find((row) => row.k === "Full access")?.tone).toBe("warn");
  });

  test("a team that turned installs off blocks the confirm", () => {
    const r = req("install", info({ policy: { install: false, fullAccess: false } }), ["notifications"]);
    expect(consentLedger(r, new Set(), "x", "darwin").blocked).toBe("Installs are off for your team");
    const l = consentLedger(r, new Set(), "x", "darwin");
    expect(l.rows).toEqual([{ k: "Asks for", v: "Notifications" }]);
    expect(l.keep).toBe("Close");
  });
});

describe("a request and a review", () => {
  test("a request keeps what was granted and adds what the person allows", () => {
    const r = req("request", info(), ["agent"], ["notifications"]);
    expect(consentToggles(r)).toEqual([{ perm: "agent", on: true, block: null }]);
    expect(consentGrants(r, new Set<AppPermission>(["agent"]))).toEqual(["notifications", "agent"]);
    expect(consentGrants(r, new Set())).toEqual(["notifications"]);
    expect(consentLedger(r, new Set(), "x", "darwin").confirm).toBe("Allow");
  });

  test("a review shows only what the version adds; with nothing new it is one tap", () => {
    const r = req("review", info({ version: 8 }), ["notifications", "overlay"], ["notifications"]);
    expect(consentToggles(r).map((t) => t.perm)).toEqual(["overlay"]);
    expect(consentLedger(r, new Set<AppPermission>(["overlay"]), "x", "darwin").confirm).toBe("Allow changes");
    const none = req("review", info({ version: 8 }), ["notifications"], ["notifications"]);
    expect(consentToggles(none)).toEqual([]);
    const l = consentLedger(none, new Set(), "x", "darwin");
    expect(l.confirm).toBe("Keep using Vitals");
    expect(l.rows.find((row) => row.k === "Asks for")?.v).toBe("Nothing new");
  });

  test("Windows calls the menu bar the system tray, in the switch and in the ledger", () => {
    expect(permissionLabel("menu-bar", "win32")).toBe("Tray");
    expect(permissionEffect("menu-bar", "win32")).toBe("An icon in the system tray");
    expect(permissionLabel("menu-bar", "darwin")).toBe("Menu bar");
    const r = req("review", info({ version: 8 }), ["menu-bar", "overlay"], ["menu-bar"]);
    expect(consentLedger(r, new Set(), "x", "win32").rows.find((row) => row.k === "Kept")?.v).toBe("Tray");
    expect(consentLedger(r, new Set(), "x", "darwin").rows.find((row) => row.k === "Kept")?.v).toBe("Menu bar");
  });

  test("a review drops a held full access the page can no longer have", () => {
    const r = req("review", info({ relation: "other" }), ["notifications", "full-access"], ["notifications", "full-access"]);
    expect(consentGrants(r, new Set())).toEqual(["notifications"]);
  });
});

describe("who made it", () => {
  test("you, a teammate by name, or the owner's name", () => {
    expect(madeBy(info())).toBe("You");
    expect(madeBy(info({ relation: "team" }))).toBe("Ada · teammate");
    expect(madeBy(info({ relation: "other", owner: { name: null } }))).toBe("Someone");
  });
});

describe("Settings > Installed apps", () => {
  test("state: a pending review first, then not running, else up to date", () => {
    expect(installedAppState({ needsReview: true, running: false })).toBe("review");
    expect(installedAppState({ needsReview: false, running: false })).toBe("stopped");
    expect(installedAppState({ needsReview: false })).toBe("current");
  });

  test("rows cover what is asked or held; full access waits for the facts unless it is held", () => {
    expect(grantRows({ requested: ["notifications", "full-access"], grants: ["login"], needsReview: false }, null)).toEqual([
      { perm: "notifications", on: false, block: null },
      { perm: "login", on: true, block: null },
      { perm: "full-access", on: false, block: "Checking" },
    ]);
    expect(grantRows({ requested: ["full-access"], grants: ["full-access"], needsReview: false }, null)[0].block).toBeNull();
    expect(grantRows({ requested: ["full-access"], grants: [], needsReview: false }, info({ relation: "other" }))[0].block).toBe("Not your page");
    expect(grantRows({ requested: ["full-access"], grants: [], needsReview: false }, "unavailable")[0].block).toBe("Page unavailable");
  });

  test("a new version waiting for review holds no full access: rows, flips and approval never carry it over", () => {
    const app = { slug: "k3j2h4", requested: ["notifications", "menu-bar", "full-access"] as AppPermission[], grants: ["notifications", "full-access"] as AppPermission[], needsReview: true };
    expect(heldGrants(app)).toEqual(["notifications"]);
    expect(heldGrants({ ...app, needsReview: false })).toEqual(["notifications", "full-access"]);
    expect(grantRows(app, info()).find((r) => r.perm === "full-access")).toEqual({ perm: "full-access", on: false, block: null });
    // Flipping an unrelated switch writes the held grants: setGrants approves the version, without full access.
    expect(flipGrant(heldGrants(app), "menu-bar", true)).toEqual(["notifications", "menu-bar"]);
    // Approve opens the review: full access is something the version asks for, off until the person turns it on there.
    const r = reviewRequest(app, info());
    expect(r).toMatchObject({ kind: "review", asked: ["notifications", "menu-bar", "full-access"], current: ["notifications"], added: ["menu-bar", "full-access"] });
    const toggles = consentToggles(r);
    expect(toggles.find((t) => t.perm === "full-access")!.on).toBe(false);
    const sent = consentGrants(r, new Set(toggles.filter((t) => t.on).map((t) => t.perm)));
    expect(sent).toEqual(["notifications", "menu-bar"]);
    expect(sent).not.toContain("full-access");
  });

  test("flipping a grant keeps catalog order", () => {
    expect(flipGrant(["full-access"], "notifications", true)).toEqual(["notifications", "full-access"]);
    expect(flipGrant(["notifications", "full-access"], "notifications", false)).toEqual(["full-access"]);
  });
});

describe("the install deep link", () => {
  test("round-trips the slug and the gate keys", () => {
    const url = installDeepLink("k3j2h4", { k: "a b", m: "tok" });
    expect(url).toBe("codecast://install/k3j2h4?k=a+b&m=tok");
    expect(parseInstallDeepLink(url)).toEqual({ slug: "k3j2h4", gate: { k: "a b", m: "tok" } });
    expect(parseInstallDeepLink(installDeepLink("k3j2h4"))).toEqual({ slug: "k3j2h4", gate: {} });
  });

  test("refuses anything that is not an install link for a plain slug", () => {
    expect(parseInstallDeepLink("codecast://open/install/k3j2h4")).toBeNull();
    expect(parseInstallDeepLink("https://install/k3j2h4")).toBeNull();
    expect(parseInstallDeepLink("codecast://install/a/b")).toBeNull();
    expect(parseInstallDeepLink("codecast://install/")).toBeNull();
    expect(parseInstallDeepLink("not a url")).toBeNull();
  });
});
