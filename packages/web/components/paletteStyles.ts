// The Cmd+K palette's group and row classes, shared by CommandPalette and any
// surface that composes the same cmdk rows (the marketing hero).
export const groupClass = "px-1.5 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-group-heading]]:text-sol-text-dim/70";
export const itemClass = "flex items-center gap-3 px-2.5 py-2 mx-1 rounded-lg text-sm text-sol-text-muted cursor-pointer data-[selected=true]:bg-sol-cyan/10 data-[selected=true]:text-sol-text";
/** The palette's floating frame. */
export const paletteClass = "w-[min(680px,calc(100vw-24px))] rounded-xl border border-sol-border/80 bg-sol-bg shadow-2xl shadow-black/40 overflow-hidden flex flex-col";
/** The search field in the palette's top bar (PaletteSearchBar). */
export const paletteInputClass = "flex-1 bg-transparent text-[15px] text-sol-text placeholder:text-sol-text-dim/60 outline-none";
