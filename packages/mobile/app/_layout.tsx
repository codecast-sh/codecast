import '@/lib/polyfills';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { useFonts } from 'expo-font';
import { Stack, useRouter, useSegments, usePathname } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as SecureStore from 'expo-secure-store';
import * as Linking from 'expo-linking';
import { AppState } from 'react-native';
import { useEffect, useRef } from 'react';
import 'react-native-reanimated';
import { GestureHandlerRootView } from '@/lib/gestureHandler';
import { ConvexProvider } from 'convex/react';
import { ConvexAuthProvider } from '@convex-dev/auth/react';
import { useQuery } from 'convex/react';

import { Theme } from '@/constants/Theme';
import { Mono } from '@/constants/fonts';
import { convex, CONVEX_URL } from '@/lib/convex';
import { AuthProvider, useAuth } from '@/lib/auth';
import { usePushNotifications } from '@/hooks/usePushNotifications';
import { mobileRouteForUrl } from '@/lib/linkRoutes';
import { initAnalytics, identifyUser, resetUser, trackScreen, wrapRoot } from '@/lib/analytics';
import { api } from '@codecast/convex/convex/_generated/api';
import { CallOverlay } from '@/components/calls/CallOverlay';


// Keychain failures must degrade to "signed out", never hang auth: a rejected
// getItem propagates into @convex-dev/auth's boot read, which is fired as
// `void readStateFromStorage()` — the rejection is swallowed, isLoading stays
// true forever, and the user is soft-locked on the skeleton inbox with no way
// to reach the login screen.
const secureStorage = {
  getItem: async (key: string) => {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  setItem: async (key: string, value: string) => {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {}
  },
  removeItem: async (key: string) => {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {}
  },
};

// Dev-only auth injection for simulator e2e harnesses (driven over the Hermes
// inspector): writes a minted token pair into the SAME storage the auth
// provider reads, using its exact key derivation (`<key>_<escaped CONVEX_URL>`).
// Reload after calling; the provider boots signed in. Never bundled in release.
if (__DEV__) {
  const ns = CONVEX_URL.replace(/[^a-zA-Z0-9]/g, "");
  (global as any).__devAuth = async (jwt: string, refresh: string) => {
    await secureStorage.setItem(`__convexAuthJWT_${ns}`, jwt);
    await secureStorage.setItem(`__convexAuthRefreshToken_${ns}`, refresh);
    return "ok";
  };
}

export {
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

SplashScreen.preventAutoHideAsync();

function RootLayout() {
  const [loaded, error] = useFonts({
    // JetBrains Mono is the app face, same as web. One key per face — the
    // resolver in constants/fonts.ts swaps families per fontWeight because a
    // runtime-loaded family holds a single face (see monoStyle). The legacy
    // "SpaceMono" key aliases Regular so old call sites keep rendering.
    SpaceMono: require('../assets/fonts/JetBrainsMono-Regular.ttf'),
    JetBrainsMono: require('../assets/fonts/JetBrainsMono-Regular.ttf'),
    'JetBrainsMono-Medium': require('../assets/fonts/JetBrainsMono-Medium.ttf'),
    'JetBrainsMono-SemiBold': require('../assets/fonts/JetBrainsMono-SemiBold.ttf'),
    'JetBrainsMono-Bold': require('../assets/fonts/JetBrainsMono-Bold.ttf'),
    'JetBrainsMono-Italic': require('../assets/fonts/JetBrainsMono-Italic.ttf'),
    ...FontAwesome.font,
  });

  // Initialize analytics AFTER the first mount, never at module-eval. On the
  // Feb App Store binary the Sentry/PostHog native modules are absent; running
  // this before render risks throwing during initial JS evaluation — before
  // expo-updates can mark the OTA "launched" — which silently auto-rolls-back
  // the update (the "stuck on the old version" symptom). Post-mount the app has
  // already rendered, so even a failure here cannot trigger a rollback.
  useEffect(() => {
    initAnalytics();
  }, []);

  // Screen views for every route change. Declared after initAnalytics so the
  // mount-time firing sees an initialized client (effects run top-down).
  const pathname = usePathname();
  useEffect(() => {
    if (pathname) trackScreen(pathname);
  }, [pathname]);

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;

    // Fetch OTA updates in the background, but DON'T reloadAsync() mid-session —
    // that yanks the user out of whatever they're typing/scrolling, and an eager
    // unconditional reload maximizes blast radius if an update is bad (see the
    // OTA dep-skew brick-on-launch history). Instead apply the fetched update the
    // next time the app goes to the background, the standard expo-updates pattern.
    let updatePending = false;
    let cancelled = false;

    async function checkForUpdates() {
      if (__DEV__) return;
      try {
        const Updates = await import('expo-updates');
        const update = await Updates.checkForUpdateAsync();
        if (cancelled || !update.isAvailable) return;
        await Updates.fetchUpdateAsync();
        if (!cancelled) updatePending = true;
      } catch (e) {
        console.log('OTA update check failed:', e);
      }
    }

    const sub = AppState.addEventListener('change', (state) => {
      if (updatePending && (state === 'background' || state === 'inactive')) {
        updatePending = false;
        import('expo-updates')
          .then((Updates) => Updates.reloadAsync())
          .catch(() => {});
      }
    });

    checkForUpdates();
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  return <RootLayoutNav />;
}

export default wrapRoot(RootLayout);

// Navigation chrome (stack headers, back buttons, tab bar) renders outside
// our StyleSheets, so parity with web has to come through the nav theme:
// Solarized surfaces + JetBrains Mono faces. fontWeight stays 'normal' in
// every entry — the face carries the weight (see constants/fonts.ts).
const SolarizedNavTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: Theme.blue,
    background: Theme.bg,
    card: Theme.bgAlt,
    text: Theme.text,
    border: Theme.borderLight,
    notification: Theme.red,
  },
  fonts: {
    regular: { fontFamily: Mono.regular, fontWeight: 'normal' },
    medium: { fontFamily: Mono.medium, fontWeight: 'normal' },
    bold: { fontFamily: Mono.semiBold, fontWeight: 'normal' },
    heavy: { fontFamily: Mono.bold, fontWeight: 'normal' },
  },
} as const;

function RootLayoutNav() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ConvexProvider client={convex}>
        <ConvexAuthProvider client={convex} storage={secureStorage}>
          <AuthProvider>
            <ThemeProvider value={SolarizedNavTheme}>
              <AnalyticsIdentify />
              <AuthGate>
                <Stack>
                  <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                  <Stack.Screen name="auth/login" options={{ title: 'Login', headerShown: false }} />
                  <Stack.Screen name="auth/signup" options={{ title: 'Sign Up', headerShown: false }} />
                  <Stack.Screen name="session/[id]" options={{ title: 'Conversation' }} />
                  <Stack.Screen name="task/[id]" options={{ title: 'Task' }} />
                  <Stack.Screen name="plan/[id]" options={{ title: 'Plan' }} />
                  <Stack.Screen name="doc/[id]" options={{ title: 'Doc' }} />
                  <Stack.Screen name="modal" options={{ presentation: 'modal' }} />
                  <Stack.Screen
                    name="call"
                    options={{ presentation: 'fullScreenModal', headerShown: false, animation: 'slide_from_bottom' }}
                  />
                </Stack>
                <CallOverlay />
              </AuthGate>
            </ThemeProvider>
          </AuthProvider>
        </ConvexAuthProvider>
      </ConvexProvider>
    </GestureHandlerRootView>
  );
}

function AnalyticsIdentify() {
  const user = useQuery(api.users.getCurrentUser);
  const lastId = useRef<string | null>(null);
  const id = user?._id ?? null;
  useEffect(() => {
    if (id && id !== lastId.current) {
      lastId.current = id;
      identifyUser(id, {
        ...(user!.email && { email: user!.email }),
        ...(user!.name && { name: user!.name }),
        ...(user!.github_username && { github_username: user!.github_username }),
      });
    } else if (!id && lastId.current) {
      lastId.current = null;
      resetUser();
    }
  }, [id]);
  return null;
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  usePushNotifications();

  // Handle deep links from web URLs
  useEffect(() => {
    if (!isAuthenticated) return;

    function handleUrl(event: { url: string }) {
      const route = mobileRouteForUrl(event.url);
      if (route) router.push(route as any);
    }

    const subscription = Linking.addEventListener('url', handleUrl);

    // Handle initial URL (app opened via link)
    Linking.getInitialURL().then((url) => {
      if (url) {
        const route = mobileRouteForUrl(url);
        if (route) {
          setTimeout(() => router.push(route as any), 500);
        }
      }
    });

    return () => subscription.remove();
  }, [isAuthenticated, router]);

  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === 'auth';

    if (!isAuthenticated && !inAuthGroup) {
      router.replace('/auth/login');
    } else if (isAuthenticated && inAuthGroup) {
      router.replace('/');
    }
  }, [isAuthenticated, isLoading, segments]);

  return <>{children}</>;
}
