// Words typed into a dashboard's text fields, and whether they may be saved.
// A draft is kept in sessionStorage on every keystroke, so a reload a moment
// after typing keeps it; the dashboard saves what it can on its next load,
// whether or not that field's editor is open.
import { dashboard, type ArtifactElement, type ArtifactOp } from "@codecast/shared/artifacts";

/** The refusal in a glance: what is typed, never the whole rule. */
/** A token that names no KPI here, or a part the page can't draw, would print raw to readers. */
function badToken(text: string, keys: readonly string[]): string | null {
  for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
    const ok = m[1].match(/^(b_[A-Za-z0-9_]+)(?:\.(value|delta|trend|vs))?$/);
    if (!ok) return `{${m[1]}} isn't a live value: pick one from Live value`;
    if (!keys.includes(ok[1])) return `{${m[1]}} names no KPI here: pick one from Live value`;
  }
  return null;
}

function typedClaims(text: string): string | null {
  const nums = dashboard.typedNumbers(text);
  const dirs = dashboard.directionWords(text).map((d) => `"${d.word}"`);
  const all = [...nums, ...dirs];
  return all.length ? `Typed ${all.slice(0, 3).join(", ")}${all.length > 3 ? "…" : ""}: use a live value` : null;
}

/** Words refused on save, kept per field until fixed: closing the editor or reloading the tab never throws away what was typed. */
const HELD = "cc-data-held:";
export const held = {
  get: (k: string) => {
    try {
      return sessionStorage.getItem(HELD + k) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set: (k: string, v: string) => {
    try {
      sessionStorage.setItem(HELD + k, v);
    } catch {}
  },
  delete: (k: string) => {
    try {
      sessionStorage.removeItem(HELD + k);
    } catch {}
  },
};


/** Why words can't be saved yet (a token naming no KPI here, a typed number or direction), or null. */
export function textRefusal(text: string, kpiKeys: readonly string[]): string | null {
  return badToken(text, kpiKeys) ?? typedClaims(text);
}

/** The fields a held draft can belong to: `${docId}:${blockKey}:${field}`. */
const FIELDS = new Set(["text", "say", "say_title"]);

/** The drafts this tab holds for a dashboard, as held keys. */
export function heldDraftKeys(docId: string): string[] {
  try {
    return Object.keys(sessionStorage)
      .filter((k) => k.startsWith(`${HELD}${docId}:`))
      .map((k) => k.slice(HELD.length));
  } catch {
    return [];
  }
}

/**
 * Save the given held drafts that are fit to save; refused ones stay held for
 * their editor to show. Returns the keys whose block hasn't arrived yet (a
 * cached copy can predate it), for the caller to try again.
 */
export function flushHeldDrafts(keys: readonly string[], elements: readonly ArtifactElement[], write: (ops: ArtifactOp[]) => void): string[] {
  const byKey = new Map(elements.map((e) => [e.key, e]));
  const kpis = elements.filter((e) => e.kind === "kpi").map((e) => e.key);
  const ops: ArtifactOp[] = [];
  const waiting: string[] = [];
  for (const k of keys) {
    const [, block, field] = k.split(":");
    const el = byKey.get(block);
    const v = held.get(k);
    if (!FIELDS.has(field) || v === undefined) continue;
    if (!el) {
      waiting.push(k);
      continue;
    }
    if (String(el[field] ?? "") === v) held.delete(k);
    else if (!textRefusal(v, kpis)) ops.push({ k: block, set: { [field]: v || null } });
  }
  if (ops.length) write(ops);
  return waiting;
}
