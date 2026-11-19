import { useCallback, useEffect, useRef } from 'react';
import { Animated, PixelRatio, StyleSheet, View } from 'react-native';
import { themedStyles, useTheme } from '@/constants/Theme';
import { progressStep, progressWrite } from '@/lib/scrollProgress';

const TRACK_HEIGHT = 48;
const TRACK_PX = Math.round(TRACK_HEIGHT * PixelRatio.get());

/**
 * The transcript's position bar: where a thread with no tick rail shows how
 * far up it is. `report` takes each scroll position and writes the fill only
 * while the track is drawn and only when it moves a device pixel
 * (lib/scrollProgress); the fill takes its place as the track appears.
 */
export function useScrollProgressBar(shown: boolean) {
  const fill = useRef(new Animated.Value(0)).current;
  const progressRef = useRef(0);
  const stepRef = useRef(-1);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    if (!shown) return;
    const step = progressStep(progressRef.current, TRACK_PX);
    stepRef.current = step;
    fill.setValue(step / TRACK_PX);
  }, [shown, fill]);
  const report = useCallback((progress: number) => {
    progressRef.current = progress;
    const write = progressWrite(shownRef.current, progress, TRACK_PX, stepRef.current);
    if (!write) return;
    stepRef.current = write.step;
    fill.setValue(write.value);
  }, [fill]);
  return { fill, report };
}

export function ScrollProgressTrack({ fill }: { fill: Animated.Value }) {
  useTheme();
  return (
    <View style={styles.wrap}>
      <View style={styles.track}>
        <Animated.View style={[styles.fill, { height: fill.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]} />
      </View>
    </View>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  wrap: {
    position: 'absolute',
    right: 8,
    top: '45%',
  },
  track: {
    width: 3,
    height: TRACK_HEIGHT,
    borderRadius: 1.5,
    backgroundColor: Theme.bgHighlight,
    overflow: 'hidden',
    marginBottom: 6,
  },
  fill: {
    width: '100%',
    borderRadius: 1.5,
    backgroundColor: Theme.cyan,
  },
}));
