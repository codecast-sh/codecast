// A turn written by several people at once: "send together" from a shared
// composer, or two queued messages merged into one. Each part is one person's
// words in the same <user-message from="Name"> wrapper a single direct send
// uses, back to back, so the agent reads one instruction that names every
// author instead of two turns that may contradict each other, and the
// transcript draws each part under its author.
import { formatUserMessage, parseUserMessage, stripInjectionNoise } from "./machineMessages";

export type JointPart = { from: string; body: string };

const PART_RE = /<user-message\s+from="([^"]*)"[^>]*>([\s\S]*?)<\/user-message>/g;

/** The wire text for a joint turn. Empty parts drop; one part is an ordinary direct send. */
export function formatJointMessage(parts: readonly JointPart[]): string {
  const kept = parts.filter((p) => p.body.trim());
  return kept.map((p) => formatUserMessage(p.from, p.body.trim())).join("\n");
}

/** The parts of a joint turn, or null when the text is not one (fewer than two parts, or text outside them). */
export function parseJointMessage(raw: string | null | undefined): JointPart[] | null {
  if (!raw) return null;
  const text = stripInjectionNoise(raw).trim();
  if (!text.startsWith("<user-message")) return null;
  const parts: JointPart[] = [];
  let rest = text;
  for (const m of text.matchAll(PART_RE)) {
    parts.push({ from: m[1].trim(), body: m[2].trim() });
    rest = rest.replace(m[0], "");
  }
  if (parts.length < 2 || rest.trim()) return null;
  return parts;
}

/**
 * A message's text as joint parts: a joint turn's own parts, a direct send's
 * one named part, or the whole text under `fallbackFrom` (an owner's plain
 * send into their own session carries no wrapper).
 */
export function jointPartsOf(raw: string, fallbackFrom: string): JointPart[] {
  const joint = parseJointMessage(raw);
  if (joint) return joint;
  const direct = parseUserMessage(raw);
  if (direct) return [direct];
  return [{ from: fallbackFrom, body: raw.trim() }];
}

/** One line naming a joint turn's authors: "Ann and Bob", "Ann, Bob and Cy". */
export function jointAuthors(parts: readonly JointPart[]): string {
  const names = [...new Set(parts.map((p) => p.from || "Someone"))];
  if (names.length <= 1) return names[0] ?? "Someone";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
