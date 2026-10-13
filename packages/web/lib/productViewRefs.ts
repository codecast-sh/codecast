// Product views in text (docs/architecture/external-data.md X8, views): a
// connected app's own screen named in markdown, read here and drawn by
// components/line/widgets/ProductView. Two shapes reach it:
//
//   ```view
//   {"source":"union","view":"conversation","id":"<contact id>","at":"2026-10-09T14:03:00Z"}
//   ```
//
// and the bare reference `union:conversation/<contact id>@<iso>` in prose
// (contracts/productView.ts). Alone on its line a reference is the view; in
// running text it is a pill. Pure.
import { formatProductViewRef, isProductViewAt, parseProductViewRef, type ProductViewRef } from "@codecast/shared/contracts/productView";

export const VIEW_FENCE_LANG = "view";

/** The payload a reference rides in a markdown link's text (`view:<ref>`), the way doc and message refs ride theirs. */
export const VIEW_REF_PREFIX = "view:";

/**
 * A source name as a reference's app part: lower case, anything outside
 * letters, digits and dashes a dash. The server matches a reference's app
 * against both its sources' manifest names and their names read this way
 * (convex sources/appViews.ts, appSlug).
 */
export function appSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

export type ViewFenceSpec = {
  ref: ProductViewRef;
  /** A moment (mo-N) to show in its place when the app cannot draw the view. */
  moment: string | null;
  /** A plain link to the thing in the app, for the same case. */
  url: string | null;
  title: string | null;
};
export type ViewFenceRead = { ok: true; spec: ViewFenceSpec } | { ok: false; why: string };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** A ```view block's body read as one view of one thing, or why it cannot be. */
export function readViewFence(code: string): ViewFenceRead {
  let raw: unknown;
  try {
    raw = JSON.parse(code);
  } catch {
    return { ok: false, why: "The block is not JSON." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, why: "The block is not a JSON object." };
  const o = raw as Record<string, unknown>;
  const app = str(o.source) ?? str(o.app);
  const view = str(o.view);
  const id = str(o.id);
  if (!app || !view || !id) return { ok: false, why: "A view needs a source, a view and an id." };
  const at = str(o.at);
  if (at && !isProductViewAt(at)) return { ok: false, why: `"${at}" is not an ISO time.` };
  const ref = parseProductViewRef(formatProductViewRef({ app: appSlug(app), view, id, at }));
  if (!ref) return { ok: false, why: "The source, view or id has characters a view reference cannot carry." };
  const url = str(o.url);
  return { ok: true, spec: { ref, moment: str(o.moment), url: url && /^https?:\/\//i.test(url) ? url : null, title: str(o.title) } };
}

/**
 * A reference in prose. The id must look like an id (eight characters or
 * more, a digit among them), so `github:owner/repo` and `note:a/b` stay prose:
 * a reference is only checked against the connected apps when it is opened.
 */
export const VIEW_REF_SCAN_SOURCE =
  "(?<![\\w/:.@-])[a-z][a-z0-9-]{0,39}:[a-z][a-z0-9_.-]{0,39}\\/(?=[A-Za-z0-9_-]*\\d)[A-Za-z0-9][A-Za-z0-9_-]{7,127}(?:@\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,6})?)?(?:Z|[+-]\\d{2}:\\d{2}))?(?![\\w/])";
export const viewRefScanRegex = () => new RegExp(VIEW_REF_SCAN_SOURCE, "g");

/** The reference a link's `view:<ref>` payload carries, or null for any other text. */
export function viewRefFromPayload(text: string | null | undefined): ProductViewRef | null {
  if (!text || !text.startsWith(VIEW_REF_PREFIX)) return null;
  return parseProductViewRef(text.slice(VIEW_REF_PREFIX.length));
}

/** A moment kind's view: the kind itself, or its last word (`contact-conversation` is a conversation). */
const kindView = (kind: string) => kind.split("-").pop() ?? kind;

/**
 * The app view of a moment's subject as of the moment: `union` and a
 * `contact-conversation` about a contact read as that contact's conversation
 * then. Null when the parts cannot form a reference. Whether the app
 * declares the view is the server's to say when it mints.
 */
export function momentViewRef(m: { source: string | null; kind: string; subject: string; at: number | null }): ProductViewRef | null {
  if (!m.source) return null;
  const at = m.at != null && Number.isFinite(m.at) ? new Date(m.at).toISOString() : null;
  return parseProductViewRef(formatProductViewRef({ app: appSlug(m.source), view: kindView(m.kind), id: m.subject, at }));
}

/** How a view reads in a title row: "Union conversation". */
export function viewLabel(ref: Pick<ProductViewRef, "app" | "view">, appTitle?: string | null): string {
  const app = appTitle ?? ref.app.replace(/^./, (c) => c.toUpperCase());
  return `${app} ${ref.view}`;
}
