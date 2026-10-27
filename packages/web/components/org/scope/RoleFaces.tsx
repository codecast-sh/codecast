// A role's two faces on its settings tab (roleIcon.ts): the animal character
// and the drawn icon, side by side, so whoever edits the role sees what each
// viewer sees whichever way they set Characters. The icon can be redrawn,
// with an optional hint; a redraw is a paid model run, so it goes through
// the shared confirm flow (components/consequential).
import { useState } from "react";
import { avatarOf } from "@codecast/shared/contracts/orgAvatars";
import { roleIdentity } from "@codecast/shared/contracts/orgIdentity";
import { AVATAR_LABELS } from "../../../lib/orgAvatars";
import { roleTile } from "../../../lib/sessionIdentity";
import { RoleAvatar } from "../avatars";
import { RoleIconTile } from "../../identity/RoleIconTile";
import { SwitchReview } from "../../consequential/ConsequentialSwitch";
import { redrawIconLedger } from "../../consequential/ledgers";
import { useRedrawRoleIcon } from "../../../hooks/useRedrawRoleIcon";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { api } from "@codecast/convex/convex/_generated/api";
import type { OrgRole } from "../orgTypes";

const FACE = 56;

export function RoleFaces({ role, canEdit }: { role: OrgRole; canEdit: boolean }) {
  const avatar = avatarOf(role);
  const words = roleIdentity({ ...role, avatar });
  const tile = roleTile(role, words.title);
  const [hint, setHint] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const redraw = useRedrawRoleIcon();
  const drawing = redraw.pending === role._id;
  // The last drawing's sheet: the icon beside its siblings at sidebar sizes,
  // both themes. Enrichment: absent before the server has the query.
  const preview = (useQueryNoThrow(api.roleIcons.brief, tile.icon ? { role_id: role._id } : "skip").data as { preview_url?: string | null } | null | undefined)?.preview_url ?? null;
  return (
    <div className="flex flex-col gap-3" data-role-faces={role.short_id}>
      <div className="grid grid-cols-2 gap-3">
        <figure className="flex items-center gap-3 min-w-0" data-role-face="character">
          <RoleAvatar avatar={avatar} size={FACE} title={words.name} />
          <figcaption className="min-w-0">
            <div className="text-[10.5px]" style={{ color: "var(--sol-text-dim)" }}>Character</div>
            <div className="truncate text-[13px] font-medium" style={{ color: "var(--sol-text)" }}>{words.name}</div>
            <div className="truncate text-[11px]" style={{ color: "var(--sol-text-muted)" }}>{AVATAR_LABELS[avatar]}</div>
          </figcaption>
        </figure>
        <figure className="flex items-center gap-3 min-w-0" data-role-face="icon">
          <RoleIconTile tile={tile} size={FACE} />
          <figcaption className="min-w-0">
            <div className="text-[10.5px]" style={{ color: "var(--sol-text-dim)" }}>Icon</div>
            <div className="truncate text-[13px] font-medium" style={{ color: "var(--sol-text)" }}>{words.subtitle}</div>
            <div className="truncate text-[11px]" style={{ color: "var(--sol-text-muted)" }} data-role-icon-concept>{drawing ? "Drawing…" : tile.icon ? tile.icon.concept : "Not drawn yet"}</div>
          </figcaption>
        </figure>
      </div>
      {redraw.rationale && !drawing && <p className="text-[11.5px]" style={{ color: "var(--sol-text-muted)" }} data-role-icon-rationale>{redraw.rationale}</p>}
      {preview && (
        <a href={preview} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 35%, transparent)" }} data-role-icon-preview>
          <img src={preview} alt={`${words.subtitle}'s icon beside the other roles' icons`} className="block w-full" />
        </a>
      )}
      {canEdit && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); if (!drawing) setReviewing(true); }}
        >
          <input
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            placeholder="Hint (optional): a server rack"
            aria-label="Hint for the icon"
            maxLength={80}
            className="min-w-0 flex-1 h-8 rounded-md border bg-transparent px-2.5 text-[12.5px] outline-none focus:border-sol-violet"
            style={{ borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)", color: "var(--sol-text)" }}
          />
          <button
            type="submit"
            disabled={drawing}
            className="shrink-0 h-8 px-3 rounded-md text-[12.5px] font-medium border transition-colors hover:bg-sol-bg-highlight disabled:opacity-50"
            style={{ borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)", color: "var(--sol-text)" }}
            data-role-icon-redraw
          >
            {tile.icon ? "Redraw" : "Draw"}
          </button>
        </form>
      )}
      {reviewing && (
        <SwitchReview
          ledger={redrawIconLedger({ title: words.subtitle, handle: role.handle, concept: tile.icon?.concept ?? null, hint: hint.trim() || null })}
          onClose={() => setReviewing(false)}
          onConfirm={() => { setReviewing(false); redraw.run(role._id, hint.trim() || undefined); setHint(""); }}
        />
      )}
    </div>
  );
}
