// The palette's Mods group: every running mod's panes (open them) and
// commands (run them, no page change), matched by the mod's name and keywords.

import { Command as CommandPrimitive } from "cmdk";
import { DynamicIcon } from "lucide-react/dynamic";
import { toast } from "sonner";
import { modHost } from "../../lib/mods/host";
import { useModHostVersion } from "../../lib/mods/useMods";

export function ModPaletteGroup({ groupClass, itemClass, navigate, close, query }: { groupClass: string; itemClass: string; navigate: (path: string) => void; close: () => void; query: string }) {
  useModHostVersion();
  const runtimes = modHost.all().filter((r) => r.status !== "failed");
  const items = runtimes.flatMap((rt) => {
    const m = rt.row.manifest;
    const modTitle = rt.row.title ?? rt.row.name;
    const panes = (m.panes ?? []).map((p) => ({
      key: `mod-pane-${rt.row.name}-${p.id}`,
      label: (m.panes?.length ?? 0) > 1 ? `${modTitle}: ${p.title}` : p.title === modTitle ? modTitle : `${modTitle}: ${p.title}`,
      icon: p.icon ?? m.icon ?? "blocks",
      value: `${modTitle} ${p.title} ${rt.row.name} mod pane ${p.description ?? ""}`,
      run: () => navigate(`/m/${rt.row.name}/${p.id}`),
    }));
    const commands = (m.commands ?? []).map((c) => ({
      key: `mod-cmd-${rt.row.name}-${c.id}`,
      label: c.title,
      icon: c.icon ?? m.icon ?? "sparkles",
      value: `${c.title} ${c.keywords ?? ""} ${modTitle} ${rt.row.name} mod command`,
      run: () => {
        close();
        void rt.command(c.id).then((err) => { if (err) toast.error(`${modTitle}: ${err.split("\n")[0]}`); });
      },
    }));
    return [...panes, ...commands];
  });
  if (!items.length) return null;
  // Unasked, the group shows a few; a typed query searches all of them.
  const shown = query.trim() ? items : items.slice(0, 4);
  return (
    <CommandPrimitive.Group heading="Mods" className={groupClass}>
      {shown.map((it) => (
        <CommandPrimitive.Item key={it.key} value={it.value} onSelect={it.run} className={itemClass}>
          <DynamicIcon name={it.icon as any} className="w-4 h-4 flex-shrink-0 text-sol-violet" />
          <span className="truncate flex-1">{it.label}</span>
        </CommandPrimitive.Item>
      ))}
    </CommandPrimitive.Group>
  );
}
