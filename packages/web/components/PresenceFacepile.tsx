// Avatar stack for live presence: the person's photo when they have one, else
// a colored initial in the same color as their editor cursor, so the facepile
// and the cursors read as the same identity. Shared by the composer's
// co-presence bar, the ghost drafts and reading marks in a session, and the
// expanded doc view's "who's in here" header.
import { AvatarImg } from "../lib/avatarCache";

export type PresenceFace = {
  user_id: string;
  user_name: string;
  user_color: string;
  user_image?: string;
};

/** One person's face at `size` px. */
export function PresenceAvatar({ person, size = 20, ring = true, title }: { person: PresenceFace; size?: number; ring?: boolean; title?: string }) {
  const initial = (
    <span
      className={`rounded-full grid place-items-center font-semibold text-sol-bg shrink-0 ${ring ? "ring-2 ring-sol-bg" : ""}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5), backgroundColor: person.user_color }}
    >
      {(person.user_name || "?").charAt(0).toUpperCase()}
    </span>
  );
  return (
    <span title={title ?? person.user_name} className="inline-flex shrink-0">
      {person.user_image ? (
        <AvatarImg
          src={person.user_image}
          alt={person.user_name}
          className={`rounded-full object-cover shrink-0 ${ring ? "ring-2 ring-sol-bg" : ""}`}
          style={{ width: size, height: size }}
          fallback={initial}
        />
      ) : initial}
    </span>
  );
}

export function PresenceFacepile({
  present,
  max = 4,
  size = 20,
}: {
  present: PresenceFace[];
  max?: number;
  size?: number;
}) {
  if (present.length === 0) return null;
  const shown = present.slice(0, max);
  const overflow = present.length - shown.length;
  return (
    <div className="flex -space-x-1.5 shrink-0">
      {shown.map((p) => <PresenceAvatar key={p.user_id} person={p} size={size} />)}
      {overflow > 0 && (
        <span
          className="rounded-full grid place-items-center font-semibold text-sol-text-dim bg-sol-bg-alt ring-2 ring-sol-bg"
          style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}
