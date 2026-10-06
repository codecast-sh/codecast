// A top-level page's title, with an optional muted count and lede beside it.
// One component, so every page that names itself does it the same way; in
// hosted mode globals.css sets the title in the family's reading face (the
// serif Whisk titles its pages with) and keeps the count in the interface face.
export function PageHeading({ title, count, lede }: {
  title: string;
  /** How many things the page lists, said quietly after the title. */
  count?: number;
  /** One line about the page, shown from the small breakpoint up. */
  lede?: string;
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <h1 data-cc-page-title className="whitespace-nowrap text-lg font-semibold text-sol-text">{title}</h1>
      {count !== undefined ? <span data-cc-page-count className="shrink-0 text-[13px] tabular-nums text-sol-text-dim">{count}</span> : null}
      {lede ? <span className="hidden min-w-0 truncate text-xs text-sol-text-dim sm:inline">{lede}</span> : null}
    </div>
  );
}
