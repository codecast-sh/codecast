"use client";
// Picking a color theme: every theme as a small picture of the app in it,
// painted from the theme's own palette in the mode on screen, so the choice
// is made by looking. A press applies it at once (ThemeProvider puts the
// variables on the root); nothing to confirm or save.

import type { CSSProperties } from "react";
import Link from "next/link";
import { Check, Plus } from "lucide-react";
import type { ThemePalette } from "@codecast/shared/contracts/theme";
import { cn } from "../../lib/utils";
import { useInboxStore } from "../../store/inboxStore";
import { useColorThemes } from "../../hooks/useColorThemes";
import { ORIGINAL_COLOR_THEME, type ThemeChoice } from "../../lib/theme/colorTheme";
import { ORIGINAL_PREVIEW } from "../../lib/theme/builtinThemes";
import { useTheme } from "../ThemeProvider";

/** The palettes a theme paints, by mode; a mode it leaves out is codecast's own look. */
function usePreviewPalettes(choice: ThemeChoice): Record<"light" | "dark", ThemePalette> & { shown: ThemePalette } {
  const { theme: shown, visualStyle } = useTheme();
  const of = (mode: "light" | "dark") => (choice.key === ORIGINAL_COLOR_THEME ? undefined : choice.theme[mode]) ?? ORIGINAL_PREVIEW[visualStyle][mode];
  const light = of("light"), dark = of("dark");
  return { light, dark, shown: shown === "dark" ? dark : light };
}

const ACCENTS = ["red", "amber", "green", "blue", "violet"] as const;

/** A miniature of the app in a palette: sidebar, a card with its text, and the accents. */
export function ThemePreview({ palette, className }: { palette: ThemePalette; className?: string }) {
  const p = (token: keyof ThemePalette, fallback: string) => palette[token] ?? fallback;
  return (
    <div
      aria-hidden
      className={cn("flex overflow-hidden", className)}
      style={{ background: p("bg", "#fff") }}
    >
      <div className="flex w-[24%] flex-col gap-[3px] px-[5px] py-[7px]" style={{ background: p("bg-alt", "#eee") }}>
        <span className="h-[3px] w-full rounded-full" style={{ background: p("text-muted", "#888"), opacity: 0.55 }} />
        <span className="h-[3px] w-3/4 rounded-full" style={{ background: p("text-muted", "#888"), opacity: 0.35 }} />
        <span className="h-[3px] w-4/5 rounded-full" style={{ background: p("text-muted", "#888"), opacity: 0.35 }} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-between p-[6px]">
        <div className="rounded-[3px] border px-[5px] py-[4px]" style={{ background: p("card", "#fff"), borderColor: p("border", "#ccc") }}>
          <span className="block h-[3px] w-3/5 rounded-full" style={{ background: p("text", "#000") }} />
          <span className="mt-[3px] block h-[3px] w-11/12 rounded-full" style={{ background: p("text-muted", "#888"), opacity: 0.7 }} />
        </div>
        <div className="flex gap-[3px]">
          {ACCENTS.map((a) => <span key={a} className="h-[6px] w-[6px] rounded-full" style={{ background: p(a, "#888") }} />)}
        </div>
      </div>
    </div>
  );
}

function ThemeTile({ choice, checked, onChoose }: { choice: ThemeChoice; checked: boolean; onChoose: () => void }) {
  const { light, dark } = usePreviewPalettes(choice);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onChoose}
      className={cn(
        "group flex flex-col overflow-hidden rounded-lg border text-left transition-[border-color,box-shadow] duration-150",
        checked ? "border-sol-text shadow-[0_0_0_1px_var(--sol-text)]" : "border-sol-border/60 hover:border-sol-text-muted",
      )}
    >
      <span className="flex h-[58px] w-full">
        <ThemePreview palette={light} className="h-full flex-1" />
        <ThemePreview palette={dark} className="h-full flex-1" />
      </span>
      <span className="flex items-center gap-1.5 border-t border-sol-border/40 bg-sol-card px-2.5 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs text-sol-text">{choice.theme.title}</span>
        {choice.modTitle && <span className="max-w-[45%] truncate text-[10px] text-sol-text-dim">{choice.modTitle}</span>}
        {checked && <Check className="h-3 w-3 shrink-0 text-sol-text" />}
      </span>
    </button>
  );
}

export function ThemePicker() {
  const { themes, current, choose } = useColorThemes();
  const updateUI = useInboxStore((s) => s.updateClientUI);
  return (
    <div>
      <div role="radiogroup" aria-label="Color theme" className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
        {themes.map((t) => <ThemeTile key={t.key} choice={t} checked={t.key === current} onChoose={() => { choose(t.key); updateUI({ theme_intro_seen: true }); }} />)}
      </div>
      <Link href="/mods" className="mt-2.5 inline-flex items-center gap-1 text-xs text-sol-text-muted transition-colors hover:text-sol-text">
        <Plus className="h-3 w-3" />
        Make your own
      </Link>
    </div>
  );
}

/** A small round swatch for a theme, for tight spaces (the intro card). */
export function ThemeDot({ choice, checked, onChoose }: { choice: ThemeChoice; checked: boolean; onChoose: () => void }) {
  const palette = usePreviewPalettes(choice).shown;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={choice.theme.title}
      title={choice.theme.title}
      onClick={onChoose}
      className={cn(
        "relative h-6 w-6 shrink-0 overflow-hidden rounded-full border transition-transform duration-150 active:scale-95",
        checked ? "border-sol-text shadow-[0_0_0_2px_var(--sol-card),0_0_0_3px_var(--sol-text)]" : "border-sol-border/70 hover:scale-105",
      )}
      style={{ background: palette.bg } as CSSProperties}
    >
      <span className="absolute inset-y-0 right-0 w-1/2" style={{ background: palette.card }} />
      <span className="absolute bottom-[4px] left-[4px] h-[6px] w-[6px] rounded-full" style={{ background: palette.link ?? palette.blue }} />
    </button>
  );
}
