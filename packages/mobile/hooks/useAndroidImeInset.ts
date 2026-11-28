import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

// Android IME inset, driven straight from the keyboard events (0 on iOS and
// while hidden). Edge-to-edge does not resize the window for the IME, so a
// screen lifts its bottom-anchored input by this. KAV's Android path can't be
// trusted for this: it never resets to 0 from a hide event — it RE-DERIVES
// padding as (own frame height − getWindowVisibleDisplayFrame height), and
// under edge-to-edge the KAV spans the full window while the visible frame
// excludes the status bar and any still-animating IME slice. Every dismissal
// therefore left ~a-status-bar-plus of phantom padding, and IME churn right
// after a send strobed the composer between padded and unpadded (glitchy
// bottom on the tablet). Event-driven padding has no frame math: didShow
// carries the IME height above the system bars, didHide is an authoritative 0.
export function useAndroidImeInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const show = Keyboard.addListener('keyboardDidShow', (e) => setInset(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setInset(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  return inset;
}
