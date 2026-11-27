// A repository's face: its drawn icon on a role tile (convex/repoIcons.ts),
// or, until the server has drawn one, the first letter of its name on a tile
// in the color the server settled for it (the name's own pick before the
// first answer), which the drawing then wears. Reads the store only and never asks for a
// drawing (a personal run that records a deploy asks); the surface listing repositories mounts useSyncRepoIcons once.
import { pickRoleIconAccent } from "@codecast/shared/contracts/roleIcon";
import { RoleIconTile } from "../identity/RoleIconTile";
import { useRepoIcon } from "../../hooks/useSyncRepoIcons";

export function RepoFace({ workspace, repository, size = 20 }: {
  /** The workspace the repository's face lives in: `user:<id>` or `team:<id>`. */
  workspace: string;
  /** `owner/name`, any case. */
  repository: string;
  size?: number | string;
}) {
  const repo = repository.trim().toLowerCase();
  const name = repository.trim().split("/").pop() || repository;
  const row = useRepoIcon(workspace, repo);
  const icon = row?.icon ?? null;
  return (
    <RoleIconTile
      tile={{ icon, monogram: (name.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase(), accent: icon?.accent ?? row?.accent ?? pickRoleIconAccent([], repo), title: name }}
      size={size}
      title={name}
    />
  );
}

/** A project named on a card: its face and its name, the repository's part after the owner. */
export function RepoTag({ workspace, repository }: { workspace: string; repository: string }) {
  return (
    <span className="dpp-tag" data-deploy-project={repository.toLowerCase()}>
      <RepoFace workspace={workspace} repository={repository} size={16} />
      <span className="dpp-tag-name">{repository.split("/").pop() || repository}</span>
    </span>
  );
}
