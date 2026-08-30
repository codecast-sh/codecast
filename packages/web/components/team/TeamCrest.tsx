import { TeamIcon, colorBgClassMap, type TeamColorName } from "../TeamIcon";
import { cn } from "../../lib/utils";

export type TeamCrestSize = "sm" | "md" | "lg";

const SIZE_CLASSES: Record<TeamCrestSize, { tile: string; icon: string }> = {
  sm: { tile: "w-6 h-6 rounded-md", icon: "w-3.5 h-3.5" },
  md: { tile: "w-9 h-9 rounded-lg", icon: "w-5 h-5" },
  lg: { tile: "w-16 h-16 rounded-2xl", icon: "w-8 h-8" },
};

interface TeamCrestProps {
  icon?: string | null;
  color?: string | null;
  size?: TeamCrestSize;
  className?: string;
}

/** The team icon on a tinted tile. One crest for the switcher, sidebar, settings and create flow. */
export function TeamCrest({ icon, color, size = "md", className }: TeamCrestProps) {
  const s = SIZE_CLASSES[size];
  const bg = color && color in colorBgClassMap ? colorBgClassMap[color as TeamColorName] : "bg-sol-base01";
  // The tile itself never remounts: a color change re-tints through the
  // background and text color transitions, so the halo and wash around it
  // (transitions on ancestors) stay in sync. Only an icon change replays
  // the small zoom, keyed on the icon alone.
  return (
    <div
      className={cn(
        "relative flex items-center justify-center shrink-0 overflow-hidden",
        s.tile,
        className,
      )}
    >
      <div className={cn("absolute inset-0 opacity-20 transition-colors duration-300", bg)} />
      <span
        key={icon}
        className="relative flex motion-safe:animate-in motion-safe:zoom-in-90 motion-safe:fade-in motion-safe:duration-200"
      >
        <TeamIcon icon={icon} color={color} className={cn("transition-colors duration-300", s.icon)} />
      </span>
    </div>
  );
}
