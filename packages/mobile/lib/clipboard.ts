import { optionalNative } from "./optionalNative";
/**
 * Copy a string to the system clipboard.
 *
 * Prefers expo-clipboard, but its ExpoClipboard native module isn't linked into
 * every dev/standalone binary yet (adding it requires a native rebuild, not just
 * a JS bundle). Until a build ships with it, importing expo-clipboard eagerly
 * throws "Cannot find native module 'ExpoClipboard'" and white-screens the host
 * component. So require it lazily and fall back to react-native's core Clipboard
 * — which is what the app shipped before and still works. Once a native build
 * bundles ExpoClipboard, this upgrades itself with no code change.
 */
export function copyToClipboard(value: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ExpoClipboard = require('expo-clipboard');
    return Promise.resolve(ExpoClipboard.setStringAsync(value));
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Clipboard } = require('react-native');
      Clipboard?.setString?.(value);
    } catch {
      // no clipboard backend available — swallow rather than crash the screen
    }
    return Promise.resolve();
  }
}

/** The clipboard's text, or null when the binary has no clipboard module or it is empty. */
export async function readClipboard(): Promise<string | null> {
  const ExpoClipboard = optionalNative('ExpoClipboard', () => require('expo-clipboard'));
  try {
    const text = ExpoClipboard ? await ExpoClipboard.getStringAsync() : null;
    return text ? String(text) : null;
  } catch {
    return null;
  }
}
