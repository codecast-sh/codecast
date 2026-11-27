// Where the undo bar sits on a screen with a composer: just above the whole
// stack docked over the keyboard (a decision card, a permission line, the
// terminal offer, the owner lines and the input), so Undo never hides under
// the software keyboard or the control it takes back. The stack rides the
// keyboard (KeyboardAvoidingView), so its top in the window is the line.
// Measured on layout, on the keyboard showing and hiding, and on focus; the
// screen that loses focus clears it, so a screen pushed over this one (an
// agent's session, a task) sets its own or none. `enabled` false leaves the
// line alone (a composer that is not the screen's bottom edge).
import { useCallback, useRef } from 'react';
import { Keyboard, type View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { setUndoBarDock } from '@/lib/undoBar';

export function useUndoBarAnchor(enabled = true) {
  const ref = useRef<View>(null);
  const measure = useCallback(() => {
    if (!enabled) return;
    ref.current?.measureInWindow((_x, y, _w, h) => {
      if (h > 0) setUndoBarDock(y);
    });
  }, [enabled]);
  useFocusEffect(useCallback(() => {
    if (!enabled) return;
    measure();
    const subs = [Keyboard.addListener('keyboardDidShow', measure), Keyboard.addListener('keyboardDidHide', measure)];
    return () => {
      for (const sub of subs) sub.remove();
      setUndoBarDock(null);
    };
  }, [enabled, measure]));
  return { ref, onLayout: measure };
}
