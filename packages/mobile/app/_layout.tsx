import FontAwesome from '@expo/vector-icons/FontAwesome';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { useFonts } from 'expo-font';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as SecureStore from 'expo-secure-store';
import * as Linking from 'expo-linking';
import { useEffect, useRef } from 'react';
import 'react-native-reanimated';
import { ConvexProvider } from 'convex/react';
import { ConvexAuthProvider } from '@convex-dev/auth/react';
import { useQuery } from 'convex/react';

import { useColorScheme } from '@/components/useColorScheme';
import { convex } from '@/lib/convex';
import { AuthProvider, useAuth } from '@/lib/auth';
import { usePushNotifications } from '@/hooks/usePushNotifications';
import { initAnalytics, identifyUser, resetUser, Sentry } from '@/lib/analytics';
import { api } from '@codecast/convex/convex/_generated/api';

initAnalytics();
const secureStorage = {
  getItem: async (key: string) => {
    return await SecureStore.getItemAsync(key);
  },
  setItem: async (key: string, value: string) => {
    await SecureStore.setItemAsync(key, value);
  },
  removeItem: async (key: string) => {
    await SecureStore.deleteItemAsync(key);
  },
};

export {
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

SplashScreen.preventAutoHideAsync();

function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
    ...FontAwesome.font,
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  useEffect(() => {
    async function checkForUpdates() {
      if (__DEV__) return;

      try {
        const Updates = await import('expo-updates');
        const update = await Updates.checkForUpdateAsync();
        if (update.isAvailable) {
          await Updates.fetchUpdateAsync();
          await Updates.reloadAsync();
        }
      } catch (e) {
        console.log('OTA update check failed:', e);
      }
    }

    if (loaded) {
      checkForUpdates();
    }
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  return <RootLayoutNav />;
}

export default Sentry.wrap(RootLayout);

function RootLayoutNav() {
  const colorScheme = useColorScheme();

  return (
    <ConvexProvider client={convex}>
      <ConvexAuthProvider client={convex} storage={secureStorage}>
        <AuthProvider>
          <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
            <AnalyticsIdentify />
            <AuthGate>
              <Stack>
                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                <Stack.Screen name="auth/login" options={{ title: 'Login', headerShown: false }} />
                <Stack.Screen name="auth/signup" options={{ title: 'Sign Up', headerShown: false }} />
                <Stack.Screen name="session/[id]" options={{ title: 'Conversation' }} />
                <Stack.Screen name="task/[id]" options={{ title: 'Task' }} />
                <Stack.Screen name="plan/[id]" options={{ title: 'Plan' }} />
                <Stack.Screen name="modal" options={{ presentation: 'modal' }} />
              </Stack>
            </AuthGate>
          </ThemeProvider>
        </AuthProvider>
      </ConvexAuthProvider>
    </ConvexProvider>
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

function mapWebUrlToRoute(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'codecast.sh' && parsed.hostname !== 'www.codecast.sh') return null;
    const path = parsed.pathname;
    // Web /conversation/xxx -> mobile /session/xxx
    const convMatch = path.match(/^\/conversation\/([a-z0-9]+)/);
    if (convMatch) return `/session/${convMatch[1]}`;
    // /share/xxx -> /session/xxx (share tokens resolve to conversations)
    const shareMatch = path.match(/^\/share\/([a-zA-Z0-9]+)/);
    if (shareMatch) return `/session/${shareMatch[1]}`;
    // /tasks/xxx -> /task/xxx
    const taskMatch = path.match(/^\/tasks?\/([a-z0-9-]+)/);
    if (taskMatch) return `/task/${taskMatch[1]}`;
    // /plans/xxx -> /plan/xxx
    const planMatch = path.match(/^\/plans?\/([a-z0-9-]+)/);
    if (planMatch) return `/plan/${planMatch[1]}`;
    // /docs/xxx -> /doc/xxx
    const docMatch = path.match(/^\/docs?\/([a-z0-9-]+)/);
    if (docMatch) return `/doc/${docMatch[1]}`;
    // /join/xxx -> handled by web, but open team tab
    if (path.startsWith('/join/')) return '/(tabs)/team';
    return null;
  } catch (_e) {
    return null;
  }
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
      const route = mapWebUrlToRoute(event.url);
      if (route) router.push(route as any);
    }

    const subscription = Linking.addEventListener('url', handleUrl);

    // Handle initial URL (app opened via link)
    Linking.getInitialURL().then((url) => {
      if (url) {
        const route = mapWebUrlToRoute(url);
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
