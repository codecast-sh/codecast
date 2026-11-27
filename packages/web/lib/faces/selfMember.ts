// The viewer as a face reads them, from their own user doc: for a workspace
// whose roster does not hold them (Personal). A leaf, so the member card can
// read it without the face row's walkie imports.
import type { FaceMember } from "./faceRow";

/** The viewer as a roster row, for a workspace whose roster does not hold
 *  them (Personal): their own fields, and present, since they are the one
 *  looking. */
export function selfMemberOf(user: any): (FaceMember & { timezone?: string }) | null {
  if (!user?._id) return null;
  return {
    _id: String(user._id),
    name: user.name,
    email: user.email,
    image: user.image,
    github_avatar_url: user.github_avatar_url,
    github_username: user.github_username,
    status: user.status,
    timezone: user.timezone,
    presence_state: "active",
  };
}

/** What a self card or face reads off the user doc, as one string: the doc
 *  itself changes on every daemon heartbeat. */
export function selfMemberSig(user: any): string {
  if (!user?._id) return "";
  return [String(user._id), user.name, user.email, user.image, user.github_avatar_url, user.github_username, user.status, user.timezone].join("|");
}
