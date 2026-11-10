// A mod's icon by name: any lucide icon a manifest names, in the kebab-case
// lucide-react/dynamic takes ("hard-drive"). The icon set loads as one lazy
// chunk with the first mod icon drawn. lucide-react/dynamic made every icon a
// lazy entry of its own instead, which put its 192 KiB name map in the boot
// graph (the sidebar's mod sections) and split each icon the app imports
// statically into a file of its own: 150 extra requests on every boot.
import { lazy, Suspense } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";
import { modIconExportName } from "../../lib/mods/iconName";

type ModIconProps = LucideProps & { name: string };

const IconByName = lazy(async () => {
  const icons = (await import("lucide-react")) as unknown as Record<string, LucideIcon | undefined>;
  function IconByName({ name, ...props }: ModIconProps) {
    const Icon = icons[modIconExportName(name)];
    return Icon ? <Icon {...props} /> : null;
  }
  return { default: IconByName };
});

/** Draws nothing until the icon set has loaded, as lucide-react/dynamic's
 *  DynamicIcon did until its icon had, and nothing for a name that is no icon. */
export function DynamicIcon(props: ModIconProps) {
  return (
    <Suspense fallback={null}>
      <IconByName {...props} />
    </Suspense>
  );
}
