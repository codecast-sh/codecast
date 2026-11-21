import { useMemo } from "react";
import { useTeamRosterIdentity, useViewerIdentity } from "./useTeamRoster";
import type { SenderContext, SenderPerson } from "../lib/messageSender";

/** The roster, viewer and owner every sender lookup resolves against
 *  (lib/messageSender). Web's transcript and navigator and the phone's
 *  session screen all build it here, so they name the same person. */
export function useSenderContext(owner: { id?: string | null; name?: string | null; image?: string | null }): SenderContext {
  const roster = useTeamRosterIdentity();
  const viewer = useViewerIdentity();
  return useMemo(() => {
    const people = new Map<string, SenderPerson>();
    for (const p of viewer ? [...roster, viewer] : roster) {
      const id = String(p._id);
      if (!people.has(id)) people.set(id, { name: p.name || p.email?.split("@")[0], image: p.image || p.github_avatar_url || null });
    }
    return {
      ownerId: owner.id ?? null,
      ownerName: owner.name,
      ownerImage: owner.image,
      viewerId: viewer?._id ? String(viewer._id) : null,
      lookup: (id) => people.get(id),
    };
  }, [roster, viewer, owner.id, owner.name, owner.image]);
}
