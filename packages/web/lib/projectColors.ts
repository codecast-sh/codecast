import { getLabelColor } from "./labelColors";

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

/**
 * The swatch for a project marker. An explicit colour wins; otherwise the title
 * is hashed to a stable one — the same rule the workspace rows follow, and what
 * keeps a rail of projects distinguishable when nobody has picked colours. A
 * shared prefix ("Codecast: …") truncates to the same few characters, so the
 * swatch is doing the telling-apart, not the text.
 */
export function projectDotClass(project: { color?: string; title?: string }): string {
  if (project.color) return projectColorClass(project.color);
  return getLabelColor(project.title || "").dot;
}
