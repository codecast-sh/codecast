// Personified roles (docs/architecture/org-staffing.md S13): the key list of
// the animal profile icons a role may wear. The SVGs live in
// packages/web/components/org/avatars/; this list is what the server
// validates against and what the default is drawn from, so a key stored on a
// role always names an icon the web can draw.
//
// One animal per key, in the order the set was drawn. The order is load
// bearing: `defaultAvatarFor` hashes a handle to a position, so reordering or
// renaming a key moves every role that never chose a face.

export const AVATAR_KEYS = [
  "fox", "owl", "otter", "crane", "bear", "hare",
  "moth", "whale", "hedgehog", "stag", "raccoon", "penguin",
  "seal", "lynx", "octopus", "toucan", "frog", "goat",
  "swan", "snail", "elephant", "koala", "squirrel", "robin",
] as const;

export type AvatarKey = (typeof AVATAR_KEYS)[number];

export function isAvatarKey(x: unknown): x is AvatarKey {
  return typeof x === "string" && (AVATAR_KEYS as readonly string[]).includes(x);
}

/** A stable hash of the handle into the set, so every role has a face before
 *  anyone picks one and the same handle always gets the same face. */
export function defaultAvatarFor(handle: string): AvatarKey {
  let h = 5381;
  for (const ch of (handle ?? "").toLowerCase()) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return AVATAR_KEYS[h % AVATAR_KEYS.length];
}

/** The face a role row wears: its chosen key, else the default for its handle. */
export function avatarOf(role: { avatar?: string | null; handle: string }): AvatarKey {
  return isAvatarKey(role.avatar) ? role.avatar : defaultAvatarFor(role.handle);
}
