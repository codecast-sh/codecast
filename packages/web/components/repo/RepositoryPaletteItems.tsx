import { Command } from "cmdk";
import { FolderGit2 } from "lucide-react";
import { useRepositories } from "../../hooks/useRepoBrowse";
import { repositoryJump } from "../../lib/repoNavigation";
import { repoHomeHref } from "../../lib/repoView";

export function RepositoryPaletteItems({ query, navigate, itemClass, groupClass }: { query: string; navigate: (href: string) => void; itemClass: string; groupClass: string }) {
  const { rows } = useRepositories();
  const jump = repositoryJump(query);
  const needle = query.trim().toLowerCase();
  const matches = needle ? rows.filter(row => row.repository.toLowerCase().includes(needle) && row.repository !== jump?.repository).slice(0, 8) : [];
  if (!jump && !matches.length) return null;
  return <Command.Group heading="Code" className={groupClass}>
    {jump && <Command.Item value={`__entity__ code ${jump.href}`} onSelect={() => navigate(jump.href)} className={itemClass}><FolderGit2 className="w-4 h-4 shrink-0" /><span className="truncate">Browse {jump.label}</span></Command.Item>}
    {matches.map(row => <Command.Item key={row.repository} value={`__entity__ repository ${row.repository}`} onSelect={() => navigate(repoHomeHref(row.repository))} className={itemClass}><FolderGit2 className="w-4 h-4 shrink-0" /><span className="truncate">{row.repository}</span></Command.Item>)}
  </Command.Group>;
}
