import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type MutableRefObject } from 'react';
import { ActivityIndicator, FlatList, Image, Keyboard, Modal, StyleSheet, TouchableOpacity, View as RNView, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import Animated, { interpolate, runOnJS, useAnimatedStyle, useSharedValue, withDecay, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Text as RNText } from '@/components/Themed';
import { GestureHandlerRootView, NativePressable, gestureHandler } from '@/lib/gestureHandler';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { addImagePin } from '@codecast/web/lib/reviewActions';
import { fitted, notesHeadline, pinToMove, pinsOn, resolveTap, type GalleryPin, type Point, type Size } from '@/lib/imagePins';
import { NoteCount, NoteEditor, PinLayer, useGalleryPins, type GalleryNotes, type PinPicture } from '@/components/GalleryNotes';

export type { GalleryNotes } from '@/components/GalleryNotes';

// Full-screen image gallery: a horizontal pager of zoomable pages, a header
// (rotate, counter, close) and a filmstrip. All gestures run as worklets on
// the UI thread, so a busy JS thread (the session screen) never makes pinch,
// pan, dismiss or the header buttons lag.
//
// Per page: pinch zooms about the fingers; one-finger pan moves a zoomed image
// within its bounds and coasts with decay; double tap zooms to the tapped
// point or back out; a vertical drag on an unzoomed image dismisses, fading the
// backdrop as it goes; a single tap hides or shows the chrome. On binaries
// without gesture-handler (lib/gestureHandler.tsx) pages render unzoomable.
//
// With `notes` (a gallery over a conversation the viewer can reply in), an
// unzoomed single tap on the picture pins a numbered note there instead, into
// the conversation's quote batch (web components/ImageGallery pinWhereClicked);
// a tap on a pin opens its note, docked at the bottom; a tap in the letterbox
// still toggles the chrome. Which one a tap is: lib/imagePins resolveTap.

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
const DISMISS_DISTANCE = 110;
const DISMISS_VELOCITY = 900;
const SPRING = { damping: 26, stiffness: 260, mass: 0.9 } as const;
const TAP_SLOP = 10;
const THUMB = 44;
const THUMB_GAP = 6;

function clamp(v: number, lo: number, hi: number) {
  'worklet';
  return Math.min(hi, Math.max(lo, v));
}

// How far a zoomed image may travel from center along each axis: half of
// whatever overflows the page. The image is drawn `contain`-fitted, so the
// fitted size (not the page size) is what scales.
function bounds(scale: number, fit: Size, page: Size) {
  'worklet';
  return {
    x: Math.max(0, (fit.width * scale - page.width) / 2),
    y: Math.max(0, (fit.height * scale - page.height) / 2),
  };
}

// A page's notes: the pins on its picture, and how a tap adds one.
type PageNotes = { pins: GalleryPin[]; editingId: string | null; onPin: (point: Point, natural: Size) => void };

function ZoomablePage({ uri, page, active, dismiss, notes, onZoomChange, onToggleChrome, onClose }: {
  uri: string | undefined;
  page: Size;
  active: boolean;
  dismiss: SharedValue<number>;
  notes?: PageNotes;
  onZoomChange: (zoomed: boolean) => void;
  onToggleChrome: () => void;
  onClose: () => void;
}) {
  const [natural, setNatural] = useState<Size | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const fit = useMemo(() => fitted(natural, page), [natural, page]);

  const scale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const start = useSharedValue({ scale: 1, tx: 0, ty: 0, fx: 0, fy: 0 });

  const reportZoom = useCallback((z: boolean) => {
    setZoomed(z);
    onZoomChange(z);
  }, [onZoomChange]);

  // The single tap's verdict is reached on the JS thread, from the pins and
  // the zoom the tap landed under; read through a ref so the gesture is not
  // rebuilt whenever a pin moves.
  const tapRef = useRef<(x: number, y: number, s: number, ox: number, oy: number) => void>(() => {});
  tapRef.current = (x, y, s, ox, oy) => {
    if (!notes) return onToggleChrome();
    const tap = resolveTap({ tap: { x, y }, page, natural, view: { scale: s, tx: ox, ty: oy }, pins: notes.pins, canAdd: true });
    if (tap.kind === 'add') return notes.onPin(tap.point, natural!);
    if (tap.kind === 'chrome') return onToggleChrome();
    // A tap on the open pin closes its note, as on the web.
    const closing = notes.editingId === tap.id;
    useInboxStore.getState().setReviewEditingId(closing ? null : tap.id);
    if (closing) Keyboard.dismiss();
  };
  const onTap = useCallback((x: number, y: number, s: number, ox: number, oy: number) => tapRef.current(x, y, s, ox, oy), []);

  // A page scrolled away from resets, so coming back shows the whole image.
  useEffect(() => {
    if (active) return;
    scale.value = 1;
    tx.value = 0;
    ty.value = 0;
    setZoomed(false);
  }, [active, scale, tx, ty]);

  const gesture = useMemo(() => {
    const G = gestureHandler?.Gesture;
    if (!G) return null;
    const half = { w: page.width / 2, h: page.height / 2 };

    // Settle scale into [1, MAX] and the offset into its bounds.
    const settle = (s: number, x: number, y: number) => {
      'worklet';
      const target = clamp(s, 1, MAX_SCALE);
      const ratio = target / s;
      const b = bounds(target, fit, page);
      scale.value = withSpring(target, SPRING);
      tx.value = withSpring(target === 1 ? 0 : clamp(x * ratio, -b.x, b.x), SPRING);
      ty.value = withSpring(target === 1 ? 0 : clamp(y * ratio, -b.y, b.y), SPRING);
      runOnJS(reportZoom)(target > 1.01);
    };

    const pinch = G.Pinch()
      .onStart((e: any) => {
        'worklet';
        start.value = { scale: scale.value, tx: tx.value, ty: ty.value, fx: e.focalX - half.w, fy: e.focalY - half.h };
      })
      .onUpdate((e: any) => {
        'worklet';
        const s0 = start.value;
        // Soft limits while pinching; settle() springs back to the hard ones.
        const s = clamp(s0.scale * e.scale, 0.6, MAX_SCALE * 1.4);
        const k = s / s0.scale;
        // Keep the content under the fingers under the fingers, and let the
        // focal point's own movement pan.
        tx.value = (e.focalX - half.w) - (s0.fx - s0.tx) * k;
        ty.value = (e.focalY - half.h) - (s0.fy - s0.ty) * k;
        scale.value = s;
      })
      .onEnd(() => {
        'worklet';
        settle(scale.value, tx.value, ty.value);
      });

    const pan = G.Pan()
      .maxPointers(1)
      .onStart(() => {
        'worklet';
        start.value = { ...start.value, tx: tx.value, ty: ty.value };
      })
      .onUpdate((e: any) => {
        'worklet';
        if (scale.value > 1.01) {
          const b = bounds(scale.value, fit, page);
          // Rubber-band past the edges at a third of the finger's travel.
          const rx = start.value.tx + e.translationX;
          const ry = start.value.ty + e.translationY;
          tx.value = rx > b.x ? b.x + (rx - b.x) / 3 : rx < -b.x ? -b.x + (rx + b.x) / 3 : rx;
          ty.value = ry > b.y ? b.y + (ry - b.y) / 3 : ry < -b.y ? -b.y + (ry + b.y) / 3 : ry;
        } else {
          tx.value = e.translationX * 0.6;
          ty.value = e.translationY;
          dismiss.value = Math.min(1, Math.abs(e.translationY) / (page.height / 2));
        }
      })
      .onEnd((e: any) => {
        'worklet';
        if (scale.value > 1.01) {
          const b = bounds(scale.value, fit, page);
          tx.value = withDecay({ velocity: e.velocityX, clamp: [-b.x, b.x], rubberBandEffect: true });
          ty.value = withDecay({ velocity: e.velocityY, clamp: [-b.y, b.y], rubberBandEffect: true });
          return;
        }
        if (Math.abs(e.translationY) > DISMISS_DISTANCE || Math.abs(e.velocityY) > DISMISS_VELOCITY) {
          const dir = (e.translationY || e.velocityY) < 0 ? -1 : 1;
          ty.value = withTiming(dir * page.height, { duration: 180 });
          dismiss.value = withTiming(1, { duration: 180 }, () => runOnJS(onClose)());
          return;
        }
        tx.value = withSpring(0, SPRING);
        ty.value = withSpring(0, SPRING);
        dismiss.value = withSpring(0, SPRING);
      });
    // Unzoomed, only a vertical drag is ours; horizontal belongs to the pager.
    if (zoomed) pan.minDistance(2);
    else pan.activeOffsetY([-12, 12]).failOffsetX([-12, 12]);

    const doubleTap = G.Tap()
      .numberOfTaps(2)
      .maxDelay(250)
      .maxDistance(TAP_SLOP)
      .onEnd((e: any) => {
        'worklet';
        if (scale.value > 1.01) {
          settle(1, 0, 0);
        } else {
          // Zoom so the tapped point stays where it was tapped.
          const s = DOUBLE_TAP_SCALE;
          settle(s, -(e.x - half.w) * (s - 1), -(e.y - half.h) * (s - 1));
        }
      });

    // Waits for the double tap to fail (Exclusive below), so the first tap
    // of a double tap never pins.
    const singleTap = G.Tap()
      .maxDistance(TAP_SLOP)
      .onEnd((e: any) => {
        'worklet';
        runOnJS(onTap)(e.x, e.y, scale.value, tx.value, ty.value);
      });

    return G.Simultaneous(G.Simultaneous(pinch, pan), G.Exclusive(doubleTap, singleTap));
  }, [fit, page, zoomed, dismiss, scale, tx, ty, start, reportZoom, onTap, onClose]);

  const imageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  const body = (
    <RNView style={[page, styles.page]}>
      {uri ? (
        <Animated.View style={[page, imageStyle]}>
          <Image
            source={{ uri }}
            style={page}
            resizeMode="contain"
            onLoad={(e) => {
              const s = e.nativeEvent.source;
              if (s?.width && s?.height) setNatural({ width: s.width, height: s.height });
            }}
          />
          {notes && <PinLayer pins={notes.pins} natural={natural} page={page} editingId={notes.editingId} scale={scale} />}
        </Animated.View>
      ) : (
        <ActivityIndicator color="#fff" />
      )}
    </RNView>
  );
  if (!gesture) return body;
  return <gestureHandler.GestureDetector gesture={gesture}>{body}</gestureHandler.GestureDetector>;
}

type ItemNotes<T> = { notes: GalleryNotes<T>; pins: GalleryPin[] };

// A page resolves its own source, so items may carry async storage URLs.
function GalleryPage<T>({ item, useSrc, itemNotes, editingId, onPin, ...rest }: {
  item: T;
  useSrc: (item: T) => string | undefined;
  itemNotes?: ItemNotes<T>;
  editingId: string | null;
  onPin: (picture: PinPicture, point: Point, natural: Size) => void;
} & Omit<Parameters<typeof ZoomablePage>[0], 'uri' | 'notes'>) {
  const uri = useSrc(item);
  const picture = itemNotes && uri ? itemNotes.notes.describe(item, uri) : null;
  const notes = picture
    ? { pins: pinsOn(itemNotes!.pins, picture), editingId, onPin: (point: Point, natural: Size) => onPin(picture, point, natural) }
    : undefined;
  return <ZoomablePage uri={uri} notes={notes} {...rest} />;
}

function Thumb<T>({ item, useSrc, itemNotes, active, onPress }: { item: T; useSrc: (item: T) => string | undefined; itemNotes?: ItemNotes<T>; active: boolean; onPress: () => void }) {
  const src = useSrc(item);
  const count = itemNotes && src ? pinsOn(itemNotes.pins, itemNotes.notes.describe(item, src)).length : 0;
  return (
    <RNView style={styles.thumbSlot}>
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.8}
        style={[styles.thumb, active && styles.thumbActive]}
        accessibilityLabel={count ? `Picture with ${count} ${count === 1 ? 'note' : 'notes'}` : 'Picture'}
      >
        {src ? <Image source={{ uri: src }} style={styles.thumbImage} resizeMode="cover" /> : null}
      </TouchableOpacity>
      {/* Outside the dimmed thumb, so a picture with notes reads at full contrast. */}
      <NoteCount count={count} />
    </RNView>
  );
}

// The open note, when the pin being edited is on the picture shown. Its own
// component so the shown item's source resolves as a hook.
function CurrentNote<T>({ item, useSrc, itemNotes, editingId, flushRef }: {
  item: T;
  useSrc: (item: T) => string | undefined;
  itemNotes: ItemNotes<T>;
  editingId: string | null;
  flushRef: MutableRefObject<(() => void) | null>;
}) {
  const src = useSrc(item);
  if (!src || !editingId) return null;
  const pin = pinsOn(itemNotes.pins, itemNotes.notes.describe(item, src)).find((p) => p.id === editingId);
  return pin ? <NoteEditor key={pin.id} conversationId={itemNotes.notes.conversationId} pin={pin} flushRef={flushRef} /> : null;
}

function HeaderButton({ icon, color = '#fff', onPress }: { icon: ComponentProps<typeof FontAwesome>['name']; color?: string; onPress: () => void }) {
  return (
    <NativePressable onPress={onPress} activeOpacity={0.6} hitSlop={10} style={styles.headerButton}>
      <FontAwesome name={icon} size={17} color={color} />
    </NativePressable>
  );
}

export function ImageGallery<T>({ items, useSrc, initialIndex, visible, onClose, accent = '#fff', notes }: {
  items: T[];
  // Called as a hook, once per rendered page and thumb; pass a stable function.
  useSrc: (item: T) => string | undefined;
  initialIndex: number;
  visible: boolean;
  onClose: () => void;
  accent?: string;
  /** Pictures here take pinned notes (GalleryNotes). Absent: a plain viewer. */
  notes?: GalleryNotes<T>;
}) {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const [index, setIndex] = useState(initialIndex);
  const [zoomed, setZoomed] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [landscape, setLandscape] = useState(false);
  const pager = useRef<FlatList<T>>(null);
  const strip = useRef<FlatList<T>>(null);
  const dismiss = useSharedValue(0);
  const chromeShown = useSharedValue(1);
  const { pins, sig: pinsSig } = useGalleryPins(notes);
  const editingId = useInboxStore((s) => (notes ? s.reviewEditingId : null));
  const itemNotes = useMemo(() => (notes ? { notes, pins } : undefined), [notes, pins]);
  const pinsRef = useRef(pins);
  pinsRef.current = pins;
  const notesRef = useRef(notes);
  notesRef.current = notes;
  // The open note's write-through, so a tap that may move its pin, and a
  // close, read what was typed first.
  const editorFlush = useRef<(() => void) | null>(null);

  // Rotate turns the pager 90° for wide images while the phone stays portrait.
  const page = useMemo<Size>(
    () => (landscape ? { width: window.height, height: window.width } : { width: window.width, height: window.height }),
    [landscape, window.width, window.height],
  );

  useEffect(() => {
    if (!visible) return;
    setIndex(initialIndex);
    setZoomed(false);
    setChrome(true);
    setLandscape(false);
    dismiss.value = 0;
    chromeShown.value = 1;
  }, [visible, initialIndex, dismiss, chromeShown]);

  useEffect(() => {
    if (!visible || items.length < 2) return;
    const step = THUMB + THUMB_GAP;
    strip.current?.scrollToOffset({ offset: Math.max(0, index * step - window.width / 2 + step / 2), animated: true });
  }, [visible, index, items.length, window.width]);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / page.width);
    setIndex((prev) => (prev === i ? prev : Math.max(0, Math.min(items.length - 1, i))));
  }, [page.width, items.length]);

  const toggleChrome = useCallback(() => {
    setChrome((c) => {
      chromeShown.value = withTiming(c ? 0 : 1, { duration: 180 });
      return !c;
    });
  }, [chromeShown]);
  // Pin a note where a tap landed. A tap while this picture's open pin has no
  // note yet moves that pin (lib/imagePins pinToMove).
  const pinAt = useCallback((picture: PinPicture, point: Point, natural: Size) => {
    const n = notesRef.current;
    if (!n) return;
    editorFlush.current?.();
    const s = useInboxStore.getState();
    const moving = pinToMove(s.reviewComments[n.conversationId], s.reviewEditingId, picture);
    if (moving) s.removeReviewComment(n.conversationId, moving);
    addImagePin(n.conversationId, {
      ...picture,
      width: picture.width ?? natural.width,
      height: picture.height ?? natural.height,
      ...(n.attached ? { attached: true } : {}),
    }, point);
  }, []);

  // Done with this gallery's note: what was typed lands, and its editor
  // closes, leaving no editor "open" behind a closed gallery (as on the web).
  const finishNote = useCallback((): boolean => {
    editorFlush.current?.();
    const s = useInboxStore.getState();
    if (!s.reviewEditingId || !pinsRef.current.some((p) => p.id === s.reviewEditingId)) return false;
    s.setReviewEditingId(null);
    return true;
  }, []);
  const close = useCallback(() => {
    finishNote();
    onClose();
  }, [finishNote, onClose]);
  // Android back closes an open note before the gallery.
  const back = useCallback(() => {
    if (!finishNote()) onClose();
  }, [finishNote, onClose]);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: interpolate(dismiss.value, [0, 1], [1, 0.2]) }));
  const chromeStyle = useAnimatedStyle(() => ({ opacity: chromeShown.value * interpolate(dismiss.value, [0, 0.25], [1, 0], 'clamp') }));

  if (!visible) return null;
  const many = items.length > 1;
  // Until a note is pinned, say what a tap on the picture does (the web says so under its picture).
  const headline = notes ? notesHeadline(pins.length) ?? 'Tap the picture to pin a note' : null;
  const current = items[index];

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={back} supportedOrientations={['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']}>
      <GestureHandlerRootView style={styles.root}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdropStyle]} />
        <RNView style={styles.center}>
          <RNView style={[page, landscape && { transform: [{ rotate: '90deg' }] }]}>
            <FlatList
              // Remount on a size change so paging offsets match the new width.
              key={`${page.width}x${page.height}`}
              ref={pager}
              data={items}
              horizontal
              pagingEnabled
              scrollEnabled={!zoomed}
              showsHorizontalScrollIndicator={false}
              keyExtractor={(_, i) => String(i)}
              initialScrollIndex={index}
              extraData={`${index}|${editingId}|${pinsSig}`}
              getItemLayout={(_, i) => ({ length: page.width, offset: page.width * i, index: i })}
              onScroll={onScroll}
              scrollEventThrottle={32}
              windowSize={3}
              initialNumToRender={1}
              maxToRenderPerBatch={2}
              renderItem={({ item, index: i }) => (
                <GalleryPage
                  item={item}
                  useSrc={useSrc}
                  page={page}
                  active={i === index}
                  dismiss={dismiss}
                  itemNotes={itemNotes}
                  editingId={editingId}
                  onPin={pinAt}
                  onZoomChange={setZoomed}
                  onToggleChrome={toggleChrome}
                  onClose={close}
                />
              )}
            />
          </RNView>
        </RNView>

        <Animated.View pointerEvents={chrome ? 'box-none' : 'none'} style={[StyleSheet.absoluteFill, chromeStyle]}>
          <RNView style={[styles.header, { paddingTop: insets.top + 6 }]}>
            <HeaderButton icon="rotate-right" color={landscape ? accent : '#fff'} onPress={() => { setLandscape((l) => !l); setZoomed(false); }} />
            <RNView style={styles.headerMiddle}>
              <RNText style={styles.counter}>{many ? `${index + 1} / ${items.length}` : ''}</RNText>
              {headline && <RNText style={styles.headline} numberOfLines={1}>{headline}</RNText>}
            </RNView>
            <HeaderButton icon="close" onPress={close} />
          </RNView>
          {many && (
            <RNView style={[styles.strip, { paddingBottom: insets.bottom + 10 }]}>
              <FlatList
                ref={strip}
                data={items}
                horizontal
                showsHorizontalScrollIndicator={false}
                keyExtractor={(_, i) => String(i)}
                contentContainerStyle={styles.stripContent}
                extraData={pinsSig}
                getItemLayout={(_, i) => ({ length: THUMB + THUMB_GAP, offset: (THUMB + THUMB_GAP) * i, index: i })}
                renderItem={({ item, index: i }) => (
                  <Thumb
                    item={item}
                    useSrc={useSrc}
                    itemNotes={itemNotes}
                    active={i === index}
                    onPress={() => {
                      setIndex(i);
                      setZoomed(false);
                      pager.current?.scrollToIndex({ index: i, animated: false });
                    }}
                  />
                )}
              />
            </RNView>
          )}
        </Animated.View>

        {itemNotes && current !== undefined && (
          <CurrentNote item={current} useSrc={useSrc} itemNotes={itemNotes} editingId={editingId} flushRef={editorFlush} />
        )}
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  backdrop: { backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  page: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 10,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  headerButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  headerMiddle: { flex: 1, alignItems: 'center', paddingHorizontal: 8 },
  counter: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 14,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  headline: { color: '#fff', fontSize: 13, fontWeight: '600', marginTop: 2 },
  strip: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 10,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  stripContent: {
    paddingHorizontal: 12,
    gap: THUMB_GAP,
    flexGrow: 1,
    justifyContent: 'center',
  },
  thumbSlot: { width: THUMB, height: THUMB },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: 8,
    overflow: 'hidden',
    opacity: 0.5,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  thumbActive: {
    opacity: 1,
    borderColor: '#fff',
  },
  thumbImage: { width: '100%', height: '100%' },
});
