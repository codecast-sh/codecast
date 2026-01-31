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

export type TeamIconName = typeof TEAM_ICONS[number];

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

interface TeamIconProps {
  icon?: string | null;
  className?: string;
}

export function TeamIcon({ icon, className }: TeamIconProps) {
  const IconComponent = icon && icon in iconMap
    ? iconMap[icon as TeamIconName]
    : Users;
  return <IconComponent className={className} />;
}
