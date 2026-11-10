import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { AppState, Platform, Pressable, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { Text } from '@/components/Themed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { useAuth } from '@/lib/auth';
import { shouldLockOnReturn } from '@/lib/biometricLock';
import { optionalNative } from '@/lib/optionalNative';

// Drawn in its own window, as a popup is (components/PopupHost), so a modal
// screen or an open sheet cannot sit above the lock. A binary without the
// screens module draws it over the app's root instead. The overlay joins the
// key window of the foreground-active scene when it mounts, and an app in the
// background has none: an overlay mounted there never shows, not even after
// the app returns. So the background cover is drawn over the app's root, and
// the overlay mounts afresh on each return from the background.
const FullWindowOverlay: ComponentType<{ children: ReactNode }> | null = Platform.OS === 'ios'
  ? optionalNative('RNSModule', () => require('react-native-screens').FullWindowOverlay)
  : null;

// boot: the setting is still being read. locked: waiting on a passed check.
// cover: in the background with the setting on, so the app switcher shows the
// lock rather than a conversation; coming back decides between open and locked.
type LockState = 'boot' | 'locked' | 'cover' | 'open';

/**
 * Biometric Unlock (Settings > Security). Mounted once at the root. With the
 * setting on, the app opens behind a Face ID / Touch ID check at a cold launch
 * and when it returns to the foreground after BIOMETRIC_GRACE_MS away. The
 * system falls back to the device passcode by itself, a phone with neither is
 * let in (lib/biometricLock), and signing out is always offered.
 */
export function BiometricGate() {
  const {
    isAuthenticated, isLoading, isBiometricEnabled, isBiometricSettingLoaded,
    authenticateWithBiometric, signOut,
  } = useAuth();
  const signedOut = !isAuthenticated && !isLoading;
  const [state, setState] = useState<LockState>(() =>
    isBiometricSettingLoaded ? (isBiometricEnabled ? 'locked' : 'open') : 'boot');
  const stateRef = useRef(state);
  stateRef.current = state;
  const enabledRef = useRef(isBiometricEnabled);
  enabledRef.current = isBiometricEnabled;
  const backgroundedAt = useRef<number | null>(null);
  // Bumped on each return to the foreground (and on the first, for a gate
  // that mounted before the app was active); the overlay's key, so it
  // remounts into the window that is now in the foreground.
  const [foregroundings, setForegroundings] = useState(0);
  const awaySinceActive = useRef(AppState.currentState !== 'active');
  // One automatic prompt per lock. A cancelled prompt leaves the Unlock
  // button; it must not ask again by itself, because the prompt's own
  // dismissal is what brings the app back to "active". A gate that mounts
  // after the setting has loaded starts locked without going through lock(),
  // so that first lock owes its prompt too.
  const promptOwed = useRef(state === 'locked');
  const prompting = useRef(false);

  const prompt = useCallback(async () => {
    if (prompting.current) return;
    prompting.current = true;
    promptOwed.current = false;
    try {
      if (await authenticateWithBiometric()) setState('open');
    } finally {
      prompting.current = false;
    }
  }, [authenticateWithBiometric]);

  const lock = useCallback(() => {
    promptOwed.current = true;
    setState('locked');
  }, []);

  useEffect(() => {
    if (state === 'boot') {
      if (!isBiometricSettingLoaded) return;
      if (isBiometricEnabled && !signedOut) lock();
      else setState('open');
      return;
    }
    // The login screen is not behind the lock.
    if (signedOut && state !== 'open') setState('open');
  }, [state, isBiometricSettingLoaded, isBiometricEnabled, signedOut, lock]);

  useEffect(() => {
    if (state === 'locked' && promptOwed.current && AppState.currentState === 'active') void prompt();
  }, [state, prompt]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const current = stateRef.current;
      if (next === 'background') {
        awaySinceActive.current = true;
        if (current === 'open' && enabledRef.current) {
          backgroundedAt.current = Date.now();
          setState('cover');
        } else if (current === 'locked') {
          // Left with the lock up (a prompt the system cancelled): ask again
          // on the way back.
          promptOwed.current = true;
        }
        return;
      }
      if (next !== 'active') return;
      if (awaySinceActive.current) {
        awaySinceActive.current = false;
        setForegroundings((n) => n + 1);
      }
      if (current === 'cover') {
        const stale = shouldLockOnReturn({
          enabled: enabledRef.current,
          backgroundedAt: backgroundedAt.current,
          now: Date.now(),
        });
        backgroundedAt.current = null;
        if (stale) lock();
        else setState('open');
      } else if (current === 'locked' && promptOwed.current) {
        void prompt();
      }
    });
    return () => sub.remove();
  }, [lock, prompt]);

  const Theme = useTheme();
  if (state === 'open' || signedOut) return null;
  const body = (
    <View style={styles.cover} accessibilityViewIsModal>
      {state === 'locked' ? (
        <>
          <Feather name="lock" size={28} color={Theme.textMuted} />
          <Text style={styles.title}>Codecast is locked</Text>
          <Pressable accessibilityRole="button" onPress={() => void prompt()} style={styles.unlock}>
            <Text style={styles.unlockText}>Unlock</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => void signOut()} hitSlop={8}>
            <Text style={styles.signOut}>Sign out</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
  return FullWindowOverlay && state !== 'cover'
    ? <FullWindowOverlay key={foregroundings}>{body}</FullWindowOverlay>
    : body;
}

const styles = themedStyles((Theme) => StyleSheet.create({
  cover: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.lg,
    padding: Spacing.xxl,
    backgroundColor: Theme.bg,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    color: Theme.text,
  },
  unlock: {
    paddingHorizontal: Spacing.xxl,
    paddingVertical: Spacing.md,
    borderRadius: 8,
    backgroundColor: Theme.blue,
  },
  unlockText: {
    fontWeight: '600',
    color: '#ffffff',
  },
  signOut: {
    color: Theme.textMuted,
  },
}));
