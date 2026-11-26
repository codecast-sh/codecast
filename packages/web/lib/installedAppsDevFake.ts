// A stand-in for window.__CODECAST_ELECTRON__.apps in a dev build, so the
// install sheet, the consent route and Settings > Installed apps can be driven
// in a plain browser. Loaded only by dev builds (src/main.tsx), and active
// only after `?appsFake=1` on any page (`?appsFake=0` turns it off). State
// lives in localStorage, so the consent window and Settings see one registry.
import type { AppPermission } from "@codecast/shared/contracts/pageApp";
import { resolvePageApp } from "@codecast/shared/contracts/pageApp";
import type { AppInfo, ConsentRequest, DesktopAppsBridge, InstalledApp } from "./installedApps";
import { consentGrants } from "./installedApps";

const ON = "codecast.appsFake";
const STATE = "codecast.appsFake.state";

type FakeState = { apps: InstalledApp[]; consents: Record<string, ConsentRequest>; answers: { id: string; approve: boolean; grants: string[] }[] };

/** A generated tile like the server's monogram: the initial on a color from the name. */
function monogram(name: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect x="50" y="50" width="412" height="412" rx="92" fill="hsl(${hue} 55% 46%)"/><text x="256" y="330" font-family="Helvetica, Arial" font-size="230" font-weight="700" fill="white" text-anchor="middle">${name[0]}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function info(slug: string, title: string, hue: number, o: Partial<AppInfo> & { permissions?: AppPermission[]; width?: number; height?: number }): AppInfo {
  const icon = monogram(title, hue);
  return {
    slug,
    title,
    version: o.version ?? 7,
    updated_at: Date.now() - 3_600_000,
    app: resolvePageApp({ name: title, permissions: o.permissions ?? [], window: { width: o.width ?? 420, height: o.height ?? 640 } }, title),
    owner: o.owner ?? { name: "Ada Lovelace" },
    icons: { "512": icon, "1024": icon },
    relation: o.relation ?? "owner",
    policy: o.policy ?? { install: true, fullAccess: true },
    gate: {},
  };
}

export const FAKE_INFOS: Record<string, AppInfo> = {
  vitals: info("k3j2h4", "Vitals", 152, { permissions: ["notifications", "menu-bar", "shortcuts"] }),
  deploys: info("d9x2pa", "Deploy watch", 28, { permissions: ["notifications", "menu-bar", "full-access"], relation: "team", version: 12 }),
  standup: info("s7q1vv", "Standup board", 212, { permissions: ["notifications", "overlay", "full-access"], relation: "team", policy: { install: true, fullAccess: false }, version: 4 }),
  outside: info("o2m8zz", "Pomodoro", 350, { permissions: ["notifications", "login", "full-access"], relation: "other", owner: { name: "Grace Hopper" }, version: 3 }),
  agentNotes: info("n4t3s0", "Agent notes", 265, { permissions: ["notifications", "agent"], version: 9 }),
  blockedTeam: info("b1o2k3", "Board export", 190, { permissions: ["notifications"], relation: "team", policy: { install: false, fullAccess: false } }),
};

function seed(): FakeState {
  const i = FAKE_INFOS;
  const app = (x: AppInfo, grants: AppPermission[], o: Partial<InstalledApp> = {}): InstalledApp => ({
    slug: x.slug, name: x.app.name, iconUrl: x.icons["512"], version: x.version, grantedVersion: x.version,
    grants, requested: x.app.permissions, needsReview: false, platform: "darwin", running: true, ...o,
  });
  const consent = (id: string, kind: ConsentRequest["kind"], x: AppInfo, asked: AppPermission[], current: AppPermission[]): ConsentRequest => ({
    id, kind, info: x, asked, current, added: asked.filter((p) => !current.includes(p)),
  });
  return {
    apps: [
      app(i.vitals, ["notifications", "menu-bar", "shortcuts"]),
      app(i.deploys, ["notifications", "menu-bar", "full-access"], { running: false }),
      app(i.standup, ["notifications"], { needsReview: true, grantedVersion: 3 }),
      app(i.agentNotes, ["notifications"], { platform: "darwin" }),
    ],
    consents: {
      "install-plain": consent("install-plain", "install", i.vitals, i.vitals.app.permissions, []),
      "install-full": consent("install-full", "install", i.deploys, i.deploys.app.permissions, []),
      "install-blocked": consent("install-blocked", "install", i.standup, i.standup.app.permissions, []),
      "install-outside": consent("install-outside", "install", i.outside, i.outside.app.permissions, []),
      "install-off": consent("install-off", "install", i.blockedTeam, i.blockedTeam.app.permissions, []),
      review: consent("review", "review", i.standup, ["notifications", "overlay"], ["notifications"]),
      "review-none": consent("review-none", "review", { ...i.vitals, version: 8 }, i.vitals.app.permissions, i.vitals.app.permissions),
      request: consent("request", "request", i.agentNotes, ["agent"], ["notifications"]),
    },
    answers: [],
  };
}

function load(): FakeState {
  try {
    const raw = localStorage.getItem(STATE);
    if (raw) return JSON.parse(raw) as FakeState;
  } catch { /* reseed */ }
  const s = seed();
  localStorage.setItem(STATE, JSON.stringify(s));
  return s;
}

const listeners = new Set<(apps: InstalledApp[]) => void>();
function save(s: FakeState) {
  localStorage.setItem(STATE, JSON.stringify(s));
  for (const cb of listeners) cb(s.apps);
}

function makeFake(): DesktopAppsBridge {
  window.addEventListener("storage", (e) => {
    if (e.key === STATE) for (const cb of listeners) cb(load().apps);
  });
  const later = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 60));
  return {
    list: () => later(load().apps),
    async install(x) {
      const s = load();
      const id = `install-${x.slug}`;
      s.consents[id] = { id, kind: "install", info: x, asked: x.app.permissions, current: [], added: x.app.permissions };
      save(s);
      // Main opens the sheet in a window of its own; a popup stands in.
      window.open(`/apps/consent/${id}`, `consent-${id}`, "popup,width=520,height=760");
    },
    async open(slug) { console.info("[appsFake] open", slug); },
    async uninstall(slug) {
      const s = load();
      s.apps = s.apps.filter((a) => a.slug !== slug);
      save(s);
    },
    async setGrants(slug, grants) {
      const s = load();
      s.apps = s.apps.map((a) => (a.slug === slug ? { ...a, grants: grants as AppPermission[], grantedVersion: a.version, needsReview: false } : a));
      save(s);
    },
    facts(slug, x) { console.info("[appsFake] facts", slug, x.version, x.relation); },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    consent: {
      get: (id) => later(load().consents[id] ?? null),
      // Main fits its window to the route; the dev popup stands in the same way.
      resize(_id, height) {
        (window as { __appsFakeHeight?: number }).__appsFakeHeight = height;
        window.resizeTo(window.outerWidth, Math.min(height + (window.outerHeight - window.innerHeight), screen.availHeight));
      },
      async answer(id, a) {
        const s = load();
        s.answers.push({ id, ...a });
        const req = s.consents[id];
        if (req && a.approve) {
          const x = req.info;
          const grants = consentGrants(req, new Set(a.grants as AppPermission[]));
          const existing = s.apps.find((p) => p.slug === x.slug);
          if (existing) s.apps = s.apps.map((p) => (p.slug === x.slug ? { ...p, grants, grantedVersion: x.version, version: x.version, needsReview: false } : p));
          else s.apps.push({ slug: x.slug, name: x.app.name, iconUrl: x.icons["512"], version: x.version, grantedVersion: x.version, grants, requested: x.app.permissions, needsReview: false, platform: "darwin", running: true });
        }
        save(s);
      },
    },
  };
}

const param = new URLSearchParams(window.location.search).get("appsFake");
// A browser on a computer without the desktop app: the install link goes nowhere, so the download choice shows.
if (param === "nohandler") {
  localStorage.removeItem(ON);
  (window as { __CODECAST_NO_DESKTOP__?: boolean }).__CODECAST_NO_DESKTOP__ = true;
}
if (param === "1") localStorage.setItem(ON, "1");
if (param === "0") localStorage.removeItem(ON);
if (param === "reset") localStorage.removeItem(STATE);
if (param === "empty") localStorage.setItem(STATE, JSON.stringify({ ...seed(), apps: [] }));
if (localStorage.getItem(ON) === "1" || param === "reset" || param === "empty") {
  localStorage.setItem(ON, "1");
  (window as { __CODECAST_APPS_FAKE__?: DesktopAppsBridge }).__CODECAST_APPS_FAKE__ = makeFake();
  window.dispatchEvent(new Event("codecast-apps-bridge"));
}
