// Whose session a card is, on its meta row: a role's face and name, or a
// person's avatar (their initial while it loads) and first name.
import { AvatarImg } from "../../lib/avatarCache";
import type { IdentityPrefs } from "../../lib/sessionIdentity";
import { RoleFace } from "../org/RoleFace";
import type { SessionCardViewProps } from "./sessionCardTypes";

export function CardAuthor({ author, prefs }: { author: NonNullable<SessionCardViewProps["author"]>; prefs: IdentityPrefs }) {
  return (
    <span className="flex items-center gap-1 min-w-0 max-w-[130px]" title={`${author.name}'s session`}>
      {author.role ? (
        <RoleFace role={author.role} size={14} title={author.name} prefs={prefs} />
      ) : (
        <AvatarImg
          src={author.avatar}
          alt={author.name}
          className="w-3.5 h-3.5 rounded-full object-cover"
          fallback={
            <span className="w-[18px] h-[18px] rounded-full bg-sol-violet/20 text-sol-violet flex items-center justify-center text-mark font-semibold leading-none">
              {author.name.charAt(0).toUpperCase()}
            </span>
          }
        />
      )}
      <span className="text-meta font-medium text-sol-violet truncate">{author.role ? author.name : author.name.split(" ")[0]}</span>
    </span>
  );
}
