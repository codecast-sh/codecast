import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Keyboard, Platform, StyleSheet, View as RNView } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import type { QuotedImage } from '@codecast/web/lib/quoteFormat';
import { Text, TextInput } from '@/components/Themed';
import { NativePressable } from '@/lib/gestureHandler';
import { galleryPins, pinInPage, type GalleryPin, type Size } from '@/lib/imagePins';

// The notes half of the phone's gallery (components/ImageGallery): numbered
// pins drawn on a picture, the note editor docked at the bottom, and the
// count on a filmstrip thumb. Pins and counts are drawn in contrast, not
// color, so they read on the Daylight's grayscale screen.

/** What a pin on a gallery item records, besides its point. */
export type PinPicture = Omit<QuotedImage, 'point' | 'attached'> & { messageId?: string; timestamp?: number };

export type GalleryNotes<T> = {
  /** The conversation whose quote batch the notes join: one the viewer can reply in. */
  conversationId: string;
  /** The composer's own pictures, which a send names by [Image N], rather than the transcript's. */
  attached?: boolean;
  /** The picture an item shows, as its pins name it. `src` is what the page resolved and paints. */
  describe: (item: T, src: string) => PinPicture;
};

// This gallery's pins from the batch. The selector returns a signature of the
// pin fields, so an unrelated batch or store write re-renders nothing.
export function useGalleryPins(notes: Pick<GalleryNotes<unknown>, 'conversationId' | 'attached'> | undefined): { pins: GalleryPin[]; sig: string } {
  const conversationId = notes?.conversationId;
  const attached = !!notes?.attached;
  const sig = useInboxStore((s) => (conversationId ? JSON.stringify(galleryPins(s.reviewComments[conversationId], attached)) : ''));
  const pins = useMemo<GalleryPin[]>(() => (sig ? JSON.parse(sig) : []), [sig]);
  return { pins, sig };
}

const PIN = 30;

// One pin, inside the page's zoomed view so it rides zoom and pan on the UI
// thread; it undoes the scale to keep its size on screen. Taps are resolved
// by the page's own tap gesture (lib/imagePins resolveTap), so it takes none.
function PinBadge({ pin, at, editing, scale }: { pin: GalleryPin; at: { x: number; y: number }; editing: boolean; scale: SharedValue<number> }) {
  const counter = useAnimatedStyle(() => ({ transform: [{ scale: 1 / Math.max(scale.value, 0.01) }] }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.pin, editing && styles.pinEditing, { left: at.x - PIN / 2, top: at.y - PIN / 2 }, counter]}
    >
      <Text style={[styles.pinNumber, editing && styles.pinNumberEditing]}>{pin.number}</Text>
    </Animated.View>
  );
}

export function PinLayer({ pins, natural, page, editingId, scale }: {
  pins: readonly GalleryPin[];
  natural: Size | null;
  page: Size;
  editingId: string | null;
  scale: SharedValue<number>;
}) {
  if (!natural || pins.length === 0) return null;
  return (
    <RNView pointerEvents="none" style={StyleSheet.absoluteFill}>
      {pins.map((p) => (
        <PinBadge key={p.id} pin={p} at={pinInPage(p.point, natural, page)} editing={p.id === editingId} scale={scale} />
      ))}
    </RNView>
  );
}

/** How many notes a filmstrip thumb's picture holds. */
export function NoteCount({ count }: { count: number }) {
  if (!count) return null;
  return (
    <RNView pointerEvents="none" style={styles.count} accessibilityElementsHidden>
      <Text style={styles.countText}>{count}</Text>
    </RNView>
  );
}

// The keyboard's height over the screen's bottom edge. The gallery is a
// Modal, which no screen's keyboard handling reaches, so the dock follows the
// keyboard events itself (iOS reports before it moves, Android after).
function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, (e) => setHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(hideEvt, () => setHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  return height;
}

// The open pin's note, docked at the bottom of the gallery above the keyboard.
// Typing lands in the batch on the web editor's 300ms cadence, and at once on
// Done, on unmount, and through `flushRef` (a tap that may move this pin reads
// the note first). An empty note keeps the pin, as on the web: it still
// points at the spot. Delete pin takes it away.
export function NoteEditor({ conversationId, pin, flushRef }: {
  conversationId: string;
  pin: GalleryPin;
  flushRef: MutableRefObject<(() => void) | null>;
}) {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const [value, setValue] = useState(pin.body);
  const latest = useRef(pin.body);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    useInboxStore.getState().commitReviewComment(conversationId, pin.id, latest.current.trim());
  }, [conversationId, pin.id]);

  useEffect(() => {
    flushRef.current = flush;
    return () => {
      flush();
      if (flushRef.current === flush) flushRef.current = null;
    };
  }, [flush, flushRef]);

  const done = () => {
    flush();
    useInboxStore.getState().setReviewEditingId(null);
    Keyboard.dismiss();
  };
  const remove = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    useInboxStore.getState().removeReviewComment(conversationId, pin.id);
    Keyboard.dismiss();
  };

  return (
    <RNView style={[styles.dock, { bottom: keyboard, paddingBottom: (keyboard ? 0 : insets.bottom) + 10 }]}>
      <RNView style={styles.dockHead}>
        <Text style={styles.dockTitle}>Note {pin.number}</Text>
        <NativePressable onPress={remove} activeOpacity={0.6} style={styles.deleteButton} accessibilityRole="button" accessibilityLabel={`Delete pin ${pin.number}`}>
          <Text style={styles.deleteText}>Delete pin</Text>
        </NativePressable>
        <NativePressable onPress={done} activeOpacity={0.7} style={styles.doneButton} accessibilityRole="button" accessibilityLabel="Done">
          <Text style={styles.doneText}>Done</Text>
        </NativePressable>
      </RNView>
      <TextInput
        value={value}
        onChangeText={(t) => {
          setValue(t);
          latest.current = t;
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(flush, 300);
        }}
        multiline
        autoFocus
        placeholder="Add a note…"
        placeholderTextColor="rgba(255,255,255,0.5)"
        accessibilityLabel={`Note ${pin.number}`}
        style={styles.input}
      />
    </RNView>
  );
}

const styles = StyleSheet.create({
  pin: {
    position: 'absolute',
    width: PIN,
    height: PIN,
    borderRadius: PIN / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    borderWidth: 2.5,
    borderColor: '#000',
  },
  // The open pin inverts: a shape change, not a hue, marks it.
  pinEditing: { backgroundColor: '#000', borderColor: '#fff', borderWidth: 3 },
  pinNumber: { color: '#000', fontSize: 14, fontWeight: '700', lineHeight: 17 },
  pinNumberEditing: { color: '#fff' },
  count: {
    position: 'absolute',
    top: -5,
    right: -5,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 4,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#000',
  },
  countText: { color: '#000', fontSize: 11, fontWeight: '700', lineHeight: 13 },
  dock: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: 12,
    paddingTop: 8,
    backgroundColor: '#111',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.35)',
  },
  dockHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  dockTitle: { flex: 1, color: '#fff', fontSize: 15, fontWeight: '700' },
  deleteButton: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  doneButton: {
    minHeight: 44,
    paddingHorizontal: 18,
    borderRadius: 8,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneText: { color: '#000', fontSize: 15, fontWeight: '700' },
  input: {
    minHeight: 44,
    maxHeight: 140,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#222',
    color: '#fff',
    fontSize: 16,
    textAlignVertical: 'top',
  },
});
