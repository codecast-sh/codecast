import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/** Android keyboard height above the system bars, from the keyboard events
 *  (0 on iOS and while hidden). Under edge-to-edge the window does not resize
 *  for the IME and KeyboardAvoidingView's Android path leaves phantom padding
 *  after a dismissal, so a screen lifts its bottom-anchored input by this. */
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
