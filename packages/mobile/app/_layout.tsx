import FontAwesome from '@expo/vector-icons/FontAwesome';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { useFonts } from 'expo-font';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as SecureStore from 'expo-secure-store';
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

function AuthGate({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  usePushNotifications();

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
