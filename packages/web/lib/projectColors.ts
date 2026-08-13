/**
 * A project's colour, in one place. The picker, the cards, the sidebar dots and
 * the breadcrumb all render the same swatch, so the mapping lives here rather
 * than being restated per surface.
 */
export const PROJECT_COLORS = [
  { value: "cyan", label: "Cyan", tw: "bg-sol-cyan" },
  { value: "blue", label: "Blue", tw: "bg-sol-blue" },
  { value: "violet", label: "Violet", tw: "bg-sol-violet" },
  { value: "green", label: "Green", tw: "bg-sol-green" },
  { value: "yellow", label: "Yellow", tw: "bg-sol-yellow" },
  { value: "orange", label: "Orange", tw: "bg-sol-orange" },
  { value: "red", label: "Red", tw: "bg-sol-red" },
  { value: "magenta", label: "Magenta", tw: "bg-sol-magenta" },
] as const;

/** Background class for a project's colour; cyan when unset or unknown. */
export function projectColorClass(color?: string): string {
  return PROJECT_COLORS.find((c) => c.value === color)?.tw ?? "bg-sol-cyan";
}
