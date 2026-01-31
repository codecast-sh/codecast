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
