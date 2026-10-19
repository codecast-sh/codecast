import FontAwesome from '@expo/vector-icons/FontAwesome';
import * as Font from 'expo-font';

/** The faces the first frame draws with: Regular (body), SemiBold (the Inbox
 *  title) and the icon font the list uses. Medium, Bold and Italic load after
 *  the splash hides. A binary that embeds the files (expo-font in app.json)
 *  reports all of them loaded at once, so nothing waits. */
export const BOOT_FONTS = {
  'JetBrainsMono-Regular': require('../assets/fonts/JetBrainsMono-Regular.ttf'),
  'JetBrainsMono-SemiBold': require('../assets/fonts/JetBrainsMono-SemiBold.ttf'),
  ...FontAwesome.font,
};

/** Called from index.ts before the route modules evaluate: registering a font
 *  is native work off the JS thread, so it runs while the app's modules load
 *  instead of after them. The root layout's useFonts joins the same loads. */
export function startBootFonts() {
  Font.loadAsync(BOOT_FONTS).catch(() => {});
}
