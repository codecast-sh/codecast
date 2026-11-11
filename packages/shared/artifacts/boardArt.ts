// Board illustrations (ct-92151): a fixed set of painted spot illustrations
// bundled with the web app (packages/web/components/boards/art/<name>.webp).
// A sticky's or shape's `icon` names one of these, or holds an emoji. The
// common emoji resolve to their painted twin, so a board an agent wrote with
// emoji draws the same art.

export const BOARD_ART = [
  "rocket", "map", "lightbulb", "target", "calendar", "clock", "hourglass", "flag", "mountain", "trophy",
  "gift", "truck", "box", "cart", "storefront", "money", "chart", "piechart", "magnifier", "megaphone",
  "mail", "chat", "people", "person", "handshake", "heart", "star", "thumbsup", "warning", "bug",
  "gear", "wrench", "laptop", "phone", "server", "database", "cloud", "lock", "key", "shield",
  "plug", "code", "puzzle", "book", "notebook", "clipboard", "checklist", "pencil", "palette", "camera",
  "music", "coffee", "pie", "berries", "leaf", "sun", "snowflake", "fire", "house", "building",
  "globe", "plane", "compass", "tent", "party", "road",
] as const;
export type BoardArt = (typeof BOARD_ART)[number];

const ART = new Set<string>(BOARD_ART);

export function isBoardArt(v: unknown): v is BoardArt {
  return typeof v === "string" && ART.has(v);
}

/** Emoji that have a painted twin in the set. Variation selectors are ignored. */
const EMOJI_ART: Record<string, BoardArt> = {
  "🚀": "rocket", "🗺": "map", "📍": "map", "💡": "lightbulb", "🎯": "target", "📅": "calendar", "📆": "calendar", "🗓": "calendar",
  "⏰": "clock", "🕐": "clock", "⏱": "clock", "⏳": "hourglass", "⌛": "hourglass", "🚩": "flag", "🏁": "flag", "⛰": "mountain", "🏔": "mountain",
  "🏆": "trophy", "🥇": "trophy", "🎁": "gift", "🚚": "truck", "🚛": "truck", "📦": "box", "🛒": "cart", "🏪": "storefront", "🏬": "storefront",
  "💰": "money", "💵": "money", "💸": "money", "🪙": "money", "📈": "chart", "📊": "chart", "🔍": "magnifier", "🔎": "magnifier",
  "📣": "megaphone", "📢": "megaphone", "✉": "mail", "📧": "mail", "📨": "mail", "💬": "chat", "🗨": "chat", "👥": "people", "🧑‍🤝‍🧑": "people",
  "👤": "person", "🙋": "person", "🤝": "handshake", "❤": "heart", "💖": "heart", "⭐": "star", "🌟": "star", "👍": "thumbsup",
  "⚠": "warning", "🐛": "bug", "🐞": "bug", "⚙": "gear", "🔧": "wrench", "🛠": "wrench", "💻": "laptop", "📱": "phone",
  "🖥": "server", "🗄": "database", "💾": "database", "☁": "cloud", "🔒": "lock", "🔐": "lock", "🔑": "key", "🛡": "shield",
  "🔌": "plug", "🧩": "puzzle", "📖": "book", "📚": "book", "📓": "notebook", "📝": "notebook", "📋": "clipboard", "✅": "checklist", "☑": "checklist",
  "✏": "pencil", "🎨": "palette", "📷": "camera", "📸": "camera", "🎵": "music", "🎶": "music", "☕": "coffee", "🥧": "pie",
  "🫐": "berries", "🍓": "berries", "🌱": "leaf", "🌿": "leaf", "🍃": "leaf", "☀": "sun", "🌞": "sun", "❄": "snowflake", "🔥": "fire",
  "🏠": "house", "🏡": "house", "🏢": "building", "🏛": "building", "🌍": "globe", "🌎": "globe", "🌏": "globe", "🌐": "globe",
  "✈": "plane", "🛫": "plane", "🧭": "compass", "⛺": "tent", "🏕": "tent", "🎉": "party", "🎊": "party", "🛣": "road", "🛤": "road",
};

/** The painted illustration an icon value draws, or null (an emoji with no twin draws as itself). */
export function boardArtFor(icon: unknown): BoardArt | null {
  if (typeof icon !== "string" || !icon) return null;
  if (ART.has(icon)) return icon as BoardArt;
  return EMOJI_ART[icon.replace(/️/g, "")] ?? null;
}
