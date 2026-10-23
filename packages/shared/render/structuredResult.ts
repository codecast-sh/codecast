import { getRelativePath } from "./format";

// A workflow subagent's StructuredOutput payload, read for a person. The schema
// is whatever the workflow script asked for, so nothing here knows a field by
// meaning alone: the shape decides the view. One short string under a status
// key becomes the result's pill; short scalars become labelled values; long
// strings become prose; an array of objects becomes rows (each with its own
// pill, file location and title when it has them); an array of scalars becomes
// a list. Web and mobile both draw from this model, so they read a payload the
// same way.

export type StructuredTone = "good" | "warn" | "bad" | "neutral";

export type StructuredField = { label: string; value: string; tone?: StructuredTone };

export type StructuredRecord = {
  badge?: { text: string; tone: StructuredTone };
  /** `path` as the payload gave it (for a link), `display` shortened for reading. */
  location?: { path: string; display: string; line?: number };
  title?: string;
  fields: StructuredField[];
  texts: { label: string; text: string }[];
};

export type StructuredSection =
  | { kind: "text"; label: string; text: string }
  | { kind: "list"; label: string; items: string[]; paths: boolean }
  | { kind: "records"; label: string; items: StructuredRecord[] }
  | { kind: "fields"; label: string; fields: StructuredField[] };

export type StructuredResult = {
  status?: { label: string; text: string; tone: StructuredTone };
  fields: StructuredField[];
  sections: StructuredSection[];
};

const STATUS_KEYS = ["verdict", "status", "outcome", "result", "decision", "conclusion", "state"];
const BADGE_KEYS = ["severity", "verdict", "status", "priority", "level", "outcome", "ruling"];
const TITLE_KEYS = ["title", "name", "issue", "claim", "finding", "summary", "description", "message", "problem"];
const PATH_KEYS = ["file", "path", "file_path", "filePath", "location"];
const LINE_KEYS = ["line", "line_number", "lineNumber", "lines"];
// The prose that answers "what came of it" leads, whatever order the schema put it in.
const LEAD_TEXT_KEYS = ["summary", "conclusion", "answer"];

const SHORT = 60;

export function humanizeKey(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** good / warn / bad for a status or severity word; neutral when it is neither. */
export function structuredTone(value: string): StructuredTone {
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (/^(pass(ed)?|done|ok|okay|success(ful)?|succeeded|safe|approved?|complete(d)?|clean|green|yes|true|fixed|confirmed|resolved|valid|keep|lgtm|shipped|merged)$/.test(v)) return "good";
  if (/^(fail(ed|ure)?|reject(ed)?|errou?r(ed)?|blocked|blocker|unsafe|broken|red|critical|high|major|severe|no|false|invalid|regress(ed|ion)?|wrong|refuted)$/.test(v)) return "bad";
  if (/^(needs?_\w+|partial(ly_\w+)?|concerns?|done_with_concerns|warn(ing)?|minor|medium|moderate|changes_requested|request_changes|skipped|unknown|unclear|plausible|maybe|uncertain|inconclusive|mixed|pending|in_progress|stale|flaky)$/.test(v)) return "warn";
  return "neutral";
}

const isScalar = (v: unknown): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
// A value (a word, a name, an id, a count), not a sentence: sentences are prose.
const isShortScalar = (v: unknown): v is string | number | boolean =>
  typeof v === "number" || typeof v === "boolean" ||
  (typeof v === "string" && v.length <= SHORT && !v.includes("\n") && v.trim().split(/\s+/).length <= 4 && !/\s.*[.!?:]$/.test(v.trim()));
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const looksLikePath = (s: string) => /^(\/|~\/|\.{0,2}\/?[\w@.-]+\/)[^\s]*\.?[\w-]*$/.test(s) && s.includes("/") && !/\s/.test(s);
const displayPath = (s: string) => (s.startsWith("/") ? getRelativePath(s) : s);

function recordOf(obj: Record<string, unknown>): StructuredRecord {
  const used = new Set<string>();
  const pick = (keys: string[], test: (v: unknown) => boolean) => {
    const key = keys.find((k) => k in obj && test(obj[k]));
    if (key) used.add(key);
    return key;
  };
  const badgeKey = pick(BADGE_KEYS, (v) => typeof v === "string" && isShortScalar(v));
  const pathKey = pick(PATH_KEYS, (v) => typeof v === "string" && !!v);
  const lineKey = pathKey ? pick(LINE_KEYS, (v) => typeof v === "number" || (typeof v === "string" && /^\d[\d\s,:-]*$/.test(v))) : undefined;
  const titleKey = pick(TITLE_KEYS, (v) => typeof v === "string" && !!v.trim());
  const rec: StructuredRecord = { fields: [], texts: [] };
  if (badgeKey) rec.badge = { text: String(obj[badgeKey]), tone: structuredTone(String(obj[badgeKey])) };
  if (pathKey) {
    const path = String(obj[pathKey]);
    const line = lineKey ? parseInt(String(obj[lineKey]), 10) : NaN;
    rec.location = { path, display: displayPath(path) + (lineKey ? `:${String(obj[lineKey])}` : ""), ...(Number.isFinite(line) && { line }) };
  }
  if (titleKey) rec.title = String(obj[titleKey]);
  for (const [key, value] of Object.entries(obj)) {
    if (used.has(key) || value == null || value === "") continue;
    if (isShortScalar(value)) rec.fields.push({ label: humanizeKey(key), value: String(value) });
    else if (typeof value === "string") rec.texts.push({ label: humanizeKey(key), text: value });
    else if (Array.isArray(value) && value.every(isScalar)) rec.texts.push({ label: humanizeKey(key), text: value.map((v) => `- ${v}`).join("\n") });
    else rec.texts.push({ label: humanizeKey(key), text: "```json\n" + JSON.stringify(value, null, 2) + "\n```" });
  }
  return rec;
}

function sectionOf(key: string, value: unknown): StructuredSection | null {
  const label = humanizeKey(key);
  if (typeof value === "string") return { kind: "text", label, text: value };
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isPlainObject)) return { kind: "records", label, items: value.map(recordOf) };
    if (value.every(isScalar)) {
      const items = value.map(String);
      const paths = items.length > 0 && items.every(looksLikePath);
      return { kind: "list", label, items: paths ? items.map(displayPath) : items, paths };
    }
    return { kind: "text", label, text: "```json\n" + JSON.stringify(value, null, 2) + "\n```" };
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v != null && v !== "");
    if (entries.every(([, v]) => isShortScalar(v))) return { kind: "fields", label, fields: entries.map(([k, v]) => ({ label: humanizeKey(k), value: String(v) })) };
    return { kind: "records", label, items: [recordOf(value)] };
  }
  return null;
}

export function structuredResultModel(payload: Record<string, unknown>): StructuredResult {
  const out: StructuredResult = { fields: [], sections: [] };
  const statusKey = STATUS_KEYS.find((k) => typeof payload[k] === "string" && isShortScalar(payload[k]));
  if (statusKey) {
    const text = String(payload[statusKey]);
    out.status = { label: humanizeKey(statusKey), text, tone: structuredTone(text) };
  }
  let lead: StructuredSection | undefined;
  for (const [key, value] of Object.entries(payload)) {
    if (key === statusKey || value == null) continue;
    if (isShortScalar(value) && value !== "") {
      const s = String(value);
      const tone = typeof value === "string" ? structuredTone(s) : "neutral";
      out.fields.push({ label: humanizeKey(key), value: s, ...(tone !== "neutral" && { tone }) });
      continue;
    }
    const section = sectionOf(key, value);
    if (!section) continue;
    if (!lead && section.kind === "text" && LEAD_TEXT_KEYS.includes(key)) lead = section;
    else out.sections.push(section);
  }
  if (lead) out.sections.unshift(lead);
  return out;
}
