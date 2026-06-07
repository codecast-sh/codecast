// Shared helpers for doc extraction (live path in messages.ts, backfill in taskMining.ts).

export type ExtractedDocType = "plan" | "design" | "spec" | "investigation" | "handoff" | "note";

export function classifyDocContent(content: string): ExtractedDocType {
  const first2k = content.slice(0, 2000).toLowerCase();
  if (/implementation\s+plan|## phases?\b|## milestones?\b|## timeline/i.test(first2k)) return "plan";
  if (/design\s+doc|architecture|## design|## approach|system\s+design/i.test(first2k)) return "design";
  if (/## spec|specification|## requirements|## api\b|## endpoints/i.test(first2k)) return "spec";
  if (/investigation|root\s+cause|## findings|## analysis|debugging|what.s happening/i.test(first2k)) return "investigation";
  if (/handoff|## status|## context|## next\s+steps|picking\s+up/i.test(first2k)) return "handoff";
  return "note";
}

const FRONTMATTER_RE = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

export function extractTitleFromContent(content: string): string {
  let body = content;
  // YAML frontmatter: prefer its title:/name: value; otherwise skip the block so
  // a raw "name: foo" line can't become the title.
  const fm = content.match(FRONTMATTER_RE);
  if (fm) {
    const field = fm[1].match(/^(?:title|name):[ \t]*["']?(.+?)["']?[ \t]*$/m);
    if (field?.[1]) return field[1].slice(0, 200);
    body = content.slice(fm[0].length);
  }
  const h1 = body.match(/^#\s+(.+)/m);
  if (h1) return h1[1].slice(0, 200);
  const h2 = body.match(/^##\s+(.+)/m);
  if (h2) return h2[1].slice(0, 200);
  const firstLine = body.split("\n").find((l) => l.trim().length > 10);
  if (firstLine) return firstLine.replace(/^[#*\->\s]+/, "").slice(0, 200);
  return "Untitled Document";
}

/** Stable dedup key for a doc extracted from inline assistant prose. Two rules:
 *  - No wall-clock values — re-syncing the same message must produce the same
 *    key or every daemon retry inserts another copy.
 *  - No conversation id — forking/resuming re-syncs the same transcript into a
 *    new conversation, and the same message must still map to ONE doc. Identity
 *    is (user, source message). */
export function inlineDocSourceKey(userId: string, msgTimestamp: number | undefined): string {
  return `inline://${userId}/${msgTimestamp ?? 0}`;
}
