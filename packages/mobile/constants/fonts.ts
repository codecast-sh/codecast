import { useSyncExternalStore } from 'react';
import { StyleProp, StyleSheet, TextStyle } from 'react-native';
import { getActiveLook, useActiveLook, type Look } from '@/constants/Theme';
import { floorTextSize } from '@codecast/shared/render/typeScale';

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

// The Modern look's interface face, the web's: Instrument Sans. Its four
// upright faces are embedded in every 1.0.5 binary (app.json's expo-font
// list); the italic is not, and loads at runtime as an asset of the update
// (lib/modernFaces.ts). Both are named by PostScript name, like Mono.
export const Sans = {
  regular: 'InstrumentSans-Regular',
  medium: 'InstrumentSans-Medium',
  semiBold: 'InstrumentSans-SemiBold',
  bold: 'InstrumentSans-Bold',
  italic: 'InstrumentSans-Italic',
} as const;

/** The style for code-like text: code, commands, paths, branch names,
 *  hashes, ids, machine names and env vars. It names the mono face, so the
 *  run stays mono under Modern, and nested runs inherit it (Themed.tsx). In
 *  Classic it resolves to the face an unnamed style gets, so nothing moves.
 *  lib/modernMono.guard.test.ts holds the code renderers to it. */
export const codeFont = { fontFamily: Mono.regular } as const;

export type FaceGroup = { readonly regular: string; readonly medium: string; readonly semiBold: string; readonly bold: string; readonly italic: string };

const GROUP_OF = new Map<string, FaceGroup>(
  [Mono, Sans].flatMap((g) => Object.values(g).map((face) => [face, g] as [string, FaceGroup])),
);

// Medium, Bold and Italic load after first paint (app/_layout.tsx). Text laid
// out in a face that is not registered yet is measured in the system font and
// then drawn in the wider mono face without being measured again, which
// clipped labels ("Inbo", "Inb…"). Until they land, each late face resolves
// to the nearest face already loaded; the flip re-renders every Text, and the
// changed family makes it measure again. The Sans faces follow the same
// rule: until they are registered, Modern text sets in the system face at its
// weight and slant, a sans close to Instrument Sans.
let lateFacesLoaded = false;
let sansFacesLoaded = false;
let sansItalicLoaded = false;
const lateListeners = new Set<() => void>();
function notifyFaces(): void {
  lateListeners.forEach((l) => l());
}
export function markLateFacesLoaded(): void {
  if (lateFacesLoaded) return;
  lateFacesLoaded = true;
  notifyFaces();
}
/** The four upright Instrument Sans faces are registered. */
export function markSansFacesLoaded(): void {
  if (sansFacesLoaded) return;
  sansFacesLoaded = true;
  notifyFaces();
}
/** Instrument Sans Italic is registered. */
export function markSansItalicLoaded(): void {
  if (sansItalicLoaded) return;
  sansItalicLoaded = true;
  notifyFaces();
}
function facesKey(): number {
  return (lateFacesLoaded ? 1 : 0) + (sansFacesLoaded ? 2 : 0) + (sansItalicLoaded ? 4 : 0);
}
function subscribeFaces(l: () => void): () => void {
  lateListeners.add(l);
  return () => { lateListeners.delete(l); };
}
/** Re-renders when any face lands; returns whether the late mono faces have. */
export function useLateFacesLoaded(): boolean {
  useSyncExternalStore(subscribeFaces, facesKey);
  return lateFacesLoaded;
}
/** Changes each time a group of faces lands, for a memo over nav-level faces. */
export function useFacesVersion(): number {
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

function sansLoaded(face: string): boolean {
  return face === Sans.italic ? sansItalicLoaded : sansFacesLoaded;
}

/** A face for nav-level styles (tab bar, header titles), in the active look,
 *  standing in until the late faces load. Nav styles cannot go through the
 *  Text wrapper, so they name the face themselves. Under Modern a Mono face
 *  becomes Instrument Sans at the same weight ('System' until it lands). */
export function useMonoFace(face: string): string {
  const late = useLateFacesLoaded();
  const look = useActiveLook();
  return uiFace(face, late, look);
}
export function uiFace(face: string, late = lateFacesLoaded, look: Look = getActiveLook()): string {
  if (look !== 'modern') return loadedFace(face, late);
  const key = (Object.keys(Mono) as (keyof typeof Mono)[]).find((k) => Mono[k] === face);
  if (!key) return loadedFace(face, late);
  return sansLoaded(Sans[key]) ? Sans[key] : 'System';
}

/** The face group a style names outright, for nested text to inherit (a bold
 *  run inside mono code stays mono under Modern). Undefined when the style
 *  names none, or a family outside the groups. */
export function namedFaceGroup(style: StyleProp<TextStyle>): FaceGroup | undefined {
  const family = StyleSheet.flatten(style)?.fontFamily;
  return family ? GROUP_OF.get(family) : undefined;
}

const MONO_FACES = new Set<string>(Object.values(Mono));

function faceFor(weight: TextStyle['fontWeight'], italic: boolean, group: FaceGroup = Mono): string {
  if (italic) return group.italic;
  const w =
    weight == null || weight === 'normal' ? 400 :
    weight === 'bold' ? 700 :
    Number(weight);
  if (w >= 700) return group.bold;
  if (w >= 600) return group.semiBold;
  if (w >= 500) return group.medium;
  return group.regular;
}

/**
 * Resolve a Text style to an explicit face.
 *
 * The face carries the weight/slant, and fontWeight/fontStyle are stripped
 * from the result: iOS matches (family, weight) against faces registered in
 * the family, and a runtime-loaded alias family has exactly one face — asking
 * it for weight 600 silently falls back to the system font.
 *
 * Classic: a style with no fontFamily, or one naming a JetBrains Mono face,
 * gets the mono face for its weight. Any other family is respected untouched.
 *
 * Modern: a style with no fontFamily takes the group of the Text it is nested
 * in (`inherited`, as CSS inherits a font), else Instrument Sans, by weight
 * and slant. A style naming a face of a known group (Mono, Sans) keeps that
 * group, so code that names Mono stays mono. Any other family is untouched.
 * Modern also holds sizes to the type scale's floor (@codecast/shared/render
 * /typeScale): under 12 rises to 12, except capitals (`textTransform:
 * 'uppercase'`, or `caps` for a run whose words are capitals), which may sit
 * at 11.
 */
export function monoStyle(style: StyleProp<TextStyle>, late = lateFacesLoaded, look: Look = getActiveLook(), inherited?: FaceGroup, caps = false): TextStyle {
  const flat = StyleSheet.flatten(style) ?? {};
  if (look === 'modern') return modernStyle(flat, late, inherited, caps);
  if (flat.fontFamily && !MONO_FACES.has(flat.fontFamily)) return flat;
  const { fontWeight, fontStyle, ...rest } = flat;
  return { ...rest, fontFamily: loadedFace(faceFor(fontWeight, fontStyle === 'italic'), late) };
}

function modernStyle(style: TextStyle, late: boolean, inherited: FaceGroup | undefined, caps: boolean): TextStyle {
  const group = style.fontFamily ? GROUP_OF.get(style.fontFamily) : inherited ?? Sans;
  if (!group) return style;
  const flat = floored(style, caps || style.textTransform === 'uppercase');
  const { fontWeight, fontStyle, ...rest } = flat;
  const face = faceFor(fontWeight, fontStyle === 'italic', group);
  if (group === Mono) return { ...rest, fontFamily: loadedFace(face, late) };
  if (sansLoaded(face)) return { ...rest, fontFamily: face };
  // Not registered yet: the system face, which has real weights and slants.
  const { fontFamily: _unloaded, ...system } = flat;
  return system;
}

function floored(style: TextStyle, caps: boolean): TextStyle {
  const lineHeight = typeof style.lineHeight === 'number' ? style.lineHeight : undefined;
  const next = floorTextSize(style.fontSize, lineHeight, caps);
  if (next.fontSize === style.fontSize) return style;
  return lineHeight === undefined ? { ...style, fontSize: next.fontSize } : { ...style, fontSize: next.fontSize, lineHeight: next.lineHeight };
}

/** Whether a run's words are set in capitals ("PLAN", "410 GONE"), which the
 *  floor lets sit at 11 like a `textTransform: 'uppercase'` label. */
export function isCapsText(children: unknown): boolean {
  const text = typeof children === 'string' ? children : Array.isArray(children) && children.every((c) => typeof c === 'string' || typeof c === 'number') ? children.join('') : null;
  // Three letters at least, so a clock ("9:01 AM") is not a label.
  return !!text && (text.match(/[A-Z]/g)?.length ?? 0) >= 3 && text === text.toUpperCase();
}
