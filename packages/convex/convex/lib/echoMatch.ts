// Pairing an agent's echoed user turn with the pending row that delivered it,
// and the images that echo carries (messages.ts writes the paired row).

import type { Id } from "../_generated/dataModel";
import { canonicalSlashCommand, stripPastedContent } from "@codecast/shared/contracts";
import { redactSecrets } from "../redact";
import { ATTACHMENT_FILE_RE } from "../sessionImages";

// Storage ids embedded in an injected-image echo. The daemon delivers an image
// as `[Image /tmp/codecast/images/<storageId>.png]` (downloadImage names the
// file by its Convex storage id), so the agent's echoed user turn carries the
// pending row's storage id verbatim.
export function injectedImageStorageIds(content: string): string[] {
  return injectedImageRefs(content).map((r) => r.storage_id);
}

const IMAGE_EXT_MEDIA_TYPE: Record<string, string> = {
  png: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
};

// Same paths as injectedImageStorageIds, as message `images` entries. The
// extension is how downloadImage recorded the object's content type, so it is
// the media type — hardcoding image/png mislabelled every webp and jpeg.
export function injectedImageRefs(
  content: string,
): Array<{ media_type: string; storage_id: string }> {
  const refs: Array<{ media_type: string; storage_id: string }> = [];
  const seen = new Set<string>();
  const re = new RegExp(ATTACHMENT_FILE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    refs.push({ media_type: IMAGE_EXT_MEDIA_TYPE[m[2].toLowerCase()] || "image/png", storage_id: m[1] });
  }
  return refs;
}

export function pendingImageStorageIds(
  pm: { image_storage_ids?: string[]; image_storage_id?: string },
): string[] {
  return pm.image_storage_ids ?? (pm.image_storage_id ? [pm.image_storage_id] : []);
}

// Images to store on an echoed user turn. Anything the sync already carried
// wins; otherwise the paired pending row's storage ids, whose media type comes
// from the extension the daemon wrote (hardcoding image/png mislabelled every
// webp and jpeg). Returns null when only the echo text is left to go on — the
// caller then has to verify those ids against storage before trusting them.
export function resolveEchoImages(
  existing: Array<{ media_type: string; storage_id?: string }> | undefined,
  pm: { image_storage_ids?: string[]; image_storage_id?: string } | undefined,
  echoContent: string,
): Array<{ media_type: string; storage_id?: string }> | undefined | null {
  if (existing && existing.length > 0) return existing;
  const pendingIds = pm ? pendingImageStorageIds(pm) : [];
  if (pendingIds.length === 0) return injectedImageRefs(echoContent).length > 0 ? null : existing;
  const refs = injectedImageRefs(echoContent);
  return pendingIds.map((id) => ({
    media_type: refs.find((r) => r.storage_id === id)?.media_type || "image/png",
    storage_id: id,
  }));
}

// Last resort when no pending row could be paired: the storage ids the echo
// itself names. A delivered image then still renders — the file is in storage,
// so the bubble should never come out blank just because the terminal mangled
// the prose the matcher compares.
//
// These ids are untrusted: the path is ordinary message text, so anyone can
// type one. An id that names no storage object fails schema validation on
// insert and takes the WHOLE message down with it, which is far worse than a
// missing thumbnail — so each candidate is resolved against storage first and
// silently dropped if it doesn't exist.
export async function verifiedEchoImages(
  ctx: { storage: { getUrl: (id: Id<"_storage">) => Promise<string | null> } },
  echoContent: string,
): Promise<Array<{ media_type: string; storage_id: Id<"_storage"> }>> {
  const kept: Array<{ media_type: string; storage_id: Id<"_storage"> }> = [];
  for (const ref of injectedImageRefs(echoContent)) {
    const id = ref.storage_id as Id<"_storage">;
    try {
      if (await ctx.storage.getUrl(id)) kept.push({ media_type: ref.media_type, storage_id: id });
    } catch {
      // Malformed id — not ours, ignore.
    }
  }
  return kept;
}

// Does this echoed user turn ack the given pending image row? Both contents are
// empty once `[Image …]` is stripped (an image-only send), so text can't match.
// Prefer the storage id carried in the echo path — a deterministic signal that
// holds no matter how long the session was busy before the inject. Fall back to
// the ±120s window only for echoes with no parseable path (older/non-daemon).
export function imageEchoMatchesPending(
  pm: { image_storage_ids?: string[]; image_storage_id?: string; created_at?: number },
  echoContent: string,
  msgTimestamp: number,
): boolean {
  const echoed = injectedImageStorageIds(echoContent);
  if (echoed.length > 0) {
    return pendingImageStorageIds(pm).some((id) => echoed.includes(id));
  }
  return Math.abs(msgTimestamp - (pm.created_at || 0)) < 120_000;
}

// Match an agent-echoed user message to the pending row it delivered. Echoes
// arrive in injection order, so candidates are tried in delivery order (oldest
// first) and only among rows still awaiting proof. Newest-first over all
// statuses cross-stamped identical-content sends: the echo of the OLDER
// delivery matched the NEWER command, stamping its client_id on the wrong
// transcript row and leaving the delivered command's overlay unreconcilable.
// "failed" rows are a second tier: a late echo proves a watchdog-failed row
// actually landed. delivered/cancelled/undeliverable never re-match.
// How far apart a status-ack "delivered" promotion and the transcript echo may
// land while still pairing up. updateAgentStatus terminalizes injected rows the
// moment the agent reports an active status — usually seconds before the echo
// syncs — which made the echo unmatchable and silently dropped everything the
// echo adopts from the pending row: sender attribution (from_user_id) on team
// sends, client_id (web pending-copy reconcile), and images. Delivered rows are
// a LAST-RESORT match tier: only rows not yet tied to an echo (echo_message_id
// unset) and delivered within this window qualify, so an identical later send
// can never be cross-stamped by an old delivered twin.
export const DELIVERED_ECHO_ADOPTION_WINDOW_MS = 30 * 60 * 1000;

// Control bytes the terminal leaks into an echoed turn. The daemon clears the
// client's composer with Ctrl+A / Ctrl+K before typing; when the input is not
// ready to consume them they land as literal SOH (\x01) and VT (\x0b) inside
// the text the agent echoes. They render as nothing, so the message looks fine
// while exact-text echo matching fails on it.
const ECHO_CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function findEchoedPendingMessage<
  T extends {
    _id: unknown;
    content: string;
    created_at?: number;
    status: string;
    delivered_at?: number;
    echo_message_id?: unknown;
    image_storage_ids?: string[];
    image_storage_id?: string;
  },
>(
  pendingMsgs: readonly T[],
  safeContent: string | undefined,
  msgTimestamp: number,
  consumed?: ReadonlySet<unknown>,
): T | undefined {
  // Claude Code 2.1.277+ wraps every bracketed paste in <pasted_content>, and
  // the daemon pastes every delivery, so the echo carries a wrapper the pending
  // row never had. Strip it on both sides (ct-52622: unmatched echoes left rows
  // "injected", and the tmux receipt then rewrote the same message on idle).
  const c = stripPastedContent(safeContent || "")
    .replace(/\[Image[:\s][^\]]*\]/gi, "")
    .replace(ECHO_CONTROL_CHARS_RE, "")
    .trim();
  const cFlat = c.replace(/\s+/g, " ").trim();
  // A slash command echoes as Claude Code's tagged record of it, never as the
  // "/cmd args" the row holds (parseSlashCommand). Without this no command
  // sent from the app was ever adopted, and its bubble stayed at the tail.
  const cCommand = canonicalSlashCommand(c);
  const contentMatches = (pm: T) => {
    if (cCommand) return canonicalSlashCommand(stripPastedContent(pm.content)) === cCommand;
    // Strip image tokens from BOTH sides: the composer stamps "[Image N]" into
    // the draft text for each attachment, so the pending content carries the
    // token exactly like the echo does. Stripping only the echo side left a
    // text+image send permanently unmatched (no thumbnail, no client_id).
    const pc = stripPastedContent(redactSecrets(pm.content))
      .replace(/\[Image[:\s][^\]]*\]/gi, "")
      .replace(/\[image\]/gi, "")
      .replace(ECHO_CONTROL_CHARS_RE, "")
      .trim();
    const pcFlat = pc.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
    const contentMatch = cFlat === pcFlat || c === pc;
    if (!contentMatch) return false;
    if (!cFlat && !pcFlat) {
      return imageEchoMatchesPending(pm, safeContent || "", msgTimestamp);
    }
    return true;
  };
  const inDeliveryOrder = [...pendingMsgs].sort(
    (a, b) => (a.created_at || 0) - (b.created_at || 0),
  );
  // Strongest tier, tried first: the echo names the storage id of the file the
  // daemon wrote, and the daemon only knows that path because it read this
  // pending row. That join survives whatever the terminal did to the prose —
  // text equality does not (a stray keystroke or a leaked Ctrl+K byte is enough
  // to break it, and the row then loses its images, sender and clean content).
  // Still ordered oldest-first and gated on never-adopted, so re-sending a draft
  // that reuses one storage id pairs each echo with a different row.
  const echoedImageIds = injectedImageStorageIds(safeContent || "");
  const imageIdMatch = () =>
    echoedImageIds.length === 0
      ? undefined
      : inDeliveryOrder.find(
          (pm) =>
            !pm.echo_message_id &&
            !consumed?.has(pm._id) &&
            // A row killed before injection never had its file written, so it
            // can't be the source of this path — only a resend reusing the same
            // draft storage id could put it here, and that belongs to the row
            // that actually shipped.
            pm.status !== "cancelled" &&
            pm.status !== "undeliverable" &&
            pendingImageStorageIds(pm).some((id) => echoedImageIds.includes(id)),
        );
  const firstMatch = (statuses: readonly string[]) => inDeliveryOrder.find(
    (pm) => statuses.includes(pm.status) && !consumed?.has(pm._id) && contentMatches(pm),
  );
  // Last resort: a row the status ack already terminalized before its echo
  // synced. Adoption-only — markPendingDelivered on it is a no-op — and gated
  // on never-adopted + recency so old delivered twins can't absorb a new echo.
  const recentlyDeliveredMatch = () => inDeliveryOrder.find(
    (pm) =>
      pm.status === "delivered" &&
      !pm.echo_message_id &&
      typeof pm.delivered_at === "number" &&
      Math.abs(msgTimestamp - pm.delivered_at) <= DELIVERED_ECHO_ADOPTION_WINDOW_MS &&
      !consumed?.has(pm._id) &&
      contentMatches(pm),
  );
  return imageIdMatch()
    ?? firstMatch(["pending", "injected"])
    ?? firstMatch(["failed"])
    ?? recentlyDeliveredMatch();
}
