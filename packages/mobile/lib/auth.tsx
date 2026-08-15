import { useEffect, useRef, useState, createContext, useContext, ReactNode } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { useAuthActions, useAuthToken } from '@convex-dev/auth/react';
import { useConvexAuth, useQuery } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { clearProtectedInboxMemory, useInboxStore } from '@codecast/web/store/inboxStore';
import { openPrincipalDispatchOutbox } from './dispatchOutbox';

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
  signInWithEmail: (email: string, password: string) => Promise<{ needsVerification: boolean }>;
  signUpWithEmail: (email: string, password: string) => Promise<{ needsVerification: boolean }>;
  verifyEmailCode: (email: string, code: string) => Promise<void>;
  signOut: () => Promise<void>;
  enableBiometric: () => Promise<void>;
  disableBiometric: () => Promise<void>;
  authenticateWithBiometric: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function parseAccessIdentity(token: string | null): { principalId: string; subject: string } | null {
  if (!token || typeof atob !== 'function') return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const decode = (value: string) => JSON.parse(atob(
      value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='),
    ));
    const header = decode(parts[0]);
    const payload = decode(parts[1]);
    if (header.alg !== 'RS256' || payload.aud !== 'convex' ||
      typeof payload.iss !== 'string' || typeof payload.sub !== 'string') return null;
    const [principalId, sessionId, ...extra] = payload.sub.split('|');
    if (!principalId || !sessionId || extra.length > 0) return null;
    return { principalId, subject: payload.sub };
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { signIn, signOut: convexSignOut } = useAuthActions();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const accessToken = useAuthToken();
  const accessIdentity = parseAccessIdentity(accessToken);
  const currentUser = useQuery(api.users.getCurrentUser, isAuthenticated ? {} : 'skip');
  const currentUserId = currentUser?._id?.toString() ?? null;
  const [verifiedSubject, setVerifiedSubject] = useState<string | null>(null);
  const visibleSubject = isAuthenticated && accessIdentity &&
    verifiedSubject === accessIdentity.subject && currentUserId === accessIdentity.principalId
    ? accessIdentity.subject
    : null;
  const lastVisibleSubject = useRef<string | null>(null);
  const outboxSubject = useRef<string | null>(null);
  const [outboxReadySubject, setOutboxReadySubject] = useState<string | null>(null);
  const [outboxFailure, setOutboxFailure] = useState<{
    subject: string;
    message: string;
  } | null>(null);
  const [outboxOpenAttempt, setOutboxOpenAttempt] = useState(0);
  const dispatchGeneration = useRef(0);
  const durableSubject = visibleSubject &&
    outboxReadySubject === visibleSubject
    ? visibleSubject
    : null;

  // This gate runs during render: a token/account change cannot wait for an
  // effect cleanup while an old retry is still in flight.
  if (lastVisibleSubject.current !== visibleSubject) {
    clearProtectedInboxMemory();
    lastVisibleSubject.current = visibleSubject;
    dispatchGeneration.current++;
  }
  // Close the old account's enqueue surface in the same render that closes
  // dispatch authorization. The native SQLite rows remain intact and
  // principal-keyed, but no click in the transition window can capture the old
  // principal's outbox closure.
  if (outboxSubject.current !== visibleSubject) {
    (useInboxStore.getState() as unknown as {
      _setOutbox(
        enqueue: ((entry: any) => void | Promise<void>) | null,
        remove: ((id: string) => Promise<void>) | null,
        load: (() => Promise<any[]>) | null,
      ): void;
    })._setOutbox(null, null, null);
    outboxSubject.current = visibleSubject;
  }

  useEffect(() => {
    const subject = visibleSubject;
    // A verified identity is necessary but not sufficient for writable UI:
    // until its principal-keyed SQLite outbox is installed, a dispatch could
    // reach the server without a durable replay record. Keep authorization and
    // children closed through the entire open (and after an open failure).
    setOutboxReadySubject(null);
    setOutboxFailure(null);
    if (!subject || !currentUserId) return;
    let cancelled = false;
    void openPrincipalDispatchOutbox(currentUserId)
      .then((outbox) => {
        if (
          cancelled ||
          outboxSubject.current !== subject ||
          lastVisibleSubject.current !== subject
        ) {
          return;
        }
        const store = useInboxStore.getState() as unknown as {
          _setOutbox(
            enqueue: (entry: any) => void | Promise<void>,
            remove: (id: string) => Promise<void>,
            load: () => Promise<any[]>,
          ): void;
          _drainOutbox(): void;
        };
        store._setOutbox(outbox.enqueue, outbox.remove, outbox.load);
        setOutboxReadySubject(subject);
        // Dispatch may already have wired while SQLite was opening. Re-drive
        // immediately so a prior-launch entry does not wait for another bind.
        store._drainOutbox();
      })
      .catch((error) => {
        if (
          cancelled ||
          outboxSubject.current !== subject ||
          lastVisibleSubject.current !== subject
        ) {
          return;
        }
        // Callers still fail honestly with parked:false while storage is
        // unavailable; never fall back to pretending the write was durable.
        console.error('[local-first] mobile dispatch outbox unavailable', error);
        setOutboxFailure({
          subject,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
      setOutboxReadySubject((current) =>
        current === subject ? null : current,
      );
      if (outboxSubject.current === subject) {
        (useInboxStore.getState() as unknown as {
          _setOutbox(
            enqueue: ((entry: any) => void | Promise<void>) | null,
            remove: ((id: string) => Promise<void>) | null,
            load: (() => Promise<any[]>) | null,
          ): void;
        })._setOutbox(null, null, null);
      }
    };
  }, [visibleSubject, currentUserId, outboxOpenAttempt]);

  useEffect(() => {
    if (!isAuthenticated || !accessIdentity || currentUser === undefined) {
      if (!isAuthenticated) setVerifiedSubject(null);
      return;
    }
    setVerifiedSubject(currentUserId === accessIdentity.principalId
      ? accessIdentity.subject
      : null);
  }, [isAuthenticated, accessIdentity?.principalId, accessIdentity?.subject, currentUser, currentUserId]);
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

  // When the backend has email verification enabled (Password provider
  // `verify`), signUp/signIn resolve with signingIn:false after emailing an
  // OTP; the caller must then collect the code and call verifyEmailCode.
  const signInWithEmail = async (email: string, password: string) => {
    const result = await signIn('password', { email, password, flow: 'signIn' });
    return { needsVerification: result?.signingIn === false };
  };

  const signUpWithEmail = async (email: string, password: string) => {
    const result = await signIn('password', { email, password, flow: 'signUp' });
    return { needsVerification: result?.signingIn === false };
  };

  const verifyEmailCode = async (email: string, code: string) => {
    await signIn('password', { email, code, flow: 'email-verification' });
  };

  const signOut = async () => {
    clearProtectedInboxMemory();
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
        verifyEmailCode,
        signOut,
        enableBiometric,
        disableBiometric,
        authenticateWithBiometric,
      }}
    >
      {isLoading || (isAuthenticated && !visibleSubject)
        ? null
        : isAuthenticated && !durableSubject
          ? outboxFailure?.subject === visibleSubject
            ? (
              <View
                accessibilityRole="alert"
                style={{
                  flex: 1,
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 12,
                  padding: 24,
                  backgroundColor: '#111827',
                }}
              >
                <Text style={{ color: '#f9fafb', fontSize: 18, fontWeight: '600' }}>
                  Local storage is unavailable
                </Text>
                <Text
                  style={{ color: '#d1d5db', textAlign: 'center', maxWidth: 420 }}
                >
                  Codecast kept writing disabled so no work can be lost.
                  {outboxFailure.message ? ` ${outboxFailure.message}` : ''}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setOutboxOpenAttempt((attempt) => attempt + 1)}
                  style={{
                    paddingHorizontal: 18,
                    paddingVertical: 10,
                    borderRadius: 8,
                    backgroundColor: '#2563eb',
                  }}
                >
                  <Text style={{ color: '#ffffff', fontWeight: '600' }}>Retry</Text>
                </Pressable>
              </View>
            )
            : null
          : children}
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
