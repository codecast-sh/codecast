/** The lucide-react export that draws a mod's icon, from the kebab-case name a
 *  manifest gives ("arrow-down-0-1" → "LucideArrowDown01"). Every name
 *  lucide-react/dynamic accepts, aliases included, is exported as
 *  `Lucide<PascalName>`, and only icons are (components/mods/ModIcon). */
export const modIconExportName = (name: string) =>
  `Lucide${name.replace(/(^|[-_])([a-z0-9])/g, (_m, _sep, c: string) => c.toUpperCase())}`;
