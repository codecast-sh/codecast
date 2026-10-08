// What a role is and what carries it, at hover size (cohesive build spec
// §5.4, D14). With the org tree in the store it is the role's summary: the
// same head its sheet and its line say (whom it reports to, its state, what
// it carries, since when), the goals it serves and how much carries it. On a
// page that never loaded the tree, `org.roleCard` (enrichment, never the
// surface) says the same facts as far as it knows them; with neither, the
// caller's face and name stand alone. Nothing here reads the store but the
// summary, so the card can never say something the sheet does not.
import type { ReactNode } from "react";
import { autonomyOn } from "@codecast/shared/contracts/roleAutonomy";
import { isAvatarKey, defaultAvatarFor } from "@codecast/shared/contracts/orgAvatars";
import { RoleSummary, SummaryFrame } from "../org/lines/ObjectSummary";
import { RoleAvatar } from "../org/avatars";
import { roleWords } from "../org/orgStaffingTypes";
import type { OrgRole } from "../org/orgTypes";
import type { RoleCardAnswer } from "../../lib/roleScope";

const DIM = "var(--sol-text-dim)";

/** What the caller already knows about the role: enough for a face and a name. */
export type RoleKnown = { _id?: string; short_id: string; name: string; handle: string; avatar?: string | null; given_name?: string | null; status?: string | null };

export function RoleScopeView({ role, treeRole, card }: { role: RoleKnown; treeRole: OrgRole | null; card: (RoleCardAnswer & { avatar?: string; status?: string; trust?: string }) | null | undefined }) {
  if (treeRole) return <div data-role-scope="tree"><RoleSummary role={treeRole} /></div>;
  const r = card ?? role;
  const avatar = isAvatarKey(r.avatar ?? undefined) ? (r.avatar as string) : defaultAvatarFor(r.handle);
  const charter = card?.charter?.split("\n").map((l) => l.trim()).find(Boolean) ?? null;
  // Named as the map names it when its id is known (the name hashes from it); else by its title and handle.
  const id = card?._id ?? role._id;
  const words = id ? roleWords({ _id: id, name: r.name, handle: r.handle, avatar: r.avatar, given_name: (r as RoleKnown).given_name ?? role.given_name }) : null;
  const status = r.status && r.status !== "active" ? r.status : null;
  const facts = {
    owner: card?.reports_to ? <span className="truncate" style={{ color: "var(--sol-text-muted)" }} data-role-reports-to>↳ {card.reports_to.name}</span> : null,
    state: status ? <span style={{ color: "var(--sol-yellow)" }}>{status}</span> : card?.trust ? <span style={{ color: DIM }}>{autonomyOn(card.trust) ? "starts work on its own" : "reads and recommends"}</span> : null,
    measure: charter ? <span className="truncate" style={{ color: DIM }} title={charter} data-role-carries>{charter}</span> : null,
    date: null,
  };
  return (
    <div data-role-scope={card ? "card" : "face"}>
      <SummaryFrame
        kind="role"
        glyph={<RoleAvatar avatar={avatar} size={18} title={r.name} />}
        title={words?.name ?? r.name}
        sub={words?.subtitle ?? null}
        idRef={words ? null : `@${r.handle}`}
        facts={facts}
        serves={[]}
        carried={card ? { label: "Carries", names: card.scope.projects.map((p) => p.title) } : null}
      />
    </div>
  );
}

/** A label over its section, the way a role's template sections set theirs. */
export function Section({ label, name, children }: { label: string; name: string; children: ReactNode }) {
  return (
    <section data-scope-section={name}>
      <h3 className="px-2.5 mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-sol-text-dim" data-scope-label={name}>{label}</h3>
      {children}
    </section>
  );
}
