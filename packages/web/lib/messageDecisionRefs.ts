import { bareEntityIdRegex, entityTypeFromId } from "@codecast/shared/entities";

/** The decisions a message names (`sd-N`, bare or inside an `@[Title sd-N]`
 *  mention), in the order it first names them, each once. */
export function messageDecisionRefs(text: string | undefined): string[] {
  if (!text || !/sd-\d/i.test(text)) return [];
  const seen = new Set<string>();
  for (const m of text.matchAll(bareEntityIdRegex())) {
    const id = m[0].toLowerCase();
    if (entityTypeFromId(id) === "decision") seen.add(id);
  }
  return [...seen];
}
