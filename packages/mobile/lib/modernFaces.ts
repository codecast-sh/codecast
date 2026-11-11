// Registers Instrument Sans for the Modern look, the first time Modern is on.
//
// The four upright faces are embedded in every 1.0.5 binary (app.json's
// expo-font plugin), and Font.isLoaded reports a face the binary embeds, so
// on those binaries they are marked ready synchronously and the first Modern
// frame is already in Sans. A binary built without them (a simulator or dev
// build made without the plugin) loads them as assets of the update, and text
// sets in the system face until they land (constants/fonts.ts).
//
// The italic was never embedded: it always loads here, as an asset of the
// update, and italic text stands in with the system italic until it lands.
// Never add it to the plugin list assuming shipped binaries carry it.
import * as Font from 'expo-font';
import { Sans, markSansFacesLoaded, markSansItalicLoaded } from '@/constants/fonts';

const UPRIGHT = {
  [Sans.regular]: require('../assets/fonts/InstrumentSans-Regular.ttf'),
  [Sans.medium]: require('../assets/fonts/InstrumentSans-Medium.ttf'),
  [Sans.semiBold]: require('../assets/fonts/InstrumentSans-SemiBold.ttf'),
  [Sans.bold]: require('../assets/fonts/InstrumentSans-Bold.ttf'),
};
const ITALIC = {
  [Sans.italic]: require('../assets/fonts/InstrumentSans-Italic.ttf'),
};

function allLoaded(names: string[]): boolean {
  try {
    return names.every((n) => Font.isLoaded(n));
  } catch {
    return false;
  }
}

let started = false;

/** Make the Sans faces available; safe to call on every render that wants them. */
export function ensureModernFaces(): void {
  if (started) return;
  started = true;
  if (allLoaded(Object.keys(UPRIGHT))) markSansFacesLoaded();
  else Font.loadAsync(UPRIGHT).then(markSansFacesLoaded, () => {});
  if (allLoaded(Object.keys(ITALIC))) markSansItalicLoaded();
  else Font.loadAsync(ITALIC).then(markSansItalicLoaded, () => {});
}
