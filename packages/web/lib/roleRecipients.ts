// A role as something a request can be sent to from the new session composer
// (docs/architecture/org-roles-standing.md T6): the role's one line (face,
// name, title, area), who it answers to, and the standing session that takes
// the request. Reads the roles the org tree already holds; the identity words
// come from the one reader every surface uses (shared/contracts/orgIdentity).
import { roleIdentity } from "@codecast/shared/contracts/orgIdentity";
import type { OrgRole } from "../components/org/orgTypes";
import type { OptimisticImage } from "../store/inboxStore";

export type RoleRecipient = {
  role: OrgRole;
  /** The person like name ("Ada"). */
  name: string;
  /** The role, with an assistant's reach ("Head of Growth", "Executive Assistant, global"). */
  title: string;
  /** What it looks after, as the scope names it: projects then plans, comma joined. */
  area: string;
  handle: string;
  /** Reports to the viewer directly: listed first and read as their own. */
  mine: boolean;
  /** The standing session the request lands in; absent while the seat was never provisioned. */
  standingId: string | null;
};

/** The scope's names in one phrase, projects first: "Growth, SEO and AI citations". */
export function roleArea(role: Pick<OrgRole, "scope_names">): string {
  const names = role.scope_names;
  if (!names) return "";
  return [...names.projects.map((p) => p.title), ...names.plans.map((p) => p.title || p.short_id)].filter(Boolean).join(", ");
}

/** Every role a request can go to, the viewer's own first, each group by name.
 *  Retired roles are out; a paused or unprovisioned seat stays listed so the
 *  picker can say why it cannot take the request. */
export function roleRecipients(roles: readonly OrgRole[], viewerId: string | null | undefined, opts: { teamName?: string | null } = {}): RoleRecipient[] {
  const out: RoleRecipient[] = [];
  for (const role of roles) {
    if (role.status === "retired") continue;
    const id = roleIdentity(role, { teamName: opts.teamName ?? null });
    out.push({
      role,
      name: id.name,
      title: id.subtitle,
      area: roleArea(role),
      handle: role.handle,
      mine: !!viewerId && role.reports_to.kind === "user" && role.reports_to.user_id === viewerId,
      standingId: role.standing?.conversation_id ?? null,
    });
  }
  return out.sort((a, b) => (a.mine === b.mine ? a.name.localeCompare(b.name) : a.mine ? -1 : 1));
}

// How well a recipient answers a query: every typed word must start a word
// somewhere in its line (name, handle, title or area), or sit inside one. A
// word that opens the name or handle counts most, so typing "gr" lists Growth's
// seat above a role whose area merely mentions growth.
function matchScore(r: RoleRecipient, word: string): number {
  const fields: Array<[string, number]> = [[r.name, 4], [r.handle, 4], [r.title, 2], [r.area, 1]];
  let best = 0;
  for (const [text, weight] of fields) {
    const t = text.toLowerCase();
    if (!t.includes(word)) continue;
    const atWordStart = t.startsWith(word) || t.includes(` ${word}`) || t.includes(`-${word}`) || t.includes(`, ${word}`);
    best = Math.max(best, atWordStart ? weight * 2 : weight);
  }
  return best;
}

/** The recipients a query keeps, best match first within the viewer's own and
 *  then everyone else's; an empty query keeps the whole list in its order. */
export function filterRoleRecipients(list: readonly RoleRecipient[], query: string): RoleRecipient[] {
  const words = query.toLowerCase().split(/\s+/).map((w) => w.replace(/^@/, "")).filter(Boolean);
  if (words.length === 0) return [...list];
  const scored: Array<{ r: RoleRecipient; score: number }> = [];
  for (const r of list) {
    let score = 0;
    for (const w of words) {
      const s = matchScore(r, w);
      if (s === 0) { score = 0; break; }
      score += s;
    }
    if (score > 0) scored.push({ r, score });
  }
  return scored
    .sort((a, b) => (a.r.mine !== b.r.mine ? (a.r.mine ? -1 : 1) : b.score - a.score || a.r.name.localeCompare(b.r.name)))
    .map((x) => x.r);
}

export type GateImage = { storageId?: string; previewUrl: string; mime: string; uploading: boolean };
export type RoleSendStore = {
  orgTree: { roles: ReadonlyArray<Pick<OrgRole, "_id" | "standing">> } | null | undefined;
  addOptimisticMessage: (convId: string, content: string, images?: OptimisticImage[]) => string;
  sendMessage: (convId: string, content: string, imageIds?: string[], clientId?: string) => void;
};

/** The role path of a send: the request goes into the role's standing
 *  conversation exactly as the role page's Talk composer sends one (the same
 *  pending message `orgRoles.wake` enqueues), so the role learns who wrote and
 *  answers there with the session it started. The bubble paints at once with
 *  the previews; the send waits only for uploads still in flight. The standing
 *  id is re-read from the live tree, so a seat provisioned while the composer
 *  was open counts. Returns the conversation it went into, or null when the
 *  seat has no standing session. */
export async function sendRequestToRole(
  store: () => RoleSendStore,
  r: RoleRecipient,
  text: string,
  images: GateImage[],
  awaitUpload: (previewUrl: string) => Promise<string | null>,
): Promise<string | null> {
  const standingId = store().orgTree?.roles.find((x) => x._id === r.role._id)?.standing?.conversation_id ?? r.standingId;
  if (!standingId) return null;
  const optimistic: OptimisticImage[] = images.map((img) => img.storageId
    ? { media_type: img.mime, storage_id: img.storageId }
    : { media_type: img.mime, preview_url: img.previewUrl, uploading: true });
  const clientId = store().addOptimisticMessage(standingId, text, optimistic);
  const ids = (await Promise.all(images.map((img) => img.storageId ?? awaitUpload(img.previewUrl)))).filter((id): id is string => !!id);
  store().sendMessage(standingId, text, ids.length ? ids : undefined, clientId);
  return standingId;
}
