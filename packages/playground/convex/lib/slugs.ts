// App names and the slugs their links live at. A slug is a readable stem from
// the name plus a short random tail ("frog-choir-k3x9"), so two apps with the
// same name never collide and a slug never shadows a shell route.
import { randomToken } from "./identity";

export const APP_NAME_MAX = 40;
export const SLUG_STEM_MAX = 32;
export const SLUG_TAIL_LENGTH = 4;
const SLUG_TAIL_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i

/** Lowercase ASCII words joined by single hyphens, cut on a word boundary. */
export function slugStem(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let stem = "";
  for (const word of words) {
    const next = stem ? `${stem}-${word}` : word;
    if (next.length > SLUG_STEM_MAX) break;
    stem = next;
  }
  return stem || (words[0]?.slice(0, SLUG_STEM_MAX) ?? "") || "app";
}

export function makeSlug(name: string, tail = randomToken(SLUG_TAIL_LENGTH, SLUG_TAIL_ALPHABET)): string {
  return `${slugStem(name)}-${tail}`;
}

export function isSlug(s: unknown): s is string {
  return (
    typeof s === "string" &&
    s.length <= SLUG_STEM_MAX + 1 + SLUG_TAIL_LENGTH &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)
  );
}

/** A name a person typed: one line, trimmed, capped; null when nothing is left. */
export function cleanAppName(raw: string | null | undefined): string | null {
  const s = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, APP_NAME_MAX).trim();
  return s.length ? s : null;
}

const PROMPT_LEAD = /^(?:(?:please|can you|could you|let'?s|i want|i'?d like)\s+)?(?:(?:make|build|create|write|draw|design)\s+(?:me\s+|us\s+)?)?(?:(?:a|an|the|some)\s+)?/i;
const NAME_WORDS = 4;

/** A short name from a "Make something" prompt: the subject before the first
 *  clause break, lead-in verbs and articles dropped, sentence case.
 *  "a frog choir, one note per person" -> "Frog choir". */
export function nameFromPrompt(prompt: string): string {
  const firstClause = prompt.trim().split(/[,.;:!?\n(]|\s(?:where|that|which|with|for|so|and)\s/i)[0] ?? "";
  const subject = firstClause.replace(PROMPT_LEAD, "").trim();
  const words = subject.split(/\s+/).filter(Boolean).slice(0, NAME_WORDS).join(" ");
  const name = cleanAppName(words);
  return name ? name[0].toUpperCase() + name.slice(1) : "Untitled";
}
