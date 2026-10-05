import { createContext, useSyncExternalStore } from 'react';
import { StyleProp, StyleSheet, TextStyle } from 'react-native';

// JetBrains Mono is the app face, same as web (web aliases font-sans to it —
// the entire product renders in mono). Every face here is loaded in
// app/_layout.tsx under these exact keys; expo-font registers each key as its
// own single-face family, so weight selection CANNOT happen through
// fontWeight — the style resolver below swaps the family per weight instead.
export const Mono = {
  regular: 'JetBrainsMono',
  medium: 'JetBrainsMono-Medium',
  semiBold: 'JetBrainsMono-SemiBold',
  bold: 'JetBrainsMono-Bold',
  italic: 'JetBrainsMono-Italic',
} as const;

const MONO_FAMILIES = new Set<string>([...Object.values(Mono), 'SpaceMono']);

/** One typeface as single-face families per weight, the shape Mono has. */
export type FaceSet = { readonly [K in keyof typeof Mono]: string };

/**
 * The typeface a subtree sets its unstyled text in. Absent, it is Mono. A
 * surface with its own voice (the assistant lane, app/(simple)) provides its
 * faces here, so every Themed Text under it, the markdown renderer's nested
 * bold included, resolves weights into that face. A style that names a
 * family keeps it: an explicit mono family (a code block) stays mono.
 */
export const FaceContext = createContext<FaceSet | null>(null);

/**
 * The colour a subtree sets its uncoloured text in. Absent, it is the app
 * palette's text colour. Every Themed Text paints a colour, so a nested one
 * (a plain run inside a markdown paragraph) would repaint the app's colour
 * over the paragraph's; a surface with its own palette (the assistant lane)
 * names its ink here so nested runs keep it.
 */
export const InkContext = createContext<string | null>(null);

// Medium, Bold and Italic load after first paint (app/_layout.tsx). Text laid
// out in a face that is not registered yet is measured in the system font and
// then drawn in the wider mono face without being measured again, which
// clipped labels ("Inbo", "Inb…"). Until they land, each late face resolves
// to the nearest face already loaded; the flip re-renders every Text, and the
// changed family makes it measure again.
let lateFacesLoaded = false;
const lateListeners = new Set<() => void>();
export function markLateFacesLoaded(): void {
  if (lateFacesLoaded) return;
  lateFacesLoaded = true;
  lateListeners.forEach((l) => l());
}
export function useLateFacesLoaded(): boolean {
  return useSyncExternalStore(
    (l) => { lateListeners.add(l); return () => { lateListeners.delete(l); }; },
    () => lateFacesLoaded,
  );
}
const EARLY_STAND_IN: Record<string, string> = {
  [Mono.bold]: Mono.semiBold,
  [Mono.medium]: Mono.regular,
  [Mono.italic]: Mono.regular,
};
function loadedFace(face: string, late: boolean): string {
  return late ? face : EARLY_STAND_IN[face] ?? face;
}
/** A face for nav-level styles (tab bar, header titles), standing in until the late faces load. */
export function useMonoFace(face: string): string {
  return loadedFace(face, useLateFacesLoaded());
}

function faceFor(weight: TextStyle['fontWeight'], italic: boolean, faces: FaceSet = Mono): string {
  if (italic) return faces.italic;
  const w =
    weight == null || weight === 'normal' ? 400 :
    weight === 'bold' ? 700 :
    Number(weight);
  if (w >= 700) return faces.bold;
  if (w >= 600) return faces.semiBold;
  if (w >= 500) return faces.medium;
  return faces.regular;
}

/**
 * Resolve a Text style to an explicit JetBrains Mono face.
 *
 * The face carries the weight/slant, and fontWeight/fontStyle are stripped
 * from the result: iOS matches (family, weight) against faces registered in
 * the family, and a runtime-loaded alias family has exactly one face — asking
 * it for weight 600 silently falls back to the system font.
 *
 * A style that names a non-mono fontFamily is respected untouched (minus
 * nothing); legacy 'SpaceMono'/'JetBrainsMono' families are re-resolved so
 * their fontWeight finally renders as a real face.
 */
export function monoStyle(style: StyleProp<TextStyle>, late = lateFacesLoaded, faces?: FaceSet | null): TextStyle {
  const flat = StyleSheet.flatten(style) ?? {};
  if (flat.fontFamily && !MONO_FAMILIES.has(flat.fontFamily)) return flat;
  const { fontWeight, fontStyle, ...rest } = flat;
  // A subtree's own faces apply only to text that names no family.
  if (faces && !flat.fontFamily) return { ...rest, fontFamily: faceFor(fontWeight, fontStyle === 'italic', faces) };
  return { ...rest, fontFamily: loadedFace(faceFor(fontWeight, fontStyle === 'italic'), late) };
}
