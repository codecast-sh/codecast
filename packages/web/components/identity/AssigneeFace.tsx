// Who owns a task, drawn the same way everywhere an assignee shows
// (org-roles-run-work.md R5): a person is their photo or initials, a role is
// its painted face with the violet ring and the role hover card one hover
// away. `info` is what lib/liveEntities resolveAssigneeInfo returns, so the
// face follows an optimistic reassignment in the same tick.
import { isRoleAssignee, type AssigneeInfo } from "@codecast/shared/contracts/orgAssignee";
import { AvatarImg } from "../../lib/avatarCache";
import { RoleAvatar } from "../org/avatars";
import { RoleHoverCard } from "./RoleHoverCard";
import { roleRingStyle } from "../../lib/roleRingStyle";

const initialsOf = (name: string) => name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();

export function AssigneeFace({ info, size = 16, hover = true, className }: {
  info: AssigneeInfo | { name: string; image?: string };
  size?: number;
  /** The role hover card; off where the face sits inside another card. */
  hover?: boolean;
  className?: string;
}) {
  const box = { width: size, height: size };
  if (isRoleAssignee(info as AssigneeInfo)) {
    const role = info as Extract<AssigneeInfo, { kind: "role" }>;
    const face = (
      <span className={`inline-block rounded-full flex-shrink-0 ${className ?? ""}`} style={{ ...box, lineHeight: 0, ...roleRingStyle(size) }} data-assignee-role={role.role_short_id}>
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
  const person = info as { name: string; image?: string };
  return (
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
}
