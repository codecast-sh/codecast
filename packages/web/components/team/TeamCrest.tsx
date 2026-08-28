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
  return (
    <div
      key={`${icon}-${color}`}
      className={cn(
        "relative flex items-center justify-center shrink-0 overflow-hidden motion-safe:animate-in motion-safe:zoom-in-95 motion-safe:duration-200",
        s.tile,
        className,
      )}
    >
      <div className={cn("absolute inset-0 opacity-20", bg)} />
      <TeamIcon icon={icon} color={color} className={cn("relative", s.icon)} />
    </div>
  );
}
