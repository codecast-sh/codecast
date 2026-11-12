// The shapes a person can draw, in menu order, with their icons. The toolbar's
// shape menu and a selected shape's bar both list these.
import { Circle, Cylinder, Diamond, Hexagon, RectangleHorizontal, Square, Star, Triangle, type LucideIcon } from "lucide-react";

export const SHAPE_CHOICES: { id: string; icon: LucideIcon; label: string }[] = [
  { id: "rect", icon: Square, label: "Rectangle" },
  { id: "ellipse", icon: Circle, label: "Ellipse" },
  { id: "diamond", icon: Diamond, label: "Diamond" },
  { id: "pill", icon: RectangleHorizontal, label: "Pill" },
  { id: "triangle", icon: Triangle, label: "Triangle" },
  { id: "hexagon", icon: Hexagon, label: "Hexagon" },
  { id: "cylinder", icon: Cylinder, label: "Database" },
  { id: "star", icon: Star, label: "Star" },
];

export function shapeChoice(id: unknown) {
  return SHAPE_CHOICES.find((s) => s.id === id) ?? SHAPE_CHOICES[0];
}
