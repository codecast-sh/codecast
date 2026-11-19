// What a call's stage can hold besides faces and screen shares: things a
// person or an agent in the room pinned there for everyone to look at and
// work on together (a board, a sheet, a dashboard, a doc, a published page,
// any other codecast object). One grammar for the ref a pin is written as,
// shared by the server that stores pins, the CLI that writes them and the
// stage that draws them.

/** How many things a stage holds at once. Past this the oldest pin leaves. */
export const STAGE_PIN_LIMIT = 6;

export type StagePinTarget =
  /** A doc of any type: board, sheet and dashboard draw live; prose docs as the doc. */
  | { kind: "doc"; id: string; ref: string }
  /** A `cast publish` page, by slug. */
  | { kind: "page"; slug: string; ref: string }
  /** Any other codecast object by short id (ct-12, pl-3, jx7abcd, #42, cl-9). */
  | { kind: "object"; ref: string };

const DOC_ID = /^[a-z0-9]{20,40}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{1,80}$/i;

/** Read what someone typed to pin: `doc:<id>`, a /docs/<id> link, a page link
 *  (`https://codecast.sh/a/<slug>`, `a/<slug>`), or another object's short id.
 *  The ref it returns is canonical (`doc:<id>`, `a/<slug>`), so one thing
 *  pinned twice is one pin. Null for text that names nothing pinnable. */
export function parseStagePinRef(input: string): StagePinTarget | null {
  const s = (input ?? "").trim();
  if (!s) return null;
  const docUrl = s.match(/\/docs\/([a-z0-9]{20,40})(?:[/?#]|$)/i);
  if (docUrl) return { kind: "doc", id: docUrl[1], ref: `doc:${docUrl[1]}` };
  const docRef = s.match(/^doc:([a-z0-9]{20,40})$/i);
  if (docRef) return { kind: "doc", id: docRef[1], ref: `doc:${docRef[1]}` };
  const pageUrl = s.match(/(?:^|\/\/[^/]+\/|^\/)a\/([a-z0-9][a-z0-9-]{1,80})(?:[/?#]|$)/i);
  if (pageUrl) return { kind: "page", slug: pageUrl[1], ref: `a/${pageUrl[1]}` };
  if (/\s/.test(s) || s.includes("/")) return null;
  // A bare id: the server decides whether it is a doc (normalizeId) before
  // falling back to an object reference.
  if (DOC_ID.test(s)) return { kind: "doc", id: s, ref: `doc:${s}` };
  if (SLUG.test(s) || /^#\d+$/.test(s)) return { kind: "object", ref: s };
  return null;
}

/** A pin's key in the client's store: one row per thing per room. */
export function stagePinRowId(roomKey: string, ref: string): string {
  return `${roomKey}|${ref}`;
}

/** The link a pin opens at, full size, on the web app. */
export function stagePinHref(target: StagePinTarget, origin = ""): string | null {
  if (target.kind === "doc") return `${origin}/docs/${target.id}`;
  if (target.kind === "page") return `${origin}/a/${target.slug}`;
  return null;
}
