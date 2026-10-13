import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { ActivityIndicator, FlatList, Image, Modal, StyleSheet, TouchableOpacity, View as RNView, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import Animated, { interpolate, runOnJS, useAnimatedStyle, useSharedValue, withDecay, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Text as RNText } from '@/components/Themed';
import { GestureHandlerRootView, NativePressable, gestureHandler } from '@/lib/gestureHandler';

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

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
const DISMISS_DISTANCE = 110;
const DISMISS_VELOCITY = 900;
const SPRING = { damping: 26, stiffness: 260, mass: 0.9 } as const;
const TAP_SLOP = 10;
const THUMB = 44;
const THUMB_GAP = 6;

type Size = { width: number; height: number };

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

function fitted(natural: Size | null, page: Size): Size {
  if (!natural || !natural.width || !natural.height) return page;
  const r = Math.min(page.width / natural.width, page.height / natural.height);
  return { width: natural.width * r, height: natural.height * r };
}

function ZoomablePage({ uri, page, active, dismiss, onZoomChange, onToggleChrome, onClose }: {
  uri: string | undefined;
  page: Size;
  active: boolean;
  dismiss: SharedValue<number>;
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

    const singleTap = G.Tap()
      .maxDistance(TAP_SLOP)
      .onEnd(() => {
        'worklet';
        runOnJS(onToggleChrome)();
      });

    return G.Simultaneous(G.Simultaneous(pinch, pan), G.Exclusive(doubleTap, singleTap));
  }, [fit, page, zoomed, dismiss, scale, tx, ty, start, reportZoom, onToggleChrome, onClose]);

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
        </Animated.View>
      ) : (
        <ActivityIndicator color="#fff" />
      )}
    </RNView>
  );
  if (!gesture) return body;
  return <gestureHandler.GestureDetector gesture={gesture}>{body}</gestureHandler.GestureDetector>;
}

// A page resolves its own source, so items may carry async storage URLs.
function GalleryPage<T>({ item, useSrc, ...rest }: { item: T; useSrc: (item: T) => string | undefined } & Omit<Parameters<typeof ZoomablePage>[0], 'uri'>) {
  return <ZoomablePage uri={useSrc(item)} {...rest} />;
}

function Thumb<T>({ item, useSrc, active, onPress }: { item: T; useSrc: (item: T) => string | undefined; active: boolean; onPress: () => void }) {
  const src = useSrc(item);
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.8} style={[styles.thumb, active && styles.thumbActive]}>
      {src ? <Image source={{ uri: src }} style={styles.thumbImage} resizeMode="cover" /> : null}
    </TouchableOpacity>
  );
}

function HeaderButton({ icon, color = '#fff', onPress }: { icon: ComponentProps<typeof FontAwesome>['name']; color?: string; onPress: () => void }) {
  return (
    <NativePressable onPress={onPress} activeOpacity={0.6} hitSlop={10} style={styles.headerButton}>
      <FontAwesome name={icon} size={17} color={color} />
    </NativePressable>
  );
}

export function ImageGallery<T>({ items, useSrc, initialIndex, visible, onClose, accent = '#fff' }: {
  items: T[];
  // Called as a hook, once per rendered page and thumb; pass a stable function.
  useSrc: (item: T) => string | undefined;
  initialIndex: number;
  visible: boolean;
  onClose: () => void;
  accent?: string;
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
  const close = useCallback(() => onClose(), [onClose]);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: interpolate(dismiss.value, [0, 1], [1, 0.2]) }));
  const chromeStyle = useAnimatedStyle(() => ({ opacity: chromeShown.value * interpolate(dismiss.value, [0, 0.25], [1, 0], 'clamp') }));

  if (!visible) return null;
  const many = items.length > 1;

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onClose} supportedOrientations={['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']}>
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
            <RNText style={styles.counter}>{many ? `${index + 1} / ${items.length}` : ''}</RNText>
            <HeaderButton icon="close" onPress={onClose} />
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
                getItemLayout={(_, i) => ({ length: THUMB + THUMB_GAP, offset: (THUMB + THUMB_GAP) * i, index: i })}
                renderItem={({ item, index: i }) => (
                  <Thumb
                    item={item}
                    useSrc={useSrc}
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
  counter: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 14,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
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
