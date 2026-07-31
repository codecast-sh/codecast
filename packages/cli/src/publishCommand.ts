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
