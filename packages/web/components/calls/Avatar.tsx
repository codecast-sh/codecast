import { AvatarImg } from "../../lib/avatarCache";

/** A person's face at `size` px, or their initial when they have no image.
 *  The call stage's roster, the dock and the room thread's typed lines all
 *  draw it, so one fallback reads the same in every place. */
export function Avatar({ m, size, followed = false }: { m: any; size: number; followed?: boolean }) {
  return (
    <AvatarImg
      src={m.user_image}
      alt=""
      style={{ width: size, height: size }}
      className={`rounded-full object-cover ${followed ? "ring-2 ring-sol-cyan ring-offset-1 ring-offset-sol-bg-alt" : ""}`}
      fallback={
        <span
          style={{ width: size, height: size, fontSize: Math.max(11, size / 2.6) }}
          className="flex items-center justify-center rounded-full bg-sol-bg-highlight font-mono text-sol-text-muted"
        >
          {(m.user_name || "?").charAt(0).toUpperCase()}
        </span>
      }
    />
  );
}
