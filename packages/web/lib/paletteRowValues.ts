/**
 * The cmdk value of each kind of palette row (components/PaletteRows.tsx).
 * cmdk selects a row by this string, so anything that must name a row ahead
 * of its render (the marketing hero picking its first result as the list
 * changes) builds it here, the way the row does.
 */

import { cleanTitle } from "./conversationProcessor";

export const paletteSessionValue = (conv: { _id: string; title?: string; project_path?: string; authorName?: string }) =>
  `__recent__ ${cleanTitle(conv.title || "")}\u2063 ${conv.project_path || ""} ${conv.authorName || ""}|||${conv._id}`;

// The title ends at U+2063 (paletteActions LABEL_END), so a hit in the title
// ranks above a hit in the snippet after it.
export const paletteSearchValue = (result: { conversationId: string; title: string; matches?: { content?: string }[] }) =>
  `__search__ ${result.title}\u2063 ${result.matches?.[0]?.content?.slice(0, 100) || ""}|||${result.conversationId}`;
