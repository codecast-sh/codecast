import { useSyncExternalStore } from 'react';
import { StyleProp, StyleSheet, TextStyle } from 'react-native';

// JetBrains Mono is the app face, same as web (web aliases font-sans to it —
// the entire product renders in mono). Each face is named by its PostScript
// name: the binary embeds the files (the expo-font plugin in
// app.json), and app/_layout.tsx loads them under the same names on binaries
// built before that. A runtime-loaded face is its own single-face family, so
// weight selection CANNOT rely on fontWeight; the style resolver below swaps
// the face per weight instead.
export const Mono = {
  regular: 'JetBrainsMono-Regular',
  medium: 'JetBrainsMono-Medium',
  semiBold: 'JetBrainsMono-SemiBold',
  bold: 'JetBrainsMono-Bold',
  italic: 'JetBrainsMono-Italic',
} as const;

// Medium, Bold and Italic load after first paint (app/_layout.tsx). Text laid
// out in a face that is not registered yet is measured in the system font and
// then drawn in the wider mono face without being measured again, which
// clipped labels ("Inbo", "Inb…"). Until they land, each late face resolves
// to the nearest face already loaded; the flip re-renders every Text, and the
// changed family makes it measure again.
let lateFacesLoaded = false;
const lateListeners = new Set<() => void>();
function notifyFaces(): void {
  lateListeners.forEach((l) => l());
}
export function markLateFacesLoaded(): void {
  if (lateFacesLoaded) return;
  lateFacesLoaded = true;
  notifyFaces();
}
function facesKey(): boolean {
  return lateFacesLoaded;
}
function subscribeFaces(l: () => void): () => void {
  lateListeners.add(l);
  return () => { lateListeners.delete(l); };
}
/** Re-renders when the late mono faces land; returns whether they have. */
export function useLateFacesLoaded(): boolean {
  return useSyncExternalStore(subscribeFaces, facesKey);
}
const EARLY_STAND_IN: Record<string, string> = {
  [Mono.bold]: Mono.semiBold,
  [Mono.medium]: Mono.regular,
  [Mono.italic]: Mono.regular,
};
function loadedFace(face: string, late: boolean): string {
  return late ? face : EARLY_STAND_IN[face] ?? face;
}

/** A face for nav-level styles (tab bar, header titles), standing in until
 *  the late faces load. Nav styles cannot go through the Text wrapper, so
 *  they name the face themselves. */
export function useMonoFace(face: string): string {
  return uiFace(face, useLateFacesLoaded());
}
export function uiFace(face: string, late = lateFacesLoaded): string {
  return loadedFace(face, late);
}

const MONO_FACES = new Set<string>(Object.values(Mono));

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
 * Resolve a Text style to an explicit face.
 *
 * The face carries the weight/slant, and fontWeight/fontStyle are stripped
 * from the result: iOS matches (family, weight) against faces registered in
 * the family, and a runtime-loaded alias family has exactly one face — asking
 * it for weight 600 silently falls back to the system font.
 *
 * A style with no fontFamily, or one naming a JetBrains Mono face, gets the
 * mono face for its weight. Any other family is respected untouched.
 */
export function monoStyle(style: StyleProp<TextStyle>, late = lateFacesLoaded): TextStyle {
  const flat = StyleSheet.flatten(style) ?? {};
  if (flat.fontFamily && !MONO_FACES.has(flat.fontFamily)) return flat;
  const { fontWeight, fontStyle, ...rest } = flat;
  return { ...rest, fontFamily: loadedFace(faceFor(fontWeight, fontStyle === 'italic'), late) };
}
