// Pure helpers for `cast publish` — split from index.ts so they're testable
// (index.ts runs program.parse() on import). The command action itself lives in
// index.ts alongside the other commands; it delegates the non-IO logic here.

import * as path from "path";

/** Server-enforced too — keep in sync with /cli/artifacts/publish in convex/http.ts. */
export const PUBLISH_MAX_BYTES = 8 * 1024 * 1024;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

/** The document's <title> text, or null when absent/empty. */
export function extractHtmlTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  const title = match[1]
    .replace(/&(?:amp|lt|gt|quot|#39|apos);/g, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, " ")
    .trim();
  return title ? title.slice(0, 200) : null;
}

/** Explicit override, else the <title> tag, else the filename without extension. */
export function resolveArtifactTitle(html: string, filePath: string, override?: string): string {
  const fromFlag = override?.trim();
  if (fromFlag) return fromFlag.slice(0, 200);
  return extractHtmlTitle(html) ?? path.basename(filePath).replace(/\.html?$/i, "");
}

export function isHtmlPath(filePath: string): boolean {
  return /\.html?$/i.test(filePath);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function isMarkdownPath(filePath: string): boolean {
  return /\.(md|markdown)$/i.test(filePath);
}

/** Explicit override, else the first ATX heading, else the filename without extension. */
export function resolveMarkdownTitle(md: string, filePath: string, override?: string): string {
  const fromFlag = override?.trim();
  if (fromFlag) return fromFlag.slice(0, 200);
  const heading = md.match(/^#{1,3}\s+(.+?)\s*#*\s*$/m);
  if (heading) {
    const text = heading[1].replace(/[*_`]/g, "").trim();
    if (text) return text.slice(0, 200);
  }
  return path.basename(filePath).replace(/\.(md|markdown)$/i, "");
}

// ── --expires parsing ────────────────────────────────────────────────────────

/** "7d" | "24h" | "30m" | "2w" → ms; "never" → null (clear). Invalid → {error}. */
export function parseExpires(input: string): { ms: number | null } | { error: string } {
  const t = input.trim().toLowerCase();
  if (t === "never") return { ms: null };
  const m = t.match(/^(\d+)\s*(m|min|h|hr|d|w)$/);
  const n = m ? parseInt(m[1], 10) : 0;
  if (!m || n <= 0) {
    return { error: `Invalid --expires "${input}" — use a duration like 30m, 24h, 7d, or "never"` };
  }
  const per: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };
  return { ms: n * per[m[2][0]] };
}

// ── flag → access payload mapping ────────────────────────────────────────────

export const EDIT_MODES = ["owner", "link", "team"] as const;

export interface AccessFlagValues {
  /** string = set, false = --no-password (clear), undefined = untouched. */
  password?: string | false;
  /** true/false only when the flag was passed explicitly. */
  emailGate?: boolean;
  /** number = expire after ms, null = never (clear), undefined = untouched. */
  expiresMs?: number | null;
  editMode?: string;
}

/**
 * The `access` object POSTed to /cli/artifacts/publish and /manage — only the
 * fields the user explicitly set, so untouched gates keep their server state.
 * Returns undefined when no access flag was passed at all.
 */
export function buildAccessPayload(
  flags: AccessFlagValues,
): { payload?: Record<string, unknown>; error?: string } {
  const access: Record<string, unknown> = {};
  if (flags.password !== undefined) access.password = flags.password === false ? null : flags.password;
  if (flags.emailGate !== undefined) access.email_gate = flags.emailGate;
  if (flags.expiresMs !== undefined) access.expires_in_ms = flags.expiresMs;
  if (flags.editMode !== undefined) {
    if (!(EDIT_MODES as readonly string[]).includes(flags.editMode)) {
      return { error: `Invalid --edit-mode "${flags.editMode}" — use owner, link, or team` };
    }
    access.edit_mode = flags.editMode;
  }
  return Object.keys(access).length ? { payload: access } : {};
}

/** One-line summary of the gates a publish just set, for the human output. */
export function describeAccess(access: Record<string, unknown>): string {
  const parts: string[] = [];
  if ("password" in access) parts.push(access.password === null ? "password cleared" : "password");
  if ("email_gate" in access) parts.push(access.email_gate ? "email gate" : "email gate off");
  if ("expires_in_ms" in access) {
    parts.push(access.expires_in_ms === null ? "never expires" : `expires in ${formatDuration(access.expires_in_ms as number)}`);
  }
  if ("edit_mode" in access) parts.push(`edit: ${access.edit_mode}`);
  return parts.join(" · ");
}

export function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

// ── bundle (directory) publishing ────────────────────────────────────────────

/** Skip rule for bundle uploads: dotfiles/dot-dirs, node_modules, sourcemaps. */
export function isSkippedBundlePath(relPath: string): boolean {
  const parts = relPath.split("/");
  if (parts.some((p) => p.startsWith("."))) return true;
  if (parts.includes("node_modules")) return true;
  if (/\.map$/i.test(relPath)) return true;
  return false;
}

export function filterBundlePaths(relPaths: string[]): string[] {
  return relPaths.filter((p) => !isSkippedBundlePath(p)).sort();
}

/** index.html wins; else exactly one .html; else a legible error. */
export function pickBundleEntry(relPaths: string[]): { entry?: string; error?: string } {
  const htmls = relPaths.filter((p) => /\.html?$/i.test(p));
  if (htmls.includes("index.html")) return { entry: "index.html" };
  if (htmls.length === 1) return { entry: htmls[0] };
  if (htmls.length === 0) return { error: "Directory has no .html file — a bundle needs an index.html (or exactly one .html) entry page" };
  return {
    error: `Directory has ${htmls.length} .html files and no index.html — add an index.html entry page (found: ${htmls.slice(0, 5).join(", ")})`,
  };
}

/** Total-size cap check; over the cap → an error naming the biggest files. */
export function bundleSizeError(
  files: Array<{ path: string; size: number }>,
  maxBytes: number = PUBLISH_MAX_BYTES,
): string | null {
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total <= maxBytes) return null;
  const biggest = [...files].sort((a, b) => b.size - a.size).slice(0, 5);
  const listing = biggest.map((f) => `  ${formatBytes(f.size).padStart(8)}  ${f.path}`).join("\n");
  return `Bundle is ${formatBytes(total)} — the limit is ${formatBytes(maxBytes)} total. Biggest files:\n${listing}`;
}

// ── `cast publish ls` table ──────────────────────────────────────────────────

export interface ArtifactLsRow {
  slug: string;
  title: string;
  version: number;
  kind?: string;
  views?: number;
  comments_open?: number;
  has_password?: boolean;
  email_gate?: boolean;
  expires_at?: number | null;
  edit_mode?: string;
  session_short_id?: string | null;
  updated_at: number;
  url: string;
}

/** Non-emoji glyphs: lock=password, mail=email gate, clock=expiry, pencil=editable. */
export function gateGlyphs(row: ArtifactLsRow): string {
  const g: string[] = [];
  if (row.has_password) g.push("⚿");
  if (row.email_gate) g.push("✉");
  if (row.expires_at) g.push("◷");
  if (row.edit_mode && row.edit_mode !== "owner") g.push("✎");
  return g.join("");
}

export function formatAgeShort(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/** Plain-text table for `cast publish ls` (no ANSI — callers may colorize). */
export function formatArtifactTable(rows: ArtifactLsRow[], now: number = Date.now()): string[] {
  if (!rows.length) return ["No published artifacts. Publish one with: cast publish <file.html>"];
  const cells = rows.map((r) => [
    r.slug,
    truncate(r.title, 32),
    `v${r.version}`,
    r.kind ?? "html",
    String(r.views ?? 0),
    r.comments_open ? String(r.comments_open) : "-",
    gateGlyphs(r) || "-",
    r.session_short_id ?? "-",
    formatAgeShort(Math.max(0, now - r.updated_at)),
    r.url,
  ]);
  const header = ["SLUG", "TITLE", "VER", "KIND", "VIEWS", "CMTS", "GATES", "SESSION", "AGE", "URL"];
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((row) => row[i].length)));
  const render = (row: string[]) =>
    row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join("  ");
  return [render(header), ...cells.map(render)];
}
