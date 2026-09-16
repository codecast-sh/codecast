// The face a role wears (docs/architecture/org-staffing.md S13). A role sits
// beside human photographs on the chart, the scope header, the chat pill and
// the wake card, so it needs a face of its own. This is the one place that
// turns a ROLE ROW into a face: the avatar it chose, else the stable default
// for its handle, so every role has one without anyone picking. The art and
// the sizing live in avatars/RoleAvatar; this keeps the role-shaped call site
// in one spot so every surface resolves a role the same way.
import { avatarOf } from "@codecast/shared/contracts/orgAvatars";
import { RoleAvatar } from "./avatars";

type RoleLike = { avatar?: string | null; handle: string; name?: string };

/**
 * A role's avatar as a round face of `size` px. The title (and so the alt text)
 * is the role's name when it has one, else its handle, so a screen reader hears
 * the role rather than the animal.
 */
export function RoleFace({ role, size = 24, className, title }: { role: RoleLike; size?: number; className?: string; title?: string }) {
  return (
    <RoleAvatar
      avatar={avatarOf(role)}
      size={size}
      className={className}
      title={title ?? role.name ?? `@${role.handle}`}
    />
  );
}
