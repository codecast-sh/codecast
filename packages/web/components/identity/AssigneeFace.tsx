// Who owns a task, drawn the same way everywhere an assignee shows
// (org-roles-run-work.md R5): a person is their photo or initials and, when
// the face knows who they are, the person hover card; a role is its painted
// face and the role hover card one hover away. `info` is what lib/liveEntities resolveAssigneeInfo returns, so the
// face follows an optimistic reassignment in the same tick.
import { isRoleAssignee, type AssigneeInfo } from "@codecast/shared/contracts/orgAssignee";
import { AvatarImg } from "../../lib/avatarCache";
import { RoleAvatar } from "../org/avatars";
import { RoleHoverCard } from "./RoleHoverCard";
import { PersonHoverCard } from "./PersonHoverCard";

const initialsOf = (name: string) => name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();

export function AssigneeFace({ info, size = 16, hover = true, personId, className }: {
  info: AssigneeInfo | { name: string; image?: string; github_username?: string };
  size?: number;
  /** The hover card; off where the face sits inside another card. */
  hover?: boolean;
  /** The person's user id, when the caller knows it: their card opens on hover. */
  personId?: string;
  className?: string;
}) {
  const box = { width: size, height: size };
  if (isRoleAssignee(info as AssigneeInfo)) {
    const role = info as Extract<AssigneeInfo, { kind: "role" }>;
    const face = (
      <span className={`inline-block rounded-full flex-shrink-0 ${className ?? ""}`} style={{ ...box, lineHeight: 0 }} data-assignee-role={role.role_short_id}>
        <RoleAvatar avatar={role.avatar} size={size} title={role.name} />
      </span>
    );
    if (!hover) return face;
    return (
      <RoleHoverCard role={{ short_id: role.role_short_id, name: role.name, handle: role.handle, avatar: role.avatar }}>
        {face}
      </RoleHoverCard>
    );
  }
  const person = info as { name: string; image?: string; github_username?: string };
  const face = (
    <AvatarImg
      src={person.image}
      alt={person.name}
      title={person.name}
      className={`rounded-full flex-shrink-0 ${className ?? ""}`}
      style={box}
      fallback={
        <span
          className={`rounded-full flex-shrink-0 bg-sol-bg-highlight border border-sol-border/50 inline-flex items-center justify-center font-medium text-sol-text-muted ${className ?? ""}`}
          style={{ ...box, fontSize: Math.max(7, Math.round(size * 0.42)) }}
          title={person.name}
        >
          {initialsOf(person.name)}
        </span>
      }
    />
  );
  if (!hover || !(personId || person.github_username)) return face;
  return (
    <PersonHoverCard person={{ userId: personId, handle: person.github_username, name: person.name, image: person.image }}>
      {face}
    </PersonHoverCard>
  );
}
