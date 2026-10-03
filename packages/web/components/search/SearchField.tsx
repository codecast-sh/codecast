import type { ReactNode, Ref, ChangeEvent, InputHTMLAttributes } from "react";
import { MenuKeyCaps } from "../KeyboardShortcutsHelp";

/** The magnifier the search field and its folded button both draw. */
export function SearchGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
      />
    </svg>
  );
}

/** The top bar's session search field. Collapsed it is a short pill with the
 *  ⌘/ hint; expanded (focused or holding a query) it widens and lights. In a
 *  slot too tight for a field (`compact`) it hides until expanded, then shows
 *  as a fixed overlay over the header (.tb-search-overlay in globals.css). */
export function SearchField({
  value,
  expanded,
  compact = false,
  hideCaps = false,
  inputRef,
  onChange,
  inputProps,
  children,
}: {
  value: string;
  expanded: boolean;
  compact?: boolean;
  /** The slot is too narrow for the shortcut hint. */
  hideCaps?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
  /** Focus, blur, selection and key handlers for the input. */
  inputProps?: Pick<InputHTMLAttributes<HTMLInputElement>, "onSelect" | "onFocus" | "onBlur" | "onKeyDown">;
  /** Drawn inside the field's box, e.g. the autocomplete list. */
  children?: ReactNode;
}) {
  return (
    <div
      className={`relative w-full min-w-0 transition-[max-width] duration-300 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)] ${
        expanded
          ? compact
            ? "tb-search-overlay"
            : "max-w-[680px]"
          : compact
            ? "hidden"
            : "max-w-[230px]"
      }`}
    >
      <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none">
        <SearchGlyph className={`w-3.5 h-3.5 transition-colors duration-200 ${expanded ? "text-sol-cyan" : "text-sol-text-dim"}`} />
      </div>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={onChange}
        {...inputProps}
        placeholder="Search sessions"
        className={`h-7 w-full pl-8 py-0 bg-sol-bg-alt border rounded-full text-[13px] text-sol-text placeholder:text-sol-text-dim truncate cursor-pointer focus:cursor-text focus:outline-none transition-[border-color,box-shadow,padding] duration-200 ${
          expanded
            ? "pr-3 border-sol-cyan/50 ring-1 ring-sol-cyan/30 shadow-lg shadow-black/10"
            : `${hideCaps ? "pr-3" : "pr-12"} border-transparent hover:bg-sol-bg-highlight`
        }`}
      />
      <div
        className={`absolute inset-y-0 right-0 pr-2.5 items-center pointer-events-none transition-opacity duration-150 ${
          hideCaps ? "hidden" : "flex"
        } ${expanded ? "opacity-0" : "opacity-100"}`}
      >
        <MenuKeyCaps action="search.open" />
      </div>
      {children}
    </div>
  );
}
