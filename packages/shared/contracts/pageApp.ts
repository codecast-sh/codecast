// Installed apps (docs/architecture/installed-apps.md): the "app" block a page
// declares beside its queries and state, in cast-data.json or the inline
// <script type="application/cast-data+json">. One parser for the CLI's
// publish check, the server's publish path and appInfo, and one permission
// table for the desktop engine and the install sheet.

/** What an installed app can ask for, in the order the install sheet lists them. */
export const APP_PERMISSIONS = ["notifications", "menu-bar", "shortcuts", "overlay", "agent", "login", "full-access"] as const;
export type AppPermission = (typeof APP_PERMISSIONS)[number];

/**
 * The tier each permission sits in. `default` is not a permission: it is what
 * every installed app gets (cast.app.window.*, badge, info, permissions.*, on).
 * `app` permissions are granted one by one; `full` is full access, offered
 * only for the person's own or their team's pages under team policy.
 */
export type AppTier = "default" | "app" | "full";
export const APP_PERMISSION_TIER: Record<AppPermission, Exclude<AppTier, "default">> = {
  notifications: "app",
  "menu-bar": "app",
  shortcuts: "app",
  overlay: "app",
  agent: "app",
  login: "app",
  "full-access": "full",
};

/** A permission's name on the install sheet and in Settings > Installed apps. */
export const APP_PERMISSION_LABEL: Record<AppPermission, string> = {
  notifications: "Notifications",
  "menu-bar": "Menu bar",
  shortcuts: "Global shortcuts",
  overlay: "Always on top",
  agent: "Ask your agent",
  login: "Open at login",
  "full-access": "Full access",
};

export const APP_TITLE_BARS = ["default", "hidden"] as const;
export type AppTitleBar = (typeof APP_TITLE_BARS)[number];

/** Bounds every size is clamped into, in CSS pixels. */
export const PAGE_APP_LIMITS = {
  name_chars: 60,
  tooltip_chars: 120,
  path_chars: 200,
  window: { min: 200, max: 4096 },
  tray: { min: 120, max: 1200 },
} as const;

/** The sizes the icon route renders a generated tile at; hosts build icns and ico from 512 and 1024. */
export const APP_ICON_SIZES = [16, 32, 64, 128, 256, 512, 1024] as const;
export const APP_ICON_DEFAULT_SIZE = 512;

/** Width and height from a PNG's IHDR chunk (its first 24 bytes), or null when the bytes are not a PNG. */
export function pngDimensions(head: Uint8Array): { width: number; height: number } | null {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  if (head.byteLength < 24 || SIG.some((b, i) => head[i] !== b)) return null;
  if (String.fromCharCode(head[12], head[13], head[14], head[15]) !== "IHDR") return null;
  const view = new DataView(head.buffer, head.byteOffset, 24);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** The smallest app icon a host can build its Dock and taskbar icons from. */
export const APP_ICON_MIN_PX = 512;

/**
 * The manifest's icons must be PNG files the bundle carries, and the app icon
 * a square PNG of at least APP_ICON_MIN_PX. `head` reads a file's first bytes
 * (the server reads an upload, the CLI the local file), so both refuse alike.
 */
export async function appIconProblem<F extends { path: string; content_type: string }>(
  app: PageApp | undefined,
  files: F[],
  head: (file: F) => Promise<Uint8Array | null>,
): Promise<string | null> {
  for (const [field, path] of [["app.icon", app?.icon], ["app.tray.icon", app?.tray?.icon]] as const) {
    if (!path) continue;
    const file = files.find((f) => f.path === path);
    if (!file || file.content_type !== "image/png") return `"${field}" names ${path}, which is not a PNG file in the bundle`;
    if (field !== "app.icon") continue;
    const bytes = await head(file);
    const size = bytes ? pngDimensions(bytes) : null;
    if (!size) return `"app.icon" names ${path}, which is not a valid PNG`;
    if (size.width !== size.height) return `"app.icon" must be square; ${path} is ${size.width}x${size.height}`;
    if (size.width < APP_ICON_MIN_PX) return `"app.icon" must be at least ${APP_ICON_MIN_PX}x${APP_ICON_MIN_PX}; ${path} is ${size.width}x${size.height}`;
  }
  return null;
}

export interface PageAppWindow {
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  resizable?: boolean;
  titleBar?: AppTitleBar;
}

export interface PageAppTray {
  icon?: string;
  width?: number;
  height?: number;
  tooltip?: string;
}

/** The block as declared, checked and clamped: only the fields the page set. */
export interface PageApp {
  name?: string;
  icon?: string;
  window?: PageAppWindow;
  tray?: PageAppTray;
  permissions?: AppPermission[];
}

/** The block with every default filled in: what a host installs. */
export interface ResolvedPageApp {
  name: string;
  /** Bundle-relative path of the declared icon; null means the server's generated tile. */
  icon: string | null;
  window: Required<PageAppWindow>;
  tray: { icon: string | null; width: number; height: number; tooltip: string };
  permissions: AppPermission[];
}

export const PAGE_APP_DEFAULTS = {
  window: { width: 1024, height: 768, minWidth: 320, minHeight: 240, resizable: true, titleBar: "default" as AppTitleBar },
  tray: { width: 360, height: 480 },
} as const;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

function unknownKeys(o: Record<string, unknown>, allowed: readonly string[], where: string): string | null {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  return extra.length ? `${where}: unknown field${extra.length > 1 ? "s" : ""} ${extra.map((k) => JSON.stringify(k)).join(", ")} (fields: ${allowed.join(", ")})` : null;
}

function size(raw: unknown, where: string, bounds: { min: number; max: number }): Parsed<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "number" || !Number.isFinite(raw)) return { ok: false, error: `${where} must be a number of pixels` };
  return { ok: true, value: Math.round(Math.min(bounds.max, Math.max(bounds.min, raw))) };
}

/** A bundle-relative PNG path: no scheme, no leading slash, no "..". */
function pngPath(raw: unknown, where: string): Parsed<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: `${where} must be a path to a PNG in the bundle` };
  const path = raw.trim().replace(/^\.\//, "");
  if (path.length > PAGE_APP_LIMITS.path_chars || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("/") || path.split("/").includes("..") || path.includes("\\")) {
    return { ok: false, error: `${where} must be a path inside the bundle, like "icon.png"` };
  }
  if (!/\.png$/i.test(path)) return { ok: false, error: `${where} must be a .png file` };
  return { ok: true, value: path };
}

function text(raw: unknown, where: string, max: number): Parsed<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "string") return { ok: false, error: `${where} must be a string` };
  const t = raw.replace(/\s+/g, " ").trim();
  return { ok: true, value: t ? t.slice(0, max) : undefined };
}

/** Drops the keys a parse left undefined, so a stored manifest holds only what the page set. */
function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/**
 * The "app" block checked: unknown fields and permissions refuse with a reason
 * the publisher can act on; sizes are clamped into PAGE_APP_LIMITS, and a
 * minimum never exceeds its size.
 */
export function parsePageApp(raw: unknown): { ok: true; app: PageApp } | { ok: false; error: string } {
  if (!isObject(raw)) return { ok: false, error: `"app" must be an object` };
  const bad = unknownKeys(raw, ["name", "icon", "window", "tray", "permissions"], `"app"`);
  if (bad) return { ok: false, error: bad };
  const app: PageApp = {};

  const name = text(raw.name, `"app.name"`, PAGE_APP_LIMITS.name_chars);
  if (!name.ok) return name;
  if (name.value) app.name = name.value;
  const icon = pngPath(raw.icon, `"app.icon"`);
  if (!icon.ok) return icon;
  if (icon.value) app.icon = icon.value;

  if (raw.window !== undefined) {
    const w = raw.window;
    if (!isObject(w)) return { ok: false, error: `"app.window" must be an object` };
    const badW = unknownKeys(w, ["width", "height", "minWidth", "minHeight", "resizable", "titleBar"], `"app.window"`);
    if (badW) return { ok: false, error: badW };
    const win: PageAppWindow = {};
    for (const k of ["width", "height", "minWidth", "minHeight"] as const) {
      const s = size(w[k], `"app.window.${k}"`, PAGE_APP_LIMITS.window);
      if (!s.ok) return s;
      win[k] = s.value;
    }
    if (win.minWidth !== undefined && win.width !== undefined) win.minWidth = Math.min(win.minWidth, win.width);
    if (win.minHeight !== undefined && win.height !== undefined) win.minHeight = Math.min(win.minHeight, win.height);
    if (w.resizable !== undefined) {
      if (typeof w.resizable !== "boolean") return { ok: false, error: `"app.window.resizable" is true or false` };
      win.resizable = w.resizable;
    }
    if (w.titleBar !== undefined) {
      if (!(APP_TITLE_BARS as readonly unknown[]).includes(w.titleBar)) return { ok: false, error: `"app.window.titleBar" is one of ${APP_TITLE_BARS.join(", ")}` };
      win.titleBar = w.titleBar as AppTitleBar;
    }
    const kept = compact(win);
    if (Object.keys(kept).length) app.window = kept;
  }

  if (raw.tray !== undefined) {
    const t = raw.tray;
    if (!isObject(t)) return { ok: false, error: `"app.tray" must be an object` };
    const badT = unknownKeys(t, ["icon", "width", "height", "tooltip"], `"app.tray"`);
    if (badT) return { ok: false, error: badT };
    const trayIcon = pngPath(t.icon, `"app.tray.icon"`);
    if (!trayIcon.ok) return trayIcon;
    const width = size(t.width, `"app.tray.width"`, PAGE_APP_LIMITS.tray);
    if (!width.ok) return width;
    const height = size(t.height, `"app.tray.height"`, PAGE_APP_LIMITS.tray);
    if (!height.ok) return height;
    const tooltip = text(t.tooltip, `"app.tray.tooltip"`, PAGE_APP_LIMITS.tooltip_chars);
    if (!tooltip.ok) return tooltip;
    const tray = compact({ icon: trayIcon.value, width: width.value, height: height.value, tooltip: tooltip.value });
    if (Object.keys(tray).length) app.tray = tray;
  }

  if (raw.permissions !== undefined) {
    if (!Array.isArray(raw.permissions)) return { ok: false, error: `"app.permissions" must be a list, like ["notifications"]` };
    const unknown = raw.permissions.filter((p) => !(APP_PERMISSIONS as readonly unknown[]).includes(p));
    if (unknown.length) {
      return { ok: false, error: `"app.permissions": unknown permission${unknown.length > 1 ? "s" : ""} ${unknown.map((p) => JSON.stringify(p)).join(", ")} (permissions: ${APP_PERMISSIONS.join(", ")})` };
    }
    // Catalog order, once each: two manifests asking for the same set compare equal.
    app.permissions = APP_PERMISSIONS.filter((p) => (raw.permissions as unknown[]).includes(p));
  }
  return { ok: true, app };
}

/** The manifest a host installs: the page's block over the defaults, named after the page when it names nothing. */
export function resolvePageApp(app: PageApp | null | undefined, title: string): ResolvedPageApp {
  const w = { ...PAGE_APP_DEFAULTS.window, ...(app?.window ?? {}) };
  w.minWidth = Math.min(w.minWidth, w.width);
  w.minHeight = Math.min(w.minHeight, w.height);
  const name = app?.name ?? (title.replace(/\s+/g, " ").trim().slice(0, PAGE_APP_LIMITS.name_chars) || "Untitled");
  return {
    name,
    icon: app?.icon ?? null,
    window: w,
    tray: {
      icon: app?.tray?.icon ?? null,
      width: app?.tray?.width ?? PAGE_APP_DEFAULTS.tray.width,
      height: app?.tray?.height ?? PAGE_APP_DEFAULTS.tray.height,
      tooltip: app?.tray?.tooltip ?? name,
    },
    permissions: app?.permissions ?? [],
  };
}

/** The permissions `next` asks for that `prev` did not: what a version's re-ask has to show. */
export function newPermissions(prev: readonly AppPermission[], next: readonly AppPermission[]): AppPermission[] {
  return next.filter((p) => !prev.includes(p));
}

/** The size the icon route renders: a known size at or above the ask, capped at the largest. */
export function appIconSize(raw: string | null | undefined): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return APP_ICON_DEFAULT_SIZE;
  return APP_ICON_SIZES.find((s) => s >= n) ?? APP_ICON_SIZES[APP_ICON_SIZES.length - 1];
}

/** Where the viewer stands to a page's owner: what full access is offered against. */
export type AppRelation = "owner" | "team" | "other" | "anonymous";

export interface AppsPolicy {
  /** May members install pages as apps at all. */
  install: boolean;
  /** May installed apps get full access. */
  fullAccess: boolean;
}

/**
 * A team's apps policy from its settings row (teams.apps_install,
 * teams.apps_full_access): installs on and full access off until an admin
 * says otherwise. No team (a personal workspace) allows both.
 */
export function teamAppsPolicy(team: { apps_install?: boolean; apps_full_access?: boolean } | null): AppsPolicy {
  if (!team) return { install: true, fullAccess: true };
  return { install: team.apps_install ?? true, fullAccess: team.apps_full_access ?? false };
}
