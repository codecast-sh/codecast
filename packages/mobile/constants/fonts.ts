import { useSyncExternalStore } from 'react';
import { StyleProp, StyleSheet, TextStyle, ViewStyle } from 'react-native';
import { getActiveLook, useActiveLook, type Look } from '@/constants/Theme';

// JetBrains Mono is the app face, same as web (web aliases font-sans to it —
// the entire product renders in mono), and hosted mode's family look swaps
// in Instrument Sans and Newsreader (Sans, Serif below). Every face here is loaded in
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

// Hosted mode's faces (the family look, @platform/design FONTS): Instrument
// Sans for the interface, Newsreader for what the assistant writes. Both load
// only once the family look is on (`loadFamilyFaces`). Instrument Sans ships
// no italic, so its slant stands in with the upright face.
export const Sans = {
  regular: 'InstrumentSans',
  medium: 'InstrumentSans-Medium',
  semiBold: 'InstrumentSans-SemiBold',
  bold: 'InstrumentSans-Bold',
  italic: 'InstrumentSans',
} as const;

export const Serif = {
  regular: 'Newsreader',
  medium: 'Newsreader-Medium',
  semiBold: 'Newsreader-SemiBold',
  bold: 'Newsreader-SemiBold',
  italic: 'Newsreader-Italic',
} as const;

export type FaceGroup = { readonly regular: string; readonly medium: string; readonly semiBold: string; readonly bold: string; readonly italic: string };

const GROUP_OF = new Map<string, FaceGroup>([
  ['SpaceMono', Mono],
  ...[Mono, Sans, Serif].flatMap((g) => Object.values(g).map((face) => [face, g] as [string, FaceGroup])),
]);

// Medium, Bold and Italic load after first paint (app/_layout.tsx). Text laid
// out in a face that is not registered yet is measured in the system font and
// then drawn in the wider mono face without being measured again, which
// clipped labels ("Inbo", "Inb…"). Until they land, each late face resolves
// to the nearest face already loaded; the flip re-renders every Text, and the
// changed family makes it measure again. The family faces follow the same
// rule: until they land, family text sets in the system face at its weight.
let lateFacesLoaded = false;
let familyFacesLoaded = false;
const lateListeners = new Set<() => void>();
function notifyFaces(): void {
  lateListeners.forEach((l) => l());
}
export function markLateFacesLoaded(): void {
  if (lateFacesLoaded) return;
  lateFacesLoaded = true;
  notifyFaces();
}
export function markFamilyFacesLoaded(): void {
  if (familyFacesLoaded) return;
  familyFacesLoaded = true;
  notifyFaces();
}
function facesKey(): number {
  return (lateFacesLoaded ? 1 : 0) + (familyFacesLoaded ? 2 : 0);
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

/** The look's interface face for a mono face's weight: the face itself in
 *  the classic look, Instrument Sans at the same weight in the family look. */
function uiFaceFor(face: string, look: Look): string {
  if (look !== 'family') return face;
  const key = (Object.keys(Mono) as (keyof typeof Mono)[]).find((k) => Mono[k] === face);
  return key ? Sans[key] : face;
}

/** A face for nav-level styles (tab bar, header titles), in the active look,
 *  standing in until the late faces load. Nav styles cannot go through the
 *  Text wrapper, so they name the face themselves. */
export function useMonoFace(face: string): string {
  const late = useLateFacesLoaded();
  const look = useActiveLook();
  return uiFace(face, late, look);
}
export function uiFace(face: string, late = lateFacesLoaded, look: Look = getActiveLook()): string {
  const ui = uiFaceFor(face, look);
  if (ui !== face && !familyFacesLoaded) return 'System';
  return loadedFace(ui, late);
}

/** The face group a style names outright, for nested text to inherit (a
 *  bold span inside a reply set in Newsreader stays Newsreader). Undefined
 *  when the style names none, or a family outside the three groups. */
export function namedFaceGroup(style: StyleProp<TextStyle>): FaceGroup | undefined {
  const family = StyleSheet.flatten(style)?.fontFamily;
  return family ? GROUP_OF.get(family) : undefined;
}

function faceFor(group: FaceGroup, weight: TextStyle['fontWeight'], italic: boolean): string {
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
 * A style with no fontFamily takes the group of the Text it is nested in, as
 * CSS inherits a font, else the look's interface face (JetBrains Mono, or
 * Instrument Sans in the family look). A style naming any face of a known
 * group (mono, sans, serif; legacy 'SpaceMono' is mono) keeps that group and
 * picks the face for its weight, so code stays mono in every look. Any other
 * family is respected untouched.
 */
export function monoStyle(style: StyleProp<TextStyle>, late = lateFacesLoaded, look: Look = getActiveLook(), inherited?: FaceGroup): TextStyle {
  const flat = StyleSheet.flatten(style) ?? {};
  const group = flat.fontFamily ? GROUP_OF.get(flat.fontFamily) : inherited ?? (look === 'family' ? Sans : Mono);
  if (!group) return flat;
  if (group !== Mono && !familyFacesLoaded) {
    const { fontFamily: _unloaded, ...system } = flat;
    return system;
  }
  const { fontWeight, fontStyle, ...rest } = flat;
  const face = faceFor(group, fontWeight, fontStyle === 'italic');
  return { ...rest, fontFamily: group === Mono ? loadedFace(face, late) : face };
}

/** A tab's page title: codecast's bold 20px title, or in the family look the
 *  reading face, as the web sets every hosted page title (PageHeading). */
export function pageTitleFace(look: Look): TextStyle {
  return look === 'family'
    ? { fontFamily: Serif.regular, fontSize: 25, fontWeight: '400', letterSpacing: -0.2 }
    : { fontSize: 20, fontWeight: '700' };
}

/** The count beside a page title: the attention fill in codecast's look,
 *  a quiet figure in the family look (the accent is spent on what waits). */
export function pageCountLook(look: Look, accent: string, muted: string, bg: string): { badge: ViewStyle; text: TextStyle } {
  return look === 'family'
    ? { badge: { backgroundColor: 'transparent', paddingHorizontal: 2 }, text: { color: muted, fontWeight: '500', fontVariant: ['tabular-nums'] } }
    : { badge: { backgroundColor: accent }, text: { color: bg, fontWeight: '700' } };
}
