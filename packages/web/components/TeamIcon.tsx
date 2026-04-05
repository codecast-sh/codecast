import {
  Rocket, Flame, Zap, Star, Diamond, Crown,
  Shield, Sword, Anchor, Compass, Mountain, TreePine,
  Sun, Moon, Cloud, Bolt, Atom, Dna,
  Hexagon, Triangle, Box, Circle, Infinity, Omega,
  Users
} from "lucide-react";

export const TEAM_ICONS = [
  "rocket", "flame", "zap", "star", "diamond", "crown",
  "shield", "sword", "anchor", "compass", "mountain", "tree",
  "sun", "moon", "cloud", "bolt", "atom", "dna",
  "hexagon", "triangle", "cube", "sphere", "infinity", "omega"
] as const;

export const TEAM_COLORS = [
  "cyan", "blue", "violet", "magenta", "green", "yellow", "orange"
] as const;

export type TeamIconName = typeof TEAM_ICONS[number];
export type TeamColorName = typeof TEAM_COLORS[number];

const iconMap: Record<TeamIconName, React.ComponentType<{ className?: string }>> = {
  rocket: Rocket,
  flame: Flame,
  zap: Zap,
  star: Star,
  diamond: Diamond,
  crown: Crown,
  shield: Shield,
  sword: Sword,
  anchor: Anchor,
  compass: Compass,
  mountain: Mountain,
  tree: TreePine,
  sun: Sun,
  moon: Moon,
  cloud: Cloud,
  bolt: Bolt,
  atom: Atom,
  dna: Dna,
  hexagon: Hexagon,
  triangle: Triangle,
  cube: Box,
  sphere: Circle,
  infinity: Infinity,
  omega: Omega,
};

export const colorClassMap: Record<TeamColorName, string> = {
  cyan: "text-sol-cyan",
  blue: "text-sol-blue",
  violet: "text-sol-violet",
  magenta: "text-sol-magenta",
  green: "text-sol-green",
  yellow: "text-sol-yellow",
  orange: "text-sol-orange",
};

export const colorBgClassMap: Record<TeamColorName, string> = {
  cyan: "bg-sol-cyan",
  blue: "bg-sol-blue",
  violet: "bg-sol-violet",
  magenta: "bg-sol-magenta",
  green: "bg-sol-green",
  yellow: "bg-sol-yellow",
  orange: "bg-sol-orange",
};

export function getSessionIconDefaults(id: string): { icon: TeamIconName; color: TeamColorName } {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash |= 0;
  }
  return {
    icon: TEAM_ICONS[Math.abs(hash) % TEAM_ICONS.length],
    color: TEAM_COLORS[Math.abs(hash >> 8) % TEAM_COLORS.length],
  };
}

interface TeamIconProps {
  icon?: string | null;
  color?: string | null;
  className?: string;
}

export function TeamIcon({ icon, color, className }: TeamIconProps) {
  const IconComponent = icon && icon in iconMap
    ? iconMap[icon as TeamIconName]
    : Users;
  const colorClass = color && color in colorClassMap
    ? colorClassMap[color as TeamColorName]
    : "";
  return <IconComponent className={`${colorClass} ${className || ""}`} />;
}

export function IconColorPicker({
  currentIcon,
  currentColor,
  onIconChange,
  onColorChange,
}: {
  currentIcon: TeamIconName;
  currentColor: TeamColorName;
  onIconChange: (icon: string) => void;
  onColorChange: (color: string) => void;
}) {
  return (
    <div onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      <div className="text-xs text-sol-text-dim mb-2">Icon</div>
      <div className="flex flex-wrap gap-1 mb-3">
        {TEAM_ICONS.map((icon) => (
          <button
            key={icon}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onIconChange(icon); }}
            className={`p-1 rounded transition-colors ${
              currentIcon === icon ? "bg-sol-bg-highlight ring-1 ring-sol-base01" : "hover:bg-sol-bg-alt/50"
            }`}
          >
            <TeamIcon icon={icon} color={currentIcon === icon ? currentColor : undefined} className={`w-3.5 h-3.5 ${currentIcon !== icon ? "text-sol-text-dim" : ""}`} />
          </button>
        ))}
      </div>
      <div className="text-xs text-sol-text-dim mb-2">Color</div>
      <div className="flex gap-1.5">
        {TEAM_COLORS.map((color) => (
          <button
            key={color}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onColorChange(color); }}
            className={`w-5 h-5 rounded-full transition-all ${colorBgClassMap[color]} ${
              currentColor === color ? "ring-2 ring-offset-1 ring-offset-sol-bg ring-sol-base1 scale-110" : "hover:scale-105"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
