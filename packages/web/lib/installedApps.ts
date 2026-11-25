// Installed apps on the web side (docs/architecture/installed-apps.md): the
// shapes the desktop bridge hands the web app, and the pure rules the install
// sheet, the consent route and Settings > Installed apps draw from. No React
// and no bridge access here, so every rule is testable as data.
import {
  APP_PERMISSIONS,
  APP_PERMISSION_LABEL,
  type AppPermission,
  type AppRelation,
  type AppsPolicy,
  type ResolvedPageApp,
} from "@codecast/shared/contracts/pageApp";
import type { SwitchLedger } from "../components/consequential/ConsequentialSwitch";

export type GateKeys = { k?: string; e?: string; m?: string };

/** api.artifacts.appInfo's answer (convex/artifacts.ts AppInfo), with the gate keys the query hands a host. */
export type AppInfo = {
  slug: string;
  title: string;
  version: number;
  updated_at: number;
  app: ResolvedPageApp;
  owner: { name: string | null };
  icons: { "512": string; "1024": string };
  relation: AppRelation;
  policy: AppsPolicy;
  gate?: GateKeys;
};

/** One install on this computer, as the desktop's registry reports it (apps.list). */
export type InstalledApp = {
  slug: string;
  name: string;
  iconUrl: string;
  /** The page's current version, from the last facts. */
  version: number;
  grantedVersion: number;
  grants: AppPermission[];
  /** What the current version's manifest asks for. */
  requested: AppPermission[];
  needsReview: boolean;
  platform: "darwin" | "win32" | string;
  /** Whether a window or tray item of the app is open now; absent from a host that does not say. */
  running?: boolean;
  /** The gate keys stored with the install, so the facts feed can read a gated page. */
  gate?: GateKeys;
};

export type ConsentKind = "install" | "request" | "review";

/** What main asks the consent route to show (apps.consent.get). */
export type ConsentRequest = {
  id: string;
  kind: ConsentKind;
  info: AppInfo;
  /** What this moment asks for: the manifest's list at install, the call's list for a request, the version's list at review. */
  asked: AppPermission[];
  /** What the person granted before (empty at install). */
  current: AppPermission[];
  /** What `asked` adds over `current`: the only toggles a review shows. */
  added: AppPermission[];
};

/** window.__CODECAST_ELECTRON__.apps: present only in the desktop app. */
export type DesktopAppsBridge = {
  list(): Promise<InstalledApp[]>;
  install(info: AppInfo): Promise<void>;
  open(slug: string): Promise<void>;
  uninstall(slug: string): Promise<void>;
  setGrants(slug: string, grants: string[]): Promise<void>;
  facts(slug: string, info: AppInfo): void;
  onChange(cb: (apps: InstalledApp[]) => void): () => void;
  consent: {
    get(id: string): Promise<ConsentRequest | null>;
    answer(id: string, answer: { approve: boolean; grants: string[] }): Promise<void>;
  };
};

// ── Permissions, as a person reads them ──

/** What granting a permission does, in a few words, beside its label. */
export function permissionEffect(p: AppPermission, platform: string): string {
  switch (p) {
    case "notifications": return "Alerts under its own name";
    case "menu-bar": return platform === "win32" ? "An icon in the tray" : "An icon in the menu bar";
    case "shortcuts": return "Keys that work in any app";
    case "overlay": return "Floats above other windows";
    case "agent": return "Runs as you, counts toward your usage";
    case "login": return "Opens when you log in";
    case "full-access": return "Runs programs, reads and changes files";
  }
}

export const permissionLabel = (p: AppPermission) => APP_PERMISSION_LABEL[p];

/** Why full access cannot be granted to this page, in a word or two; null when it can. Mirrors engine.js fullAccessRefusal. */
export function fullAccessBlock(info: Pick<AppInfo, "relation" | "policy">): string | null {
  if (info.relation !== "owner" && info.relation !== "team") return "Not your page";
  if (!info.policy.fullAccess) return "Off for your team";
  return null;
}

/** Who made the page, as the sheet names them. */
export function madeBy(info: Pick<AppInfo, "relation" | "owner">): string {
  if (info.relation === "owner") return "You";
  const name = info.owner.name ?? "Someone";
  return info.relation === "team" ? `${name} · teammate` : name;
}

const ordered = (ps: Iterable<string>): AppPermission[] => {
  const set = new Set(ps);
  return APP_PERMISSIONS.filter((p) => set.has(p));
};

export type ConsentToggle = { perm: AppPermission; on: boolean; block: string | null };

/**
 * The toggle rows a consent moment shows, each starting where the person most
 * likely means it: an app permission the app asks for starts on, full access
 * starts off (it is turned on deliberately), and full access that cannot be
 * granted shows locked with the reason. A review shows only what the version
 * adds; what the person granted before is kept as it is.
 */
export function consentToggles(req: ConsentRequest): ConsentToggle[] {
  const shown = req.kind === "review" ? req.added : req.asked;
  const block = fullAccessBlock(req.info);
  return ordered(shown).map((perm) => {
    if (perm !== "full-access") return { perm, on: true, block: null };
    return { perm, on: false, block };
  });
}

/** The complete grant list for this version after the person's choices. */
export function consentGrants(req: ConsentRequest, chosen: ReadonlySet<AppPermission>): AppPermission[] {
  const block = fullAccessBlock(req.info);
  const picked = [...chosen].filter((p) => p !== "full-access" || !block);
  // A request answers only what it asked; what was granted before stays granted.
  const kept = req.kind === "install" ? [] : req.current.filter((p) => p !== "full-access" || !block);
  return ordered([...kept, ...picked]);
}

/** The page's public address without the scheme: the identity a consent sheet shows, which a page cannot fake. */
export const pageAddress = (shareUrl: string) => shareUrl.replace(/^https?:\/\//, "");

/** The consent sheet's review (ConsequentialSwitch SwitchLedger) for one moment and the person's current choices. */
export function consentLedger(req: ConsentRequest, chosen: ReadonlySet<AppPermission>, address: string): SwitchLedger {
  const { info } = req;
  const name = info.app.name;
  const grants = consentGrants(req, chosen);
  const full = grants.includes("full-access");
  const kept = req.current.filter((p) => !req.added.includes(p));
  const rows: SwitchLedger["rows"] = [];
  if (req.kind === "install") {
    rows.push({ k: "Window", v: `Its own · ${info.app.window.width}×${info.app.window.height}` });
    rows.push({ k: "Updates", v: "Live, on every publish" });
    rows.push({ k: "Asks again", v: "When a version wants more" });
  } else if (req.kind === "review") {
    rows.push({ k: "Kept", v: kept.length ? kept.map(permissionLabel).join(", ") : "Nothing granted yet" });
    if (!req.added.length) rows.push({ k: "Asks for", v: "Nothing new", tone: "ok" });
  } else {
    rows.push({ k: "Already has", v: req.current.length ? req.current.map(permissionLabel).join(", ") : "Nothing" });
  }
  // Below the switches, never above: turning full access on must not move the switch under the pointer.
  if (full) rows.push({ k: "Full access", v: "Any file you can reach, any program", tone: "warn" });
  rows.push({ k: "To change", v: "Settings › Installed apps" });
  const confirm = req.kind === "install" ? `Install ${name}` : req.kind === "request" ? "Allow" : req.added.length ? "Allow changes" : `Keep using ${name}`;
  return {
    name: req.kind === "install" ? "Install as app" : req.kind === "request" ? `${name} asks for more` : "Review changes",
    subject: address,
    shift: null,
    figures: [],
    rows,
    confirm,
    keep: req.kind === "install" ? "Cancel" : req.kind === "request" ? "Don't allow" : "Not now",
    ...(req.kind === "install" && !info.policy.install ? { blocked: "Installs are off for your team" } : {}),
  };
}

/** Turning full access on for an installed app from Settings: the same weight as at install. */
export function fullAccessLedger(name: string, address: string): SwitchLedger {
  return {
    name: "Full access",
    subject: `${name} · ${address}`,
    alert: "It can run programs and change files",
    figures: [],
    rows: [
      { k: "Files", v: "Read, write and delete anywhere you can", tone: "warn" },
      { k: "Programs", v: "Runs any program as you", tone: "warn" },
      { k: "Until", v: "A new version, or you turn it off" },
    ],
    stop: "Turn the switch off",
    confirm: "Give full access",
  };
}

// ── Settings > Installed apps ──

export type InstalledAppState = "review" | "stopped" | "current";
export const INSTALLED_APP_STATE_LABEL: Record<InstalledAppState, string> = {
  review: "Review needed",
  stopped: "Not running",
  current: "Up to date",
};

export function installedAppState(a: Pick<InstalledApp, "needsReview" | "running">): InstalledAppState {
  if (a.needsReview) return "review";
  if (a.running === false) return "stopped";
  return "current";
}

/**
 * The grants a row stands on. While a new version waits for review, full
 * access granted to an earlier version is not held: a new version always
 * passes through the full-access review again, so no other switch or approval
 * on the row can carry it over.
 */
export function heldGrants(a: Pick<InstalledApp, "grants" | "needsReview">): AppPermission[] {
  return a.needsReview ? a.grants.filter((p) => p !== "full-access") : [...a.grants];
}

/** The grant switches a row shows: everything the app asks for or holds, in catalog order, with full access locked when it cannot be had. */
export function grantRows(a: Pick<InstalledApp, "requested" | "grants" | "needsReview">, info: Pick<AppInfo, "relation" | "policy"> | null | "unavailable"): ConsentToggle[] {
  const held = heldGrants(a);
  return ordered([...a.requested, ...a.grants]).map((perm) => ({
    perm,
    on: held.includes(perm),
    // Without the page's facts, full access stays as it is: turning it off is always allowed, on waits for the facts.
    block: perm !== "full-access" ? null : info && info !== "unavailable" ? fullAccessBlock(info) : held.includes(perm) ? null : info === "unavailable" ? "Page unavailable" : "Checking",
  }));
}

/** Approving a new version from Settings: the same review the consent route shows, built from the row and the page's facts. */
export function reviewRequest(a: Pick<InstalledApp, "slug" | "requested" | "grants" | "needsReview">, info: AppInfo): ConsentRequest {
  const current = heldGrants(a);
  return {
    id: `settings-${a.slug}`,
    kind: "review",
    info,
    asked: ordered(a.requested),
    current,
    added: ordered(a.requested.filter((p) => !current.includes(p))),
  };
}

/** The grants after flipping one switch, in catalog order. */
export function flipGrant(grants: readonly AppPermission[], perm: AppPermission, on: boolean): AppPermission[] {
  return ordered(on ? [...grants, perm] : grants.filter((p) => p !== perm));
}

// ── The install deep link (codecast://install/<slug>?k=…&m=…) ──

const SLUG = /^[A-Za-z0-9_-]{1,64}$/;

export function installDeepLink(slug: string, gate: GateKeys = {}): string {
  const q = new URLSearchParams();
  for (const k of ["k", "e", "m"] as const) if (gate[k]) q.set(k, gate[k]!);
  const qs = q.toString();
  return `codecast://install/${encodeURIComponent(slug)}${qs ? `?${qs}` : ""}`;
}

export function parseInstallDeepLink(url: string): { slug: string; gate: GateKeys } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "codecast:" || u.hostname !== "install") return null;
  const slug = decodeURIComponent(u.pathname.replace(/^\/+|\/+$/g, ""));
  if (!SLUG.test(slug)) return null;
  const gate: GateKeys = {};
  for (const k of ["k", "e", "m"] as const) {
    const v = u.searchParams.get(k);
    if (v) gate[k] = v;
  }
  return { slug, gate };
}

// ── Shared words and args ──

export const INSTALL_AS_APP = "Install as app";

/** The gate keys as plain query args: only the keys the install holds, so an ungated page asks with its slug alone. */
export function factsArgs(slug: string, gate: GateKeys | undefined): { slug: string } & GateKeys {
  const args: { slug: string } & GateKeys = { slug };
  for (const k of ["k", "e", "m"] as const) if (gate?.[k]) args[k] = gate[k];
  return args;
}

/** Team settings: full access for every member's installed apps, turned on. */
export function teamFullAccessLedger(team: string): SwitchLedger {
  return {
    name: "Full access for installed apps",
    subject: team,
    figures: [],
    rows: [
      { k: "Who", v: "Members, on their own and teammates' pages" },
      { k: "Apps may", v: "Run programs, read and change files", tone: "warn" },
      { k: "Each app", v: "Still asks the person, per version" },
      { k: "Outside pages", v: "Never", tone: "ok" },
    ],
    stop: "Turn the switch off",
    confirm: "Allow full access",
  };
}
