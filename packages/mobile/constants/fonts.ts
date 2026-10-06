import { useSyncExternalStore } from 'react';
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

function faceFor(weight: TextStyle['fontWeight'], italic: boolean): string {
  if (italic) return Mono.italic;
  const w =
    weight == null || weight === 'normal' ? 400 :
    weight === 'bold' ? 700 :
    Number(weight);
  if (w >= 700) return Mono.bold;
  if (w >= 600) return Mono.semiBold;
  if (w >= 500) return Mono.medium;
  return Mono.regular;
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
export function monoStyle(style: StyleProp<TextStyle>, late = lateFacesLoaded): TextStyle {
  const flat = StyleSheet.flatten(style) ?? {};
  if (flat.fontFamily && !MONO_FAMILIES.has(flat.fontFamily)) return flat;
  const { fontWeight, fontStyle, ...rest } = flat;
  return { ...rest, fontFamily: loadedFace(faceFor(fontWeight, fontStyle === 'italic'), late) };
}
