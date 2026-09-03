// `cast publish` — shareable HTML/markdown/bundle artifacts (codecast.sh/a/<slug>).
//
// Registered from index.ts via registerPublishCommand(program, deps). Deps are
// handed in (doctor.ts pattern) because index.ts owns config decryption and
// session detection, and this module must stay importable by tests — index.ts
// runs program.parse() on import, so nothing here may import from it.
//
// Pure, testable logic (flag mapping, bundle selection, table formatting) lives
// in publishCommand.ts; this file owns IO: fs walks, HTTP, Chrome screenshots,
// the fs.watch loop, and output.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "./proc.js";
import { stdinText } from "./sendBody.js";
import type { Command } from "commander";
import open from "open";
import { cliFetch, cliFetchRead } from "./cliHttp.js";
import { c, fmt, icons } from "./colors.js";
import {
  buildAccessPayload,
  bundleSizeError,
  describeAccess,
  filterBundlePaths,
  formatAgeShort,
  formatArtifactTable,
  formatBytes,
  isHtmlPath,
  isMarkdownPath,
  parseExpires,
  pickBundleEntry,
  resolveArtifactTitle,
  resolveMarkdownTitle,
  type AccessFlagValues,
  type ArtifactLsRow,
} from "./publishCommand.js";

export interface PublishDeps {
  getCliEndpoint: () => { siteUrl: string; apiToken: string };
  detectCurrentSessionId: () => string | null;
}

const WATCH_DEBOUNCE_MS = 400;
const THUMB_TIMEOUT_MS = 10_000;

// ── backend calls ────────────────────────────────────────────────────────────

/**
 * A route the deployment does not have answers with an HTML page, not JSON, so
 * a CLI newer than the server otherwise reports the page body as a parse
 * failure. Returns the message to print, or null when the status says nothing
 * about a missing route.
 */
export function missingRouteError(urlPath: string, status: number): string | null {
  return status === 404
    ? `this codecast server has no ${urlPath} route — it needs a newer deployment.`
    : null;
}

export async function apiPost(
  deps: PublishDeps,
  urlPath: string,
  body: Record<string, unknown>,
  opts: { read?: boolean; exitOnError?: boolean } = {},
): Promise<any> {
  const { siteUrl, apiToken } = deps.getCliEndpoint();
  const doFetch = opts.read ? cliFetchRead : cliFetch;
  const response = await doFetch(`${siteUrl}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_token: apiToken, ...body }),
  });
  const text = await response.text();
  let result: any;
  try {
    result = JSON.parse(text);
  } catch {
    const message = missingRouteError(urlPath, response.status)
      ?? `API error (${response.status}): ${text.slice(0, 200)}`;
    if (opts.exitOnError === false) throw new Error(message);
    console.error(message);
    process.exit(1);
  }
  if (result?.error) {
    if (opts.exitOnError === false) throw new Error(String(result.error));
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }
  return result;
}

// ── bundle walk ──────────────────────────────────────────────────────────────

/** Every file under dir as sorted relative posix paths, skip rules applied. */
export function walkBundleDir(dir: string): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(relPath);
      else if (entry.isFile()) out.push(relPath);
    }
  };
  visit("");
  return filterBundlePaths(out);
}

// ── thumbnail capture ────────────────────────────────────────────────────────

export function findChrome(): string | null {
  const absolute = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((p): p is string => !!p);
  for (const candidate of absolute) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  for (const name of ["google-chrome", "chromium", "chromium-browser"]) {
    try {
      const found = spawnSync("which", [name], { encoding: "utf-8" }).stdout?.trim();
      if (found) return found;
    } catch {}
  }
  return null;
}

/** Headless-Chrome 1200x630 screenshot of a local html file → base64 png.
 * ANY failure (no Chrome, timeout, bad exit) returns null silently — a
 * thumbnail must never block or delay a publish beyond its timeout. */
export function captureThumb(entryHtmlAbsPath: string): string | null {
  try {
    const chrome = findChrome();
    if (!chrome) return null;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-thumb-"));
    const outPng = path.join(tmpDir, "thumb.png");
    try {
      const run = spawnSync(
        chrome,
        [
          "--headless=new",
          `--screenshot=${outPng}`,
          "--window-size=1200,630",
          "--hide-scrollbars",
          "--disable-gpu",
          "--no-first-run",
          `file://${entryHtmlAbsPath}`,
        ],
        { timeout: THUMB_TIMEOUT_MS, stdio: "ignore" },
      );
      if (run.status !== 0 || !fs.existsSync(outPng)) return null;
      return fs.readFileSync(outPng).toString("base64");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch {
    return null;
  }
}

// ── publish payload assembly ─────────────────────────────────────────────────

interface PublishPayload {
  title: string;
  source_path: string;
  kind?: "markdown" | "bundle";
  content?: string;
  files?: Array<{ path: string; content_b64: string }>;
  /** Local path of the html document a thumbnail should render. */
  entryHtmlPath?: string;
}

/** Read the file/dir into the /cli/artifacts/publish payload. Throws with a
 * legible message on anything the user must fix (missing entry, size cap). */
export function buildPublishPayload(absPath: string, titleOverride?: string): PublishPayload {
  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) {
    const relPaths = walkBundleDir(absPath);
    const entry = pickBundleEntry(relPaths);
    if (!entry.entry) throw new Error(entry.error);
    const files: Array<{ path: string; content_b64: string }> = [];
    const sizes: Array<{ path: string; size: number }> = [];
    for (const rel of relPaths) {
      const bytes = fs.readFileSync(path.join(absPath, rel));
      files.push({ path: rel, content_b64: bytes.toString("base64") });
      sizes.push({ path: rel, size: bytes.byteLength });
    }
    const sizeError = bundleSizeError(sizes);
    if (sizeError) throw new Error(sizeError);
    const entryHtml = fs.readFileSync(path.join(absPath, entry.entry), "utf-8");
    return {
      title: resolveArtifactTitle(entryHtml, absPath, titleOverride),
      source_path: absPath,
      kind: "bundle",
      files,
      entryHtmlPath: path.join(absPath, entry.entry),
    };
  }
  const content = fs.readFileSync(absPath, "utf-8");
  if (isMarkdownPath(absPath)) {
    return {
      title: resolveMarkdownTitle(content, absPath, titleOverride),
      source_path: absPath,
      kind: "markdown",
      content,
    };
  }
  if (!isHtmlPath(absPath)) {
    const hint = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(absPath)
      ? ` (for an inline-shareable image link, use \`cast image ${path.basename(absPath)}\`)`
      : "";
    throw new Error(`Can't publish ${path.basename(absPath)} — publish an .html or .md file, or a directory bundle${hint}`);
  }
  return {
    title: resolveArtifactTitle(content, absPath, titleOverride),
    source_path: absPath,
    content,
    entryHtmlPath: absPath,
  };
}

// ── output ───────────────────────────────────────────────────────────────────

function versionLine(result: { version: number; updated?: boolean; unchanged?: boolean }): string {
  if (result.unchanged) return fmt.muted(`unchanged (v${result.version})`);
  return `${fmt.number(`v${result.version}`)} ${icons.arrow} ${result.updated ? "updated" : "published"}`;
}

function printPublishResult(
  result: { url: string; version: number; updated?: boolean; unchanged?: boolean; manage_url?: string; edit_url?: string | null },
  title: string,
  access?: Record<string, unknown>,
): void {
  console.log(`${fmt.success(icons.check)} ${fmt.highlight(title)}  ${versionLine(result)}`);
  console.log(`  ${fmt.accent(result.url)}`);
  if (result.manage_url && result.manage_url !== result.url) {
    console.log(`  ${fmt.label("manage (owner link — keep private):")} ${result.manage_url}`);
  }
  if (result.edit_url) {
    console.log(`  ${fmt.label("edit:")} ${result.edit_url}`);
  }
  if (access) {
    console.log(`  ${fmt.label("gates:")} ${describeAccess(access)}`);
  }
}

// ── option → flag mapping ────────────────────────────────────────────────────

function accessFromOptions(options: {
  password?: string | boolean;
  passwordValue?: string;
  passwordStdin?: boolean;
  emailGate?: boolean;
  expires?: string;
  editMode?: string;
  session?: boolean;
  comments?: boolean;
}): Record<string, unknown> | undefined {
  const flags: AccessFlagValues = {};
  // commander: undefined = untouched, string = --password P, false = --no-password.
  // passwordValue (from --password-stdin) wins: it never touches argv.
  if (options.passwordValue !== undefined) flags.password = options.passwordValue;
  else if (options.password !== undefined) flags.password = options.password as string | false;
  if (options.emailGate !== undefined) flags.emailGate = options.emailGate;
  if (options.expires !== undefined) {
    const parsed = parseExpires(options.expires);
    if ("error" in parsed) {
      console.error(fmt.error(parsed.error));
      process.exit(1);
    }
    flags.expiresMs = parsed.ms;
  }
  if (options.editMode !== undefined) flags.editMode = options.editMode;
  if (options.session !== undefined) flags.session = options.session;
  if (options.comments !== undefined) flags.comments = options.comments;
  const built = buildAccessPayload(flags);
  if (built.error) {
    console.error(fmt.error(built.error));
    process.exit(1);
  }
  return built.payload;
}

// ── subcommand actions ───────────────────────────────────────────────────────

async function runLs(deps: PublishDeps, json: boolean): Promise<void> {
  const result = await apiPost(deps, "/cli/artifacts/list", {}, { read: true });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const rows: ArtifactLsRow[] = result.artifacts ?? [];
  for (const line of formatArtifactTable(rows)) console.log(line);
}

async function runRm(deps: PublishDeps, target: string, json: boolean): Promise<void> {
  const abs = fs.existsSync(target) ? path.resolve(target) : target;
  const result = await apiPost(deps, "/cli/artifacts/delete", { target: abs });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const deleted = result.deleted;
  console.log(`${fmt.success(icons.check)} Unpublished ${fmt.highlight(deleted?.title ?? target)} ${fmt.muted(`(${deleted?.slug ?? target})`)}`);
}

async function runRollback(deps: PublishDeps, target: string, versionArg: string, json: boolean): Promise<void> {
  const version = parseInt(versionArg, 10);
  if (!Number.isFinite(version) || version < 1) {
    console.error(fmt.error(`Invalid version "${versionArg}" — pass the version number to restore, e.g. 3`));
    process.exit(1);
  }
  const abs = fs.existsSync(target) ? path.resolve(target) : target;
  const result = await apiPost(deps, "/cli/artifacts/rollback", { target: abs, version });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${fmt.success(icons.check)} Rolled back to v${version} — now ${fmt.number(`v${result.version}`)}`);
  console.log(`  ${fmt.accent(result.url)}`);
}

async function runOpen(deps: PublishDeps, target: string, json: boolean): Promise<void> {
  const result = await apiPost(deps, "/cli/artifacts/list", {}, { read: true });
  const rows: ArtifactLsRow[] = result.artifacts ?? [];
  const abs = fs.existsSync(target) ? path.resolve(target) : null;
  const suffix = target.startsWith("/") ? target : `/${target}`;
  const row = rows.find(
    (r: any) => r.slug === target || r.source_path === abs || r.source_path === target || r.source_path?.endsWith(suffix),
  );
  if (!row) {
    console.error(fmt.error(`No published page matches "${target}" — see cast publish ls`));
    process.exit(1);
  }
  if (json) {
    console.log(JSON.stringify(row, null, 2));
    return;
  }
  console.log(row.url);
  await open(row.url).catch(() => {});
}

// ── owner management (no republish needed) ───────────────────────────────────
//
// The manage endpoint authenticates with the artifact's owner_key rather than
// an api_token, because it is also called from the published page itself. The
// CLI holds an api_token, so it resolves the row through the authed list
// endpoint first and reads the owner_key out of the manage_url fragment — the
// same secret, obtained the authorized way. Nothing here needs an extra
// backend surface.

/** Find one of the caller's artifacts by slug, absolute path, or path suffix. */
async function resolveRow(deps: PublishDeps, target: string): Promise<ArtifactLsRow> {
  const result = await apiPost(deps, "/cli/artifacts/list", {}, { read: true });
  const rows: ArtifactLsRow[] = result.artifacts ?? [];
  const abs = fs.existsSync(target) ? path.resolve(target) : null;
  const suffix = target.startsWith("/") ? target : `/${target}`;
  const matches = rows.filter(
    (r: any) => r.slug === target || r.source_path === abs || r.source_path === target || r.source_path?.endsWith(suffix),
  );
  if (matches.length > 1) {
    console.error(fmt.error(`"${target}" matches ${matches.length} published pages — use a slug:`));
    for (const m of matches) console.error(`  ${m.slug}  ${m.title}`);
    process.exit(1);
  }
  if (!matches.length) {
    console.error(fmt.error(`No published page matches "${target}" — see cast publish ls`));
    process.exit(1);
  }
  return matches[0];
}

function ownerKeyOf(row: ArtifactLsRow): string {
  const key = (row as any).manage_url?.split("#o=")[1];
  if (!key) {
    console.error(fmt.error(`No owner key for ${row.slug} — it may predate managed pages. Republish to mint one.`));
    process.exit(1);
  }
  return key;
}

async function callManage(deps: PublishDeps, row: ArtifactLsRow, payload: Record<string, unknown>): Promise<any> {
  return await apiPost(deps, "/cli/artifacts/manage", { slug: row.slug, owner_key: ownerKeyOf(row), ...payload });
}

/** formatAgeShort takes a duration, not a timestamp — this is the "how long
 * ago was this" wrapper the management views want. */
function ago(timestamp: number | null | undefined): string {
  if (!timestamp) return "—";
  return formatAgeShort(Math.max(0, Date.now() - timestamp));
}

function describeGates(access: any): string {
  const bits: string[] = [];
  bits.push(access.has_password ? "password on" : "no password");
  if (access.email_gate) bits.push("email gate on");
  if (access.expires_at) {
    const when = access.expires_at < Date.now() ? "EXPIRED" : `expires ${new Date(access.expires_at).toLocaleString()}`;
    bits.push(when);
  }
  bits.push(`edit: ${access.edit_mode ?? "owner"}`);
  if (access.show_session === false) bits.push("session link hidden");
  if (access.comments_enabled === false) bits.push("comments off");
  return bits.join(" · ");
}

/** Change access/title on an EXISTING artifact without republishing content —
 * the agent-facing counterpart of the in-page manage sheet. */
async function runSet(deps: PublishDeps, target: string, options: PublishOptions & { editMode?: string }, json: boolean): Promise<void> {
  const row = await resolveRow(deps, target);
  const set: Record<string, unknown> = {};
  if (options.passwordValue !== undefined) set.password = options.passwordValue;
  else if (options.password !== undefined) set.password = options.password === false ? null : options.password;
  if (options.emailGate !== undefined) set.email_gate = options.emailGate;
  if (options.editMode !== undefined) set.edit_mode = options.editMode;
  if (options.session !== undefined) set.show_session = options.session;
  if (options.comments !== undefined) set.comments = options.comments;
  if (options.title !== undefined) set.title = options.title;
  if (options.expires !== undefined) {
    const parsed = parseExpires(options.expires);
    if ("error" in parsed) {
      console.error(fmt.error(parsed.error));
      process.exit(1);
    }
    set.expires_in_ms = parsed.ms;
  }
  if (!Object.keys(set).length) {
    console.error(fmt.error("Nothing to set — pass e.g. --password X, --no-password, --email-gate, --expires 7d, --edit-mode team, --no-session, --title T"));
    process.exit(1);
  }
  const result = await callManage(deps, row, { set });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${fmt.success(icons.check)} Updated ${fmt.highlight(row.title)} ${fmt.muted(`(${row.slug})`)}`);
  console.log(`  ${fmt.label("access:")} ${describeGates(result.access ?? {})}`);
  if (result.edit_url) console.log(`  ${fmt.label("edit link (shareable):")} ${result.edit_url}`);
}

async function runVersions(deps: PublishDeps, target: string, json: boolean): Promise<void> {
  const row = await resolveRow(deps, target);
  const result = await callManage(deps, row, {});
  if (json) {
    console.log(JSON.stringify(result.versions ?? [], null, 2));
    return;
  }
  const versions: any[] = result.versions ?? [];
  if (!versions.length) {
    console.log(fmt.muted("No version history yet."));
    return;
  }
  console.log(`${fmt.highlight(row.title)} ${fmt.muted(`(${row.slug})`)}`);
  for (const v of versions) {
    const mark = v.current ? fmt.success(" ← current") : "";
    const who = v.edited_by ? fmt.muted(` by ${v.edited_by}`) : "";
    console.log(`  ${fmt.number(`v${v.version}`)}  ${ago(v.published_at).padStart(4)}  ${formatBytes(v.size).padStart(7)}${who}${mark}`);
  }
  console.log(fmt.muted(`  restore: cast publish rollback ${row.slug} <n>`));
  console.log(fmt.muted(`  compare: ${row.url}?diff=<a>..<b>`));
}

async function runComments(
  deps: PublishDeps,
  target: string,
  opts: { resolveId?: string; resolveAll?: boolean; json: boolean },
): Promise<void> {
  const row = await resolveRow(deps, target);
  if (opts.resolveAll) {
    let panel = await callManage(deps, row, {});
    const open_ = (panel.comments ?? []).filter((c: any) => c.status === "open");
    for (const c of open_) panel = await callManage(deps, row, { resolve_comment_id: c.id });
    if (!opts.json) console.log(`${fmt.success(icons.check)} Resolved ${open_.length} comment${open_.length === 1 ? "" : "s"}`);
    if (opts.json) console.log(JSON.stringify(panel.comments ?? [], null, 2));
    return;
  }
  const result = opts.resolveId
    ? await callManage(deps, row, { resolve_comment_id: opts.resolveId })
    : await callManage(deps, row, {});
  const comments: any[] = result.comments ?? [];
  if (opts.json) {
    console.log(JSON.stringify(comments, null, 2));
    return;
  }
  if (opts.resolveId) console.log(`${fmt.success(icons.check)} Resolved ${opts.resolveId}`);
  const open_ = comments.filter((c) => c.status === "open");
  if (!open_.length) {
    console.log(fmt.muted("No open comments."));
    return;
  }
  console.log(`${fmt.highlight(row.title)} ${fmt.muted(`(${row.slug})`)} — ${open_.length} open`);
  for (const c of open_) {
    const who = c.author_email ? `${c.author_name} <${c.author_email}>` : c.author_name;
    console.log(`  ${fmt.accent(c.id)}  ${fmt.muted(`${who} · v${c.version} · ${ago(c.created_at)}`)}`);
    for (const line of String(c.text).split("\n")) console.log(`    ${line}`);
    if (c.anchor) {
      try {
        const snippet = JSON.parse(c.anchor)?.snippet;
        if (snippet) console.log(fmt.muted(`    ↳ on: "${String(snippet).slice(0, 100)}"`));
      } catch {
        /* opaque anchor */
      }
    }
  }
  console.log(fmt.muted(`  resolve: cast publish comments ${row.slug} --resolve <id>  |  --resolve-all`));
}

async function runViewers(deps: PublishDeps, target: string, json: boolean): Promise<void> {
  const row = await resolveRow(deps, target);
  const result = await callManage(deps, row, {});
  const viewers: any[] = result.viewers ?? [];
  if (json) {
    console.log(JSON.stringify({ stats: result.stats, viewers }, null, 2));
    return;
  }
  const stats = result.stats ?? {};
  console.log(`${fmt.highlight(row.title)} ${fmt.muted(`(${row.slug})`)}`);
  console.log(`  ${fmt.label("views:")} ${stats.views ?? 0}${stats.last_viewed_at ? fmt.muted(` · last ${ago(stats.last_viewed_at)}`) : ""}`);
  if (!viewers.length) {
    console.log(fmt.muted("  No identified viewers (email gate off, or nobody has entered an address)."));
    return;
  }
  for (const v of viewers) {
    console.log(`  ${v.email.padEnd(32)} ${fmt.muted(`${v.view_count}x · first ${ago(v.first_seen)} · last ${ago(v.last_seen)}`)}`);
  }
}

async function runLinks(deps: PublishDeps, target: string, json: boolean): Promise<void> {
  const row = await resolveRow(deps, target);
  if (json) {
    console.log(JSON.stringify(row, null, 2));
    return;
  }
  console.log(`${fmt.label("share:")}  ${row.url}`);
  console.log(`${fmt.label("manage:")} ${(row as any).manage_url} ${fmt.muted("(owner link — keep private)")}`);
  if ((row as any).edit_url) console.log(`${fmt.label("edit:")}   ${(row as any).edit_url} ${fmt.muted("(anyone with this can publish versions)")}`);
  console.log(`${fmt.label("source:")} ${row.url}?src=1`);
  console.log(`${fmt.label("live:")}   ${row.url}?live=1 ${fmt.muted("(auto-reloads on new versions)")}`);
}

// ── publish + watch ──────────────────────────────────────────────────────────

interface PublishOptions {
  title?: string;
  new?: boolean;
  json?: boolean;
  watch?: boolean;
  password?: string | boolean;
  passwordValue?: string;
  emailGate?: boolean;
  expires?: string;
  editMode?: string;
  session?: boolean;
  comments?: boolean;
  thumb?: boolean;
  open?: boolean;
}

async function publishOnce(
  deps: PublishDeps,
  absPath: string,
  options: PublishOptions,
  extra: { access?: Record<string, unknown>; sessionRef?: string; withThumb: boolean; forceNew: boolean; exitOnError: boolean },
): Promise<{ result: any; title: string }> {
  const payload = buildPublishPayload(absPath, options.title);
  let thumbB64: string | undefined;
  if (extra.withThumb && options.thumb !== false && payload.entryHtmlPath) {
    thumbB64 = captureThumb(payload.entryHtmlPath) ?? undefined;
  }
  const result = await apiPost(
    deps,
    "/cli/artifacts/publish",
    {
      title: payload.title,
      source_path: payload.source_path,
      ...(payload.kind ? { kind: payload.kind } : {}),
      ...(payload.content !== undefined ? { content: payload.content } : {}),
      ...(payload.files ? { files: payload.files } : {}),
      ...(extra.forceNew ? { force_new: true } : {}),
      ...(extra.access ? { access: extra.access } : {}),
      ...(extra.sessionRef ? { session_ref: extra.sessionRef } : {}),
      ...(thumbB64 ? { thumb_b64: thumbB64 } : {}),
    },
    { exitOnError: extra.exitOnError },
  );
  return { result, title: payload.title };
}

async function runPublish(deps: PublishDeps, target: string, options: PublishOptions): Promise<void> {
  const absPath = path.resolve(target);
  if (!fs.existsSync(absPath)) {
    console.error(fmt.error(`No such file or directory: ${target}`));
    process.exit(1);
  }
  const access = accessFromOptions(options);
  const sessionRef = deps.detectCurrentSessionId() ?? undefined;

  let result: any;
  let title: string;
  try {
    ({ result, title } = await publishOnce(deps, absPath, options, {
      access,
      sessionRef,
      withThumb: true,
      forceNew: !!options.new,
      exitOnError: false,
    }));
  } catch (err) {
    console.error(fmt.error(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printPublishResult(result, title, access);
  }
  if (options.open && result?.url) await open(result.url).catch(() => {});
  if (!options.watch) return;

  // ── watch loop: debounce fs events, republish, print version bumps ────────
  console.log(fmt.muted(`\nwatching ${target} — Ctrl+C to stop`));
  console.log(fmt.muted(`live view: ${result.url}?live=1`));

  const isDir = fs.statSync(absPath).isDirectory();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let publishing = false;
  let dirty = false;

  const republish = async () => {
    if (publishing) {
      dirty = true;
      return;
    }
    publishing = true;
    try {
      // Access flags applied on the first publish; watch republishes content only.
      // Thumbnails are also first-publish-only so the loop stays fast.
      const { result: r } = await publishOnce(deps, absPath, options, {
        sessionRef,
        withThumb: false,
        forceNew: false,
        exitOnError: false,
      });
      console.log(`  ${new Date().toLocaleTimeString()}  ${versionLine(r)}`);
    } catch (err) {
      console.error(`  ${fmt.error(err instanceof Error ? err.message : String(err))}`);
    } finally {
      publishing = false;
      if (dirty) {
        dirty = false;
        void republish();
      }
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void republish(), WATCH_DEBOUNCE_MS);
  };

  // Watch the parent dir for single files (editors rename-replace on save,
  // which kills a direct file watch); recursive watch for bundles.
  const watcher = isDir
    ? fs.watch(absPath, { recursive: true }, () => schedule())
    : fs.watch(path.dirname(absPath), (_event, filename) => {
        if (!filename || filename === path.basename(absPath)) schedule();
      });

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      watcher.close();
      console.log(fmt.muted("\nstopped"));
      resolve();
    });
  });
}

// ── registration ─────────────────────────────────────────────────────────────

export function registerPublishCommand(program: Command, deps: PublishDeps): void {
  program
    .command("publish")
    .description(
      "Publish an HTML/markdown file or a directory bundle to a shareable codecast.sh/a/<slug> URL\n\n" +
        "Re-publishing the same path updates the same URL (version history kept).\n\n" +
        "Subcommands:\n" +
        "  cast publish ls                          List your published pages\n" +
        "  cast publish rm <slug|path>              Unpublish\n" +
        "  cast publish rollback <slug|path> <n>    Restore version n as a new version\n" +
        "  cast publish open <slug|path>            Print + open the share URL\n" +
        "  cast publish versions <slug|path>        Version history (+ rollback/diff hints)\n" +
        "  cast publish comments <slug|path>        Read viewer comments; --resolve <id> | --resolve-all\n" +
        "  cast publish viewers <slug|path>         View count + who opened it (email gate)\n" +
        "  cast publish links <slug|path>           share / manage / edit / source / live URLs\n" +
        "  cast publish set <slug|path> [flags]     Change gates or title WITHOUT republishing",
    )
    .argument("[target]", "file.html, file.md, or a directory — or a subcommand: ls | rm | rollback | open | versions | comments | viewers | links | set")
    .argument("[args...]", "subcommand arguments")
    .option("--title <title>", stdinText("Override the page title (default: <title> tag / first heading / filename)"))
    .option("--new", "Publish under a fresh URL even if this path was published before")
    .option("--json", "Emit the raw JSON response")
    .option("--watch", "Keep watching the file/directory and republish on change")
    .option("--password <password>", "Require a password to view (visible in ps — prefer --password-stdin)")
    .option("--password-stdin", "Read the view password from stdin (keeps it out of the process list)")
    .option("--no-password", "Clear the password gate")
    .option("--email-gate", "Require an email address to view")
    .option("--no-email-gate", "Clear the email gate")
    .option("--expires <duration>", "Expire the link after e.g. 30m, 24h, 7d — or never")
    .option("--edit-mode <mode>", "Who can edit in the browser: owner | link | team")
    .option("--session", "Show the link to the publishing session on the page (default)")
    .option("--no-session", "Hide the publishing-session link from the page")
    .option("--comments", "Let viewers discuss the page (default)")
    .option("--no-comments", "Turn off the viewer discussion")
    .option("--no-thumb", "Skip the headless-Chrome thumbnail screenshot")
    .option("--open", "Open the published URL in the browser")
    .option("--resolve <id>", "comments: mark one comment resolved")
    .option("--resolve-all", "comments: mark every open comment resolved")
    .action(async (target: string | undefined, args: string[], options: PublishOptions) => {
      const json = !!options.json;
      if (!target) {
        console.error(fmt.error("Usage: cast publish <file.html|file.md|dir> — or: ls | rm <target> | rollback <target> <version> | open <target>"));
        process.exit(1);
      }
      if (target === "ls") return runLs(deps, json);
      if (target === "rm") {
        if (!args[0]) {
          console.error(fmt.error("Usage: cast publish rm <slug|path>"));
          process.exit(1);
        }
        return runRm(deps, args[0], json);
      }
      if (target === "rollback") {
        if (!args[0] || !args[1]) {
          console.error(fmt.error("Usage: cast publish rollback <slug|path> <version>"));
          process.exit(1);
        }
        return runRollback(deps, args[0], args[1], json);
      }
      // Management subcommands. Each is shadowed by a real file/dir of the
      // same name, so `cast publish set` still publishes ./set if it exists.
      const MANAGEMENT = ["versions", "comments", "viewers", "links", "set"];
      if (MANAGEMENT.includes(target) && !fs.existsSync(target)) {
        if (!args[0]) {
          console.error(fmt.error(`Usage: cast publish ${target} <slug|path>`));
          process.exit(1);
        }
        const sub = args[0];
        if (target === "versions") return runVersions(deps, sub, json);
        if (target === "viewers") return runViewers(deps, sub, json);
        if (target === "links") return runLinks(deps, sub, json);
        if (target === "comments") {
          const o = options as PublishOptions & { resolve?: string; resolveAll?: boolean };
          return runComments(deps, sub, { resolveId: o.resolve, resolveAll: !!o.resolveAll, json });
        }
        return runSet(deps, sub, options, json);
      }
      if (target === "open" && !fs.existsSync(target)) {
        if (!args[0]) {
          console.error(fmt.error("Usage: cast publish open <slug|path>"));
          process.exit(1);
        }
        return runOpen(deps, args[0], json);
      }
      // --password-stdin keeps the secret out of argv (and out of `ps`).
      if ((options as { passwordStdin?: boolean }).passwordStdin) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
        if (!value) {
          console.error(fmt.error("--password-stdin was set but stdin was empty"));
          process.exit(1);
        }
        options.passwordValue = value;
      }
      return runPublish(deps, target, options);
    });
}
