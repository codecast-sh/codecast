import { AVATAR_KEYS, type AvatarKey } from "@codecast/shared/contracts/orgAvatars";
import { characterNameFor } from "@codecast/shared/contracts/sessionCharacter";

/** A distinct face each: walk the key list from the picked face so a squad of
 *  N gets N different animals, and give each row that face's own name. */
export function spreadCharacters(ids: string[], from: AvatarKey): Array<{ id: string; avatar: AvatarKey; name: string }> {
  const start = AVATAR_KEYS.indexOf(from);
  return ids.map((id, i) => {
    const avatar = AVATAR_KEYS[(start + i) % AVATAR_KEYS.length];
    return { id, avatar, name: characterNameFor(id, avatar) };
  });
}
