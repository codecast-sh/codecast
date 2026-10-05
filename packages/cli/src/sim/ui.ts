/**
 * The simulator's accessibility tree (axe describe-ui) as something an agent can
 * act on: a flat list of elements with their label, value, type and the center
 * point a tap takes, and a lookup by text so `cast sim tap --label "Sign in"`
 * needs no coordinate arithmetic. Coordinates are points, the unit every axe
 * action takes.
 */

import { axe, why } from "./simctl.js";

export interface UiElement {
  type: string;
  label?: string;
  value?: string;
  id?: string;
  frame: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
  depth: number;
  enabled: boolean;
}

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Flatten describe-ui's JSON (an array of root nodes with nested `children`). */
export function flattenUi(raw: unknown): UiElement[] {
  const out: UiElement[] = [];
  const walk = (node: any, depth: number) => {
    if (!node || typeof node !== "object") return;
    const f = node.frame;
    if (f && typeof f.x === "number") {
      out.push({
        type: text(node.type) ?? text(node.role) ?? "Element",
        label: text(node.AXLabel) ?? text(node.title),
        value: text(node.AXValue),
        id: text(node.AXUniqueId),
        frame: { x: f.x, y: f.y, width: f.width, height: f.height },
        center: { x: Math.round(f.x + f.width / 2), y: Math.round(f.y + f.height / 2) },
        depth,
        enabled: node.enabled !== false,
      });
    }
    for (const c of Array.isArray(node.children) ? node.children : []) walk(c, depth + 1);
  };
  for (const root of Array.isArray(raw) ? raw : [raw]) walk(root, 0);
  return out;
}

export function describeUi(udid: string): { raw: unknown; elements: UiElement[] } {
  const r = axe(["describe-ui", "--udid", udid], { timeoutMs: 60_000 });
  if (!r.ok) throw new Error(`describe-ui failed: ${why(r)}`);
  const raw = JSON.parse(r.stdout);
  return { raw, elements: flattenUi(raw) };
}

/** The screen size in points: the root application element's frame. */
export function screenPoints(elements: UiElement[]): { width: number; height: number } | undefined {
  const root = elements.find((e) => e.depth === 0 && e.frame.width > 0);
  return root ? { width: root.frame.width, height: root.frame.height } : undefined;
}

/**
 * Elements whose label, value or id matches `query`: exact (case-insensitive)
 * matches first, then substrings; the root application element never matches.
 */
export function findElements(elements: UiElement[], query: string): UiElement[] {
  const q = query.trim().toLowerCase();
  const fields = (e: UiElement) => [e.label, e.value, e.id].filter(Boolean).map((s) => s!.toLowerCase());
  const candidates = elements.filter((e) => e.depth > 0 || e.type !== "Application");
  const exact = candidates.filter((e) => fields(e).some((f) => f === q));
  return exact.length ? exact : candidates.filter((e) => fields(e).some((f) => f.includes(q)));
}

export function formatElement(e: UiElement, index?: number): string {
  const name = [e.label && `"${e.label}"`, e.value && e.value !== e.label && `value="${e.value}"`, e.id && `id=${e.id}`].filter(Boolean).join(" ");
  const pre = index === undefined ? "" : `[${index}] `;
  return `${"  ".repeat(Math.min(e.depth, 8))}${pre}${e.type}${name ? ` ${name}` : ""}  @${e.center.x},${e.center.y}${e.enabled ? "" : " (disabled)"}`;
}

/** The tree as indented lines, skipping unnamed layout containers that carry nothing to act on. */
export function formatTree(elements: UiElement[]): string[] {
  return elements.filter((e) => e.label || e.value || e.id || e.depth === 0 || /Button|Field|Cell|Switch|Link|Tab/.test(e.type)).map((e) => formatElement(e));
}
