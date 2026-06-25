import { useEffect, useState, createContext, useContext, ReactNode } from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { useAuthActions } from '@convex-dev/auth/react';
import { useConvexAuth } from 'convex/react';

const TOKEN_KEY = 'convex_auth_token';
const BIOMETRIC_ENABLED_KEY = 'biometric_enabled';

export interface AuthContextType {
  isAuthenticated: boolean;
  isLoading: boolean;
  isBiometricAvailable: boolean;
  isBiometricEnabled: boolean;
  isAppleAuthAvailable: boolean;
  signInWithGitHub: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  enableBiometric: () => Promise<void>;
  disableBiometric: () => Promise<void>;
  authenticateWithBiometric: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { signIn, signOut: convexSignOut } = useAuthActions();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const [isBiometricAvailable, setIsBiometricAvailable] = useState(false);
  const [isBiometricEnabled, setIsBiometricEnabled] = useState(false);
  const [isAppleAuthAvailable, setIsAppleAuthAvailable] = useState(false);

  useEffect(() => {
    checkBiometricAvailability();
    checkBiometricEnabled();
    checkAppleAuthAvailability();
  }, []);

  const checkAppleAuthAvailability = async () => {
    if (Platform.OS === 'ios') {
      const isAvailable = await AppleAuthentication.isAvailableAsync();
      setIsAppleAuthAvailable(isAvailable);
    }
  };

  const checkBiometricAvailability = async () => {
    const compatible = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    setIsBiometricAvailable(compatible && enrolled);
  };

  const checkBiometricEnabled = async () => {
    const enabled = await SecureStore.getItemAsync(BIOMETRIC_ENABLED_KEY);
    setIsBiometricEnabled(enabled === 'true');
  };

  const handleOAuthSignIn = async (provider: string) => {
    const redirectUrl = Linking.createURL('auth/callback');
    const result = await signIn(provider, { redirectTo: redirectUrl });
    if (result.redirect) {
      const browserResult = await WebBrowser.openAuthSessionAsync(
        result.redirect.toString(),
        redirectUrl,
      );
      if (browserResult.type === 'success' && browserResult.url) {
        const url = new URL(browserResult.url);
        const code = url.searchParams.get('code');
        if (code) {
          await signIn(provider, { code });
        }
      }
    }
  };

  const signInWithGitHub = async () => {
    await handleOAuthSignIn('github');
  };

  const signInWithApple = async () => {
    // Native Sign in with Apple: present Apple's system sheet and hand the
    // resulting identity token to our `apple-native` Convex provider, which
    // verifies it server-side. No web browser / OAuth redirect (the old path,
    // which errored under App Store review). Apple returns the full name + email
    // ONLY on the first authorization, so we forward them when present.
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
    if (!credential.identityToken) {
      throw new Error('No identity token returned from Apple');
    }
    const fullName = credential.fullName
      ? `${credential.fullName.givenName ?? ''} ${credential.fullName.familyName ?? ''}`.trim()
      : '';
    // Only forward name/email when Apple actually provided them (first sign-in
    // only). Convex `Value` rejects `undefined`, so omit the keys rather than
    // pass undefined.
    const params: Record<string, string> = { idToken: credential.identityToken };
    if (credential.email) params.email = credential.email;
    if (fullName) params.fullName = fullName;
    await signIn('apple-native', params);
  };

  const signInWithEmail = async (email: string, password: string) => {
    await signIn('password', { email, password, flow: 'signIn' });
  };

  const signUpWithEmail = async (email: string, password: string) => {
    await signIn('password', { email, password, flow: 'signUp' });
  };

  const signOut = async () => {
    await convexSignOut();
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  };

  const enableBiometric = async () => {
    await SecureStore.setItemAsync(BIOMETRIC_ENABLED_KEY, 'true');
    setIsBiometricEnabled(true);
  };

  const disableBiometric = async () => {
    await SecureStore.deleteItemAsync(BIOMETRIC_ENABLED_KEY);
    setIsBiometricEnabled(false);
  };

  const authenticateWithBiometric = async (): Promise<boolean> => {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Authenticate to access Codecast',
      fallbackLabel: 'Use password',
    });
    return result.success;
  };

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        isLoading,
        isBiometricAvailable,
        isBiometricEnabled,
        isAppleAuthAvailable,
        signInWithGitHub,
        signInWithApple,
        signInWithEmail,
        signUpWithEmail,
        signOut,
        enableBiometric,
        disableBiometric,
        authenticateWithBiometric,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
