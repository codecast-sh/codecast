import { Easing, LinearTransition, ReduceMotion, withTiming, type EntryAnimationsValues, type LayoutAnimation } from 'react-native-reanimated';

/**
 * The transcript's motion, one system on the UI thread. When a row arrives at
 * the bottom, every row above glides up by its height (ROW_LAYOUT) while the
 * new row rises the same distance on the same curve from below the list's
 * edge, so the transcript moves as one piece, the way Messages does. A sent
 * bubble shows at once; a reply fades in a little slower, as something
 * arriving rather than something the person did.
 */

const DURATION = 340;
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

/** Rows already on screen glide to where an arrival or an opened run puts them. */
export const ROW_LAYOUT = LinearTransition.duration(DURATION).easing(EASE_OUT).reduceMotion(ReduceMotion.System);

function rise(values: EntryAnimationsValues, fadeMs: number): LayoutAnimation {
  'worklet';
  return {
    initialValues: { opacity: 0, transform: [{ translateY: values.targetHeight }] },
    animations: {
      opacity: withTiming(1, { duration: fadeMs, easing: EASE_OUT, reduceMotion: ReduceMotion.System }),
      transform: [{ translateY: withTiming(0, { duration: DURATION, easing: EASE_OUT, reduceMotion: ReduceMotion.System }) }],
    },
  };
}

/** The person's own send: up out of the composer, solid almost at once. */
export function sendEntering(values: EntryAnimationsValues): LayoutAnimation {
  'worklet';
  return rise(values, 120);
}

/** The agent's turn arriving. */
export function arriveEntering(values: EntryAnimationsValues): LayoutAnimation {
  'worklet';
  return rise(values, 280);
}
