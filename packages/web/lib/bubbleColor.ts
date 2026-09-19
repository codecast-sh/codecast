// The color of your own messages in the Minimal style. One hue is stored
// (`clientState.ui.user_bubble_color`: a preset id or a #rrggbb hex) and the
// bubble fill is mixed from it in CSS against the page background, so the same
// choice reads as a pastel on the light page and a deep tint on the dark one,
// and the text inside keeps the page's own text color.

export type BubblePreset = { id: string; label: string; hue: string };

export const BUBBLE_PRESETS: BubblePreset[] = [
  { id: "blue", label: "Blue", hue: "#2f7df6" },
  { id: "green", label: "Green", hue: "#5fa617" },
  { id: "teal", label: "Teal", hue: "#0f9f92" },
  { id: "violet", label: "Violet", hue: "#7a5af0" },
  { id: "rose", label: "Rose", hue: "#e5477f" },
  { id: "amber", label: "Amber", hue: "#e58a00" },
  { id: "graphite", label: "Graphite", hue: "#5b6068" },
];

export const DEFAULT_BUBBLE_PRESET = "blue";

const HEX = /^#[0-9a-f]{6}$/i;

export function isCustomBubbleColor(value: string | undefined): boolean {
  return !!value && HEX.test(value);
}

/** The stored value as a hue. Anything unknown falls back to the default, so a
 *  preset removed later or a malformed value never reaches the stylesheet. */
export function resolveBubbleHue(value: string | undefined): string {
  if (value && HEX.test(value)) return value.toLowerCase();
  const preset = BUBBLE_PRESETS.find((p) => p.id === value) ?? BUBBLE_PRESETS.find((p) => p.id === DEFAULT_BUBBLE_PRESET)!;
  return preset.hue;
}

export const BUBBLE_HUE_VAR = "--cc-user-bubble-hue";
