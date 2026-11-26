// `cast publish install | uninstall | apps`: published pages as desktop apps
// (docs/architecture/installed-apps.md), from the agent's side.
//
// The CLI never installs anything and never grants a permission. Install and
// uninstall hand a codecast:// link to the desktop app through the OS opener,
// and the desktop shows its own sheet for the person to confirm. `apps` reads
// the desktop's registry (settings.json `installedApps`) read-only and never
// prints the gate keys a record holds.
//
// The pure parts (link building, opener per OS, registry path and parse) are
// exported for publishApps.test.ts; the run* functions own IO and output.

import { spawn } from "./proc.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { APP_PERMISSION_LABEL, APP_PERMISSIONS, appIconProblem, type AppPermission, type PageApp } from "@codecast/shared/contracts/pageApp";
import { parsePageDataDeclaration } from "@codecast/shared/contracts/pageData";
import { fmt, icons } from "./colors.js";
import { pageSlugFromRef } from "./publishCommand.js";

const GATE_PARAMS = ["k", "e", "m"] as const;
export type GateKeys = Partial<Record<(typeof GATE_PARAMS)[number], string>>;

// ── targets ─────────────────────────────────────────────────────────────────

/**
 * A page named by URL or bare slug: its slug plus the gate keys the URL
 * carries (`?k=`, `?e=`, `?m=`). Both URL shapes work: codecast.sh/a/<slug>
 * and a.codecast.sh/<slug>. Null for anything else (a path, which the caller
 * resolves through its published pages).
 */
export function parsePageTarget(target: string): { slug: string; gate: GateKeys } | null {
  const t = target.trim();
  if (/^https?:\/\//i.test(t)) {
    let url: URL;
    try {
      url = new URL(t);
    } catch {
      return null;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    const slug = url.hostname.startsWith("a.") ? segments[0] : pageSlugFromRef(t);
    if (!slug || !/^[A-Za-z0-9]+$/.test(slug)) return null;
    const gate: GateKeys = {};
    for (const k of GATE_PARAMS) {
      const v = url.searchParams.get(k);
      if (v) gate[k] = v;
    }
    return { slug, gate };
  }
  const slug = pageSlugFromRef(t);
  return slug ? { slug, gate: {} } : null;
}

// ── deep links and the OS opener ────────────────────────────────────────────

/** `codecast://install/<slug>?k=…` or `codecast://uninstall/<slug>`: what the desktop app answers with its own sheet. */
export function appDeepLink(action: "install" | "uninstall", slug: string, gate: GateKeys = {}): string {
  const q = new URLSearchParams();
  if (action === "install") for (const k of GATE_PARAMS) if (gate[k]) q.set(k, gate[k]!);
  const query = q.toString();
  return `codecast://${action}/${encodeURIComponent(slug)}${query ? `?${query}` : ""}`;
}

export interface OpenerCommand {
  cmd: string;
  args: string[];
  /** Windows: hand args to cmd.exe as written, so the quotes around the URL survive and `&` stays inside them. */
  verbatim?: boolean;
}

/** How this OS opens a URL with its registered handler. */
export function openerCommand(platform: NodeJS.Platform, url: string): OpenerCommand {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "cmd.exe", args: ["/d", "/s", "/c", `start "" "${url.replace(/"/g, "%22")}"`], verbatim: true };
  return { cmd: "xdg-open", args: [url] };
}

/** Where the desktop app keeps settings.json: Electron's userData for the app named Codecast, or CODECAST_USER_DATA when a run set it. */
export function desktopUserDataDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (env.CODECAST_USER_DATA) return env.CODECAST_USER_DATA;
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Codecast");
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Codecast");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Codecast");
}

/** The places the desktop app is installed on this OS; empty where there is no desktop app (Linux). */
export function desktopAppPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  if (platform === "darwin") return ["/Applications/Codecast.app", path.join(home, "Applications", "Codecast.app")];
  if (platform === "win32") return [path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Programs", "Codecast", "Codecast.exe")];
  return [];
}

// ── the registry ────────────────────────────────────────────────────────────

/** One installed app as `cast publish apps` shows it. The record's gate keys are left out on purpose. */
export interface InstalledAppRow {
  slug: string;
  name: string;
  installedAt: number | null;
  grantedVersion: number | null;
  grants: string[];
}

/** settings.json's `installedApps`, newest install first. Unreadable or missing text reads as no apps. */
export function parseInstalledApps(settingsText: string | null): InstalledAppRow[] {
  if (!settingsText) return [];
  let settings: unknown;
  try {
    settings = JSON.parse(settingsText);
  } catch {
    return [];
  }
  const apps = (settings as { installedApps?: unknown } | null)?.installedApps;
  if (!apps || typeof apps !== "object" || Array.isArray(apps)) return [];
  const rows: InstalledAppRow[] = [];
  for (const [slug, raw] of Object.entries(apps as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    rows.push({
      slug,
      name: typeof r.name === "string" && r.name ? r.name : slug,
      installedAt: typeof r.installedAt === "number" ? r.installedAt : null,
      grantedVersion: typeof r.grantedVersion === "number" ? r.grantedVersion : null,
      grants: Array.isArray(r.grants) ? r.grants.filter((g): g is string => typeof g === "string") : [],
    });
  }
  return rows.sort((a, b) => (b.installedAt ?? 0) - (a.installedAt ?? 0));
}

export function readInstalledApps(userDataDir: string): InstalledAppRow[] {
  try {
    return parseInstalledApps(fs.readFileSync(path.join(userDataDir, "settings.json"), "utf-8"));
  } catch {
    return [];
  }
}

/** Plain-text table for `cast publish apps`. */
export function formatInstalledApps(rows: InstalledAppRow[], siteUrl: string): string[] {
  if (!rows.length) return ["No pages installed as apps on this computer. Install one with: cast publish install <slug>"];
  const cells = rows.map((r) => [
    r.slug,
    r.name,
    r.grantedVersion === null ? "-" : `v${r.grantedVersion}`,
    r.grants.length ? r.grants.join(",") : "-",
    `${siteUrl}/a/${r.slug}`,
  ]);
  const header = ["SLUG", "NAME", "GRANTED", "GRANTS", "URL"];
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((row) => row[i].length)));
  const render = (row: string[]) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join("  ");
  return [render(header), ...cells.map(render)];
}

// ── publish output ──────────────────────────────────────────────────────────

/** The permissions a manifest asks for, by their install-sheet names. */
export function describeAppPermissions(permissions: readonly string[] | undefined): string {
  const known = APP_PERMISSIONS.filter((p) => permissions?.includes(p));
  return known.length ? known.map((p: AppPermission) => APP_PERMISSION_LABEL[p].toLowerCase()).join(", ") : "nothing beyond its window";
}

/** The publish output's line for a page that declares an app block. */
export function appInstallLine(slug: string, app: PageApp): string {
  return `install with \`cast publish install ${slug}\`; asks for ${describeAppPermissions(app.permissions)}`;
}

// ── commands ────────────────────────────────────────────────────────────────

export interface AppsEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  exists: (p: string) => boolean;
  /** Runs the opener; resolves when it was handed off, rejects when the opener could not start. */
  run: (command: OpenerCommand) => Promise<void>;
}

function runOpener(command: OpenerCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.cmd, command.args, { stdio: "ignore", detached: true, windowsVerbatimArguments: command.verbatim });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export function defaultAppsEnv(): AppsEnv {
  return { platform: process.platform, env: process.env, home: os.homedir(), exists: (p) => fs.existsSync(p), run: runOpener };
}

/** Null when this computer has the desktop app; otherwise what to tell the person, with the download link. */
export function missingDesktopMessage(appsEnv: Pick<AppsEnv, "platform" | "env" | "home" | "exists">, siteUrl: string): string | null {
  const paths = desktopAppPaths(appsEnv.platform, appsEnv.env, appsEnv.home);
  if (paths.some((p) => appsEnv.exists(p))) return null;
  const download = `${siteUrl}/download`;
  if (!paths.length) return `Pages install as apps on macOS and Windows; this computer has no Codecast desktop app. Install it on a Mac or Windows PC from ${download}`;
  return `The Codecast desktop app is not installed on this computer. Download it from ${download}, then run this again.`;
}

function fail(message: string, json: boolean, extra: Record<string, unknown> = {}): never {
  if (json) console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  else console.error(fmt.error(message));
  process.exit(1);
}

/** `cast publish install`: open the desktop's install sheet for the page on this computer. */
export async function runPublishInstall(
  page: { slug: string; title?: string; gate: GateKeys },
  siteUrl: string,
  json: boolean,
  appsEnv: AppsEnv = defaultAppsEnv(),
): Promise<void> {
  const missing = missingDesktopMessage(appsEnv, siteUrl);
  if (missing) fail(missing, json, { download_url: `${siteUrl}/download` });
  const link = appDeepLink("install", page.slug, page.gate);
  try {
    await appsEnv.run(openerCommand(appsEnv.platform, link));
  } catch (e) {
    fail(`Could not hand the install to Codecast: ${e instanceof Error ? e.message : String(e)}`, json);
  }
  const name = page.title ?? page.slug;
  if (json) {
    console.log(JSON.stringify({ ok: true, slug: page.slug, action: "install", sheet_opened: true, gate_keys: Object.keys(page.gate) }, null, 2));
    return;
  }
  console.log(`${fmt.success(icons.check)} Opened the install sheet for ${fmt.highlight(name)} in Codecast`);
  console.log(fmt.muted("  The person picks its permissions and confirms there; nothing is installed until they do."));
}

/** `cast publish uninstall`: open Codecast's confirm for removing an installed page; the person removes it there. */
export async function runPublishUninstall(slug: string, siteUrl: string, json: boolean, appsEnv: AppsEnv = defaultAppsEnv()): Promise<void> {
  const missing = missingDesktopMessage(appsEnv, siteUrl);
  if (missing) fail(missing, json, { download_url: `${siteUrl}/download` });
  const installed = readInstalledApps(desktopUserDataDir(appsEnv.platform, appsEnv.env, appsEnv.home)).find((r) => r.slug === slug);
  if (!installed) fail(`${slug} is not installed as an app on this computer (cast publish apps lists them)`, json);
  try {
    await appsEnv.run(openerCommand(appsEnv.platform, appDeepLink("uninstall", slug)));
  } catch (e) {
    fail(`Could not hand the uninstall to Codecast: ${e instanceof Error ? e.message : String(e)}`, json);
  }
  if (json) {
    console.log(JSON.stringify({ ok: true, slug, action: "uninstall", sheet_opened: true }, null, 2));
    return;
  }
  console.log(`${fmt.success(icons.check)} Opened Codecast's confirm to uninstall ${fmt.highlight(installed.name)}`);
  console.log(fmt.muted("  The app stays installed until the person confirms there."));
}

/** `cast publish apps`: the pages installed as apps on this computer. */
export function runPublishApps(siteUrl: string, json: boolean, appsEnv: AppsEnv = defaultAppsEnv()): void {
  const dir = desktopUserDataDir(appsEnv.platform, appsEnv.env, appsEnv.home);
  const rows = readInstalledApps(dir);
  if (json) {
    console.log(JSON.stringify({ registry: path.join(dir, "settings.json"), apps: rows }, null, 2));
    return;
  }
  for (const line of formatInstalledApps(rows, siteUrl)) console.log(line);
}

/** The server's icon refusal for this payload, read from the files on disk, so a bad icon fails before anything uploads. */
export async function localAppIconProblem(payload: { data?: unknown; files?: Array<{ path: string }>; source_path: string; kind?: string }): Promise<string | null> {
  const app = declaredApp(payload.data);
  if (!app) return null;
  const dir = payload.kind === "bundle" ? payload.source_path : path.dirname(payload.source_path);
  const files = (payload.files ?? []).map((f) => ({ path: f.path, content_type: /\.png$/i.test(f.path) ? "image/png" : "" }));
  const problem = await appIconProblem(app, files, async (f) => {
    try {
      const fd = fs.openSync(path.join(dir, f.path), "r");
      try {
        const head = Buffer.alloc(24);
        return head.subarray(0, fs.readSync(fd, head, 0, 24, 0));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  });
  return problem ? `cast-data.json: ${problem}` : null;
}

/** The app block a page's declaration carries, checked; null without one. */
export function declaredApp(data: unknown): PageApp | null {
  if (!data) return null;
  const parsed = parsePageDataDeclaration(data);
  return parsed.ok ? (parsed.app ?? null) : null;
}
