import { useEffect, useState, createContext, useContext, ReactNode } from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import * as AppleAuthentication from 'expo-apple-authentication';
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

  const signInWithGitHub = async () => {
    await signIn('github');
  };

  const signInWithApple = async () => {
    if (Platform.OS !== 'ios') {
      throw new Error('Apple Sign In is only available on iOS');
    }
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
    if (credential.identityToken) {
      await signIn('apple', { idToken: credential.identityToken });
    } else {
      throw new Error('No identity token received from Apple');
    }
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
