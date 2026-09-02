import { Headphones } from "lucide-react";
import { AvatarImg } from "../../lib/avatarCache";
import { PresenceBadge } from "./PresenceBadge";
import {
  memberDisplayName,
  memberInHuddle,
  memberPresenceVisual,
  presenceAvatarClass,
  presenceLabel,
} from "./memberPresence";
import { useWalkieBurstRoom } from "./useFaceKey";

/**
 * One teammate's face: the avatar, faded to match their presence, with the
 * badge in its corner and the huddle chip in the other.
 *
 * Presence sits bottom-right, where every chat app puts it. The huddle chip is
 * an ACTIVITY, not a presence, so it keeps its violet and stays out of the
 * badge's corner rather than competing for the same eight pixels.
 *
 * `title` defaults to "Ann · Active". Pass "" where the row already says both
 * and a tooltip would only repeat it.
 */
export function MemberFace({
  member,
  size = 32,
  badgeSize,
  title,
  className = "",
  showHuddle = true,
}: {
  member: any;
  /** Pixel diameter of the face. */
  size?: number;
  /** Defaults to the small badge under 36px, the medium one at or above it. */
  badgeSize?: "sm" | "md";
  title?: string;
  className?: string;
  /** Off where the surface already says "in a huddle" in words and the face
   *  is too small to carry two badges (the compact roster row). */
  showHuddle?: boolean;
}) {
  const visual = memberPresenceVisual(member);
  const name = memberDisplayName(member);
  const avatar = member?.image || member?.github_avatar_url;
  const initial = (member?.name || member?.email || "?").charAt(0).toUpperCase();
  // A SEAT IS NOT A HUDDLE. A walkie burst seats everyone who hears it and
  // holds that seat for half a minute afterwards, so a face wearing the chip
  // off `in_huddle` alone kept claiming a call that had already stopped. The
  // rule is shared (memberInHuddle) and the room comes from the walkie itself.
  const burstRoom = useWalkieBurstRoom();
  const inHuddle = showHuddle && memberInHuddle(member, burstRoom);
  const badge = badgeSize ?? (size >= 36 ? "md" : "sm");
  return (
    <span className={`relative block shrink-0 ${className}`} style={{ width: size, height: size }}>
      <span
        className={`block h-full w-full overflow-hidden rounded-full ${presenceAvatarClass(visual)}`}
        title={title ?? `${name} · ${presenceLabel(visual)}`}
      >
        <AvatarImg
          src={avatar}
          alt={name}
          className="h-full w-full object-cover"
          fallback={
            <span className="flex h-full w-full items-center justify-center bg-sol-bg-highlight">
              <span
                className="font-medium text-sol-text-muted"
                style={{ fontSize: Math.max(10, Math.round(size * 0.4)) }}
              >
                {initial}
              </span>
            </span>
          }
        />
      </span>
      <PresenceBadge
        state={visual}
        size={badge}
        className="absolute -bottom-0.5 -right-0.5"
        title={presenceLabel(visual)}
      />
      {inHuddle && (
        <span
          className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-sol-bg bg-sol-violet"
          title="In a huddle"
        >
          <Headphones className="h-2 w-2 text-sol-bg" />
        </span>
      )}
    </span>
  );
}
