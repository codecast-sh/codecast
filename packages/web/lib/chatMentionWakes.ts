// The one line a sender hears after a chat send names a role or a session:
// "woke @infra-lead · delivered to jx7c6zk" (docs/architecture/agent-channels.md
// C2/C4). Pure, so the sentence is testable without the toast layer.
//
// The server answers with COUNTS and the reasons it skipped something
// (`mention_wakes`), not with names. The names come from what was typed:
// every @handle in the line that is a known role, every 7-char jx id, minus
// the ones the server said it skipped. When the counts and the typed names
// disagree (the server resolved something this client could not), the line
// falls back to the count, which is always true.

import { SESSION_SHORT_ID_RE } from "@codecast/shared/chat";

export type MentionWakes = { roles: number; sessions: number; folded: number; skipped: string[] };

// Same vocabulary and boundary as lib/remarkChatMentions and the server.
const HANDLE_RE = /(^|[\s(<[{,:;"'*~])@([A-Za-z0-9][A-Za-z0-9_-]{0,38})/g;

export function typedHandles(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(HANDLE_RE)) {
    const h = m[2].toLowerCase();
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

/** The skipped targets by handle or short id, whatever the reason. */
function skippedTargets(skipped: string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const s of skipped ?? []) {
    const i = s.indexOf(":");
    if (i > 0) out.add(s.slice(i + 1).toLowerCase());
  }
  return out;
}

function list(items: string[]): string {
  return items.join(", ");
}

/** The toast line, or null when nothing was woken and nothing folded. */
export function mentionWakeLine(
  content: string,
  wakes: MentionWakes | undefined,
  roleHandles: Set<string>,
): string | null {
  if (!wakes) return null;
  const { roles = 0, sessions = 0, folded = 0 } = wakes;
  if (roles <= 0 && sessions <= 0 && folded <= 0) return null;
  const skipped = skippedTargets(wakes.skipped);
  const typed = typedHandles(content);
  const wokeRoles = typed.filter((h) => roleHandles.has(h) && !skipped.has(h));
  const wokeSessions = typed.filter((h) => SESSION_SHORT_ID_RE.test(h) && !skipped.has(h));
  const parts: string[] = [];
  if (roles > 0) {
    parts.push(
      wokeRoles.length === roles
        ? `woke ${list(wokeRoles.map((h) => `@${h}`))}`
        : `woke ${roles} role${roles === 1 ? "" : "s"}`,
    );
  }
  if (sessions > 0) {
    parts.push(
      wokeSessions.length === sessions
        ? `delivered to ${list(wokeSessions)}`
        : `delivered to ${sessions} session${sessions === 1 ? "" : "s"}`,
    );
  }
  if (folded > 0) parts.push(`${folded} folded (over the hourly cap)`);
  return parts.join(" · ");
}
