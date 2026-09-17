// Session characters (docs/architecture/session-characters.md): every
// session wears a face from the org avatar set and a short name, so a list of
// sessions reads like a room of people rather than a list of titles. A person
// may choose both; until they do, a stable hash of the session id picks them,
// so a session has the same character on every device and every surface
// without anyone deciding. A role's standing session wears the role instead:
// the role is the identity, the session is its current body.
import { AVATAR_KEYS, defaultAvatarFor, isAvatarKey, type AvatarKey } from "./orgAvatars";

export type Character = {
  avatar: AvatarKey;
  name: string;
  /** false when both parts are the hash default; true once a person chose either. */
  chosen: boolean;
};

/** Six names per face, whimsical and short, none shared between faces, so a
 *  default character is one of 144 rather than one of 24. Order is load
 *  bearing: the hash indexes into it. */
export const CHARACTER_NAMES: Record<AvatarKey, readonly [string, string, string, string, string, string]> = {
  fox: ["Ember", "Sorrel", "Fennel", "Tansy", "Rufus", "Juniper"],
  owl: ["Sage", "Minerva", "Barnaby", "Pip", "Nyx", "Hollis"],
  otter: ["Pebble", "Brook", "Tarka", "Marlow", "Finn", "Ripple"],
  crane: ["Iris", "Lotus", "Quill", "Haru", "Reed", "Solenne"],
  bear: ["Bruno", "Maple", "Boris", "Honey", "Ursa", "Alder"],
  hare: ["Clover", "Thistle", "Hazel", "Dash", "Bramble", "Tuft"],
  moth: ["Luna", "Dusk", "Velvet", "Cinder", "Nimbus", "Flicker"],
  whale: ["Atlas", "Marin", "Neptune", "Bluebell", "Fathom", "Tide"],
  hedgehog: ["Prickle", "Bristle", "Hobb", "Nettle", "Twig", "Burr"],
  stag: ["Rowan", "Aspen", "Cedric", "Fern", "Hart", "Moss"],
  raccoon: ["Bandit", "Rascal", "Pocket", "Scout", "Ziggy", "Nook"],
  penguin: ["Frost", "Tux", "Nansen", "Glacier", "Puck", "Skipper"],
  seal: ["Selkie", "Misty", "Pearl", "Kelp", "Nori", "Dune"],
  lynx: ["Ash", "Onyx", "Tundra", "Whisker", "Sasha", "Frey"],
  octopus: ["Inky", "Ollie", "Coral", "Squiggle", "Octavia", "Wisp"],
  toucan: ["Mango", "Pico", "Rio", "Tango", "Kiwi", "Sunny"],
  frog: ["Puddle", "Fig", "Hopper", "Basil", "Lily", "Sprout"],
  goat: ["Alpine", "Heidi", "Gruff", "Peak", "Clove", "Rocco"],
  swan: ["Odette", "Cygnus", "Ondine", "Sable", "Velour", "Noir"],
  snail: ["Dawdle", "Shelby", "Spiral", "Mosey", "Tarn", "Pace"],
  elephant: ["Tembo", "Juno", "Rumble", "Peanut", "Hathi", "Wendell"],
  koala: ["Kip", "Bindi", "Mallee", "Snooze", "Wattle", "Banjo"],
  squirrel: ["Acorn", "Nutkin", "Scamper", "Chestnut", "Filbert", "Tawny"],
  robin: ["Rosie", "Chirp", "Merry", "Redd", "Wren", "Tweedy"],
};

/** Every name in the bank, for validation and for the picker's suggestions. */
export const ALL_CHARACTER_NAMES: readonly string[] = AVATAR_KEYS.flatMap((k) => CHARACTER_NAMES[k]);

/** The hash from orgAvatars, exposed so the name index decorrelates from the face index. */
function hash(s: string): number {
  let h = 5381;
  for (const ch of (s ?? "").toLowerCase()) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return h;
}

/** The name a session would wear on a given face: the same hash slice the
 *  default uses, so changing only the face still yields a stable name, and
 *  `nudge` walks the face's six without repeating. */
export function characterNameFor(sessionId: string, avatar: AvatarKey, nudge = 0): string {
  const bank = CHARACTER_NAMES[avatar];
  const base = Math.floor(hash(sessionId) / AVATAR_KEYS.length);
  return bank[(base + nudge) % bank.length];
}

/** The character a session wears before anyone chooses: face and name both
 *  from one hash of its id, so the pair is stable and spreads over all 144. */
export function defaultCharacterFor(sessionId: string): Character {
  const avatar = defaultAvatarFor(sessionId);
  return { avatar, name: characterNameFor(sessionId, avatar), chosen: false };
}

/** The fields a session row carries; both optional, either may be chosen alone. */
export type CharacterFields = { character_avatar?: string | null; character_name?: string | null };

/** What a row is called in the UI: its chosen parts over the hash defaults. A
 *  chosen name with no chosen face keeps the default face, and the reverse. */
export function characterOf(row: CharacterFields & { _id: string }): Character {
  const d = defaultCharacterFor(row._id);
  const chosenAvatar = isAvatarKey(row.character_avatar) ? row.character_avatar : null;
  const chosenName = cleanCharacterName(row.character_name);
  return { avatar: chosenAvatar ?? d.avatar, name: chosenName ?? d.name, chosen: chosenAvatar !== null || chosenName !== null };
}

export const CHARACTER_NAME_MAX = 24;

/** A name a person typed: trimmed, one line, capped; null when nothing is left. */
export function cleanCharacterName(raw: string | null | undefined): string | null {
  const s = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, CHARACTER_NAME_MAX);
  return s.length ? s : null;
}

/** Both write paths run a character patch through this: an unknown face key
 *  or an empty name clears the field, a name is cleaned, everything else
 *  passes through untouched. `undefined` is what a Convex patch reads as
 *  "remove the field"; a client clears by sending null, which arrives here. */
export function normalizeCharacterFields<T extends Record<string, unknown>>(fields: T): T {
  const out: Record<string, unknown> = { ...fields };
  if ("character_avatar" in out) out.character_avatar = isAvatarKey(out.character_avatar) ? out.character_avatar : undefined;
  if ("character_name" in out) out.character_name = cleanCharacterName(out.character_name as string | null | undefined) ?? undefined;
  return out as T;
}
