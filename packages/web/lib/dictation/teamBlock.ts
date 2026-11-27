// Why the person may not dictate: the first of their teams that may not send
// speech to OpenAI, as the one line the mic (DictateControls) and Settings ›
// Voice show. The server refuses the mint for the same teams
// (dictation.authForDictation), whichever team is on screen. A store selector.
import { teamVendorBlock } from "@codecast/shared/contracts";

export const openAiBlock = (s: { teams?: unknown[] }): string | null => {
  for (const team of s.teams ?? []) {
    const t = team as { name?: string; policy?: unknown } | null;
    if (teamVendorBlock(t, "openai")) return `Dictation isn't available: ${t?.name || "your team"} has no BAA with OpenAI yet.`;
  }
  return null;
};
