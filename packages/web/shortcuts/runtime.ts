import { createShortcutProvider, type KeydownOptions, type ShortcutCatalog, type ShortcutProviderKit } from "@platform/keys";

export interface ShortcutRuntime<A extends string> {
  catalog: ShortcutCatalog<A>;
  options: KeydownOptions<A>;
  kit: ShortcutProviderKit<A>;
}

export function createShortcutRuntime<A extends string>(
  catalog: ShortcutCatalog<A>,
  options: KeydownOptions<A>,
  previous?: ShortcutRuntime<A>,
): ShortcutRuntime<A> {
  if (previous) {
    Object.assign(previous.catalog, catalog);
    for (const key of Object.keys(previous.options) as (keyof KeydownOptions<A>)[]) delete previous.options[key];
    Object.assign(previous.options, options);
    return previous;
  }
  return { catalog, options, kit: createShortcutProvider(catalog, options) };
}
