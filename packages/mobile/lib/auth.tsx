import { useCallback, useEffect, useMemo, useRef, useState, createContext, useContext, ReactNode } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Text } from '@/components/Themed';
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { useAuthActions, useAuthToken } from '@convex-dev/auth/react';
import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { getDevicePushToken } from './devicePushToken';
import { api } from '@codecast/convex/convex/_generated/api';
import { clearProtectedInboxMemory, useInboxStore } from '@codecast/web/store/inboxStore';
import { purgeLocalCache } from '@codecast/web/store/idbCache';
import { parseAccessIdentity } from './cachePrincipal';
import { openPrincipalDispatchOutbox } from './dispatchOutbox';
import * as SplashScreen from 'expo-splash-screen';
import { authRenderDecision, localBootTrust, shouldClearMemoryFor, shouldReleaseSplash } from './authTrust';
import { bootMark } from './bootProfile';
import { STORE_SHOTS } from './storeShots/flag';
import { setCatchUpToken } from './foregroundResume';
import { unlockVerdict } from './biometricLock';

const BIOMETRIC_ENABLED_KEY = 'biometric_enabled';
// The last principal this device verified with the server — the owner of the
// SQLite cache. Local-first boot trust anchors on it (see lib/authTrust).
const LAST_PRINCIPAL_KEY = 'last_verified_principal';

export interface AuthContextType {
  isAuthenticated: boolean;
  isLoading: boolean;
  // Who is signed in. Already resolved here, so consumers that only need the
  // id (the push catch-up watermark is per user) read it instead of mounting a
  // second getCurrentUser subscription of their own.
  currentUserId: string | null;
  isBiometricAvailable: boolean;
  isBiometricEnabled: boolean;
  // False for the instant the keychain read of the setting takes at launch.
  // The lock (components/BiometricGate) covers the app until it is known.
  isBiometricSettingLoaded: boolean;
  isAppleAuthAvailable: boolean;
  signInWithGitHub: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<{ needsVerification: boolean }>;
  signUpWithEmail: (email: string, password: string) => Promise<{ needsVerification: boolean }>;
  verifyEmailCode: (email: string, code: string) => Promise<void>;
  signOut: () => Promise<void>;
  enableBiometric: () => Promise<void>;
  disableBiometric: () => Promise<void>;
  // The system's check (Face ID, Touch ID, or the device passcode when those
  // fail). True when the app may open; see lib/biometricLock for the phone
  // that has nothing to check against.
  authenticateWithBiometric: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function RealAuthProvider({ children }: { children: ReactNode }) {
  const { signIn, signOut: convexSignOut } = useAuthActions();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const accessToken = useAuthToken();
  useEffect(() => setCatchUpToken(accessToken ?? null), [accessToken]);
  const accessIdentity = parseAccessIdentity(accessToken);
  const currentUser = useQuery(api.users.getCurrentUser, isAuthenticated ? {} : 'skip');
  const currentUserId = currentUser?._id?.toString() ?? null;
  const [verifiedSubject, setVerifiedSubject] = useState<string | null>(null);
  const visibleSubject = isAuthenticated && accessIdentity &&
    verifiedSubject === accessIdentity.subject && currentUserId === accessIdentity.principalId
    ? accessIdentity.subject
    : null;
  // Local-first boot: the persisted trust anchor (last server-verified
  // principal). undefined while the SecureStore read is in flight — a ms-long
  // gate, unlike the network round-trip visibleSubject needs.
  const [bootPrincipal, setBootPrincipal] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    SecureStore.getItemAsync(LAST_PRINCIPAL_KEY)
      .then((v) => setBootPrincipal((cur) => (cur === undefined ? v : cur)))
      .catch(() => setBootPrincipal((cur) => (cur === undefined ? null : cur)));
  }, []);
  // The subject this launch acts as. Server verification wins when present;
  // before it lands (or offline, where it never lands) a token naming the
  // cache-owner principal is trusted locally, so the hydrated cache renders
  // and writes park durably without waiting on the network.
  const trustedSubject = visibleSubject ?? localBootTrust({
    accessIdentity,
    bootPrincipal,
    isAuthenticated,
    currentUserLoaded: currentUser !== undefined,
    currentUserId,
  });
  const trustedPrincipalId = trustedSubject && accessIdentity ? accessIdentity.principalId : null;
  const lastTrustedSubject = useRef<string | null>(null);
  const outboxSubject = useRef<string | null>(null);
  // Which principal's data occupies the shared store right now: seeded from
  // the disk cache's owner once the anchor is read, replaced when a clear
  // installs a new owner.
  const memoryPrincipal = useRef<string | null | undefined>(undefined);
  const [outboxReadySubject, setOutboxReadySubject] = useState<string | null>(null);
  const [outboxFailure, setOutboxFailure] = useState<{
    subject: string;
    message: string;
  } | null>(null);
  const [outboxOpenAttempt, setOutboxOpenAttempt] = useState(0);
  const dispatchGeneration = useRef(0);
  const hydrated = useInboxStore((s) => s.clientStateInitialized);

  // These gates run during render: a token/account change cannot wait for an
  // effect cleanup while an old retry is still in flight.
  if (memoryPrincipal.current === undefined && bootPrincipal !== undefined) {
    memoryPrincipal.current = bootPrincipal;
  }
  // Clear on PRINCIPAL change only. The old subject-keyed clear fired on every
  // boot's null → subject transition and wiped the cache SQLite hydration had
  // just loaded — the bug that made the phone boot server-first.
  if (shouldClearMemoryFor(memoryPrincipal.current, trustedPrincipalId)) {
    clearProtectedInboxMemory();
    memoryPrincipal.current = trustedPrincipalId;
    // The disk copy belongs to whoever held the store before. The clear above
    // unbound write-through, so nothing of theirs lands after this delete;
    // the new principal's own typed messages stay.
    void purgeLocalCache({ keepPendingInputFor: trustedPrincipalId }).catch((error) => {
      console.error('[auth] failed to purge the previous account\'s cache', error);
    });
  }
  if (lastTrustedSubject.current !== trustedSubject) {
    lastTrustedSubject.current = trustedSubject;
    dispatchGeneration.current++;
  }
  // Close the old account's enqueue surface in the same render that closes
  // dispatch authorization. The native SQLite rows remain intact and
  // principal-keyed, but no click in the transition window can capture the old
  // principal's outbox closure.
  if (outboxSubject.current !== trustedSubject) {
    (useInboxStore.getState() as unknown as {
      _setOutbox(
        enqueue: ((entry: any) => void | Promise<void>) | null,
        remove: ((id: string) => Promise<void>) | null,
        load: (() => Promise<any[]>) | null,
      ): void;
    })._setOutbox(null, null, null);
    outboxSubject.current = trustedSubject;
  }

  useEffect(() => {
    const subject = trustedSubject;
    const principalId = trustedPrincipalId;
    // Until the trusted principal's SQLite outbox is installed, a dispatch
    // could reach the server without a durable replay record. Keep the enqueue
    // surface closed through the entire open (and after an open failure).
    // Keyed on the LOCALLY trusted principal, not the verified user id, so the
    // outbox opens at boot — offline included — instead of after a round-trip.
    setOutboxReadySubject(null);
    setOutboxFailure(null);
    if (!subject || !principalId) return;
    let cancelled = false;
    void openPrincipalDispatchOutbox(principalId)
      .then((outbox) => {
        if (
          cancelled ||
          outboxSubject.current !== subject ||
          lastTrustedSubject.current !== subject
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
          lastTrustedSubject.current !== subject
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
  }, [trustedSubject, trustedPrincipalId, outboxOpenAttempt]);

  useEffect(() => {
    if (!isAuthenticated || !accessIdentity || currentUser === undefined) {
      if (!isAuthenticated) setVerifiedSubject(null);
      return;
    }
    const verified = currentUserId === accessIdentity.principalId;
    setVerifiedSubject(verified ? accessIdentity.subject : null);
    if (verified) {
      // Persist the trust anchor so the NEXT boot renders the cache before any
      // network. Also adopt it in-memory: the boot read may still be in flight
      // (or have found nothing on a first login).
      setBootPrincipal(accessIdentity.principalId);
      void SecureStore.setItemAsync(LAST_PRINCIPAL_KEY, accessIdentity.principalId).catch(() => {});
    }
  }, [isAuthenticated, accessIdentity?.principalId, accessIdentity?.subject, currentUser, currentUserId]);
  const [isBiometricAvailable, setIsBiometricAvailable] = useState(false);
  const [isBiometricEnabled, setIsBiometricEnabled] = useState(false);
  const [isBiometricSettingLoaded, setIsBiometricSettingLoaded] = useState(false);
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

  // A keychain that cannot be read counts as the setting off: the lock must
  // never hold the app shut over a setting it could not load.
  const checkBiometricEnabled = async () => {
    try {
      const enabled = await SecureStore.getItemAsync(BIOMETRIC_ENABLED_KEY);
      setIsBiometricEnabled(enabled === 'true');
    } catch {
      setIsBiometricEnabled(false);
    } finally {
      setIsBiometricSettingLoaded(true);
    }
  };

  const handleOAuthSignIn = useCallback(async (provider: string) => {
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
  }, [signIn]);

  const signInWithGitHub = useCallback(async () => {
    await handleOAuthSignIn('github');
  }, [handleOAuthSignIn]);

  const signInWithApple = useCallback(async () => {
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
  }, [signIn]);

  // When the backend has email verification enabled (Password provider
  // `verify`), signUp/signIn resolve with signingIn:false after emailing an
  // OTP; the caller must then collect the code and call verifyEmailCode.
  const signInWithEmail = useCallback(async (email: string, password: string) => {
    const result = await signIn('password', { email, password, flow: 'signIn' });
    return { needsVerification: result?.signingIn === false };
  }, [signIn]);

  const signUpWithEmail = useCallback(async (email: string, password: string) => {
    const result = await signIn('password', { email, password, flow: 'signUp' });
    return { needsVerification: result?.signingIn === false };
  }, [signIn]);

  const verifyEmailCode = useCallback(async (email: string, code: string) => {
    await signIn('password', { email, code, flow: 'email-verification' });
  }, [signIn]);

  const clearPushToken = useMutation(api.users.clearPushToken);
  const signOut = useCallback(async () => {
    clearProtectedInboxMemory();
    // The disk cache goes with the session: on a shared phone the next person
    // to open the app must find nothing of this account's on disk. Write-through
    // is unbound by the clear above, so no late write refills it.
    await purgeLocalCache().catch((error) => {
      console.error('[auth] failed to purge the local cache on sign-out', error);
    });
    // Drop the local-first trust anchor with the session: a signed-out device
    // must not render the old principal's (now cleared) cache on next boot.
    memoryPrincipal.current = null;
    setBootPrincipal(null);
    // Keychain failures must not strand the session: memory is already
    // cleared, so the server sign-out below has to run whatever they do.
    await SecureStore.deleteItemAsync(LAST_PRINCIPAL_KEY).catch(() => {});
    // The lock belongs to the session that turned it on; the next account
    // (and the login screen) starts without it.
    setIsBiometricEnabled(false);
    await SecureStore.deleteItemAsync(BIOMETRIC_ENABLED_KEY).catch(() => {});
    // Take this phone off the account while the session can still authenticate
    // the call; otherwise the signed-out account keeps pushing to it. A failure
    // must not block sign-out.
    const pushToken = getDevicePushToken();
    if (pushToken) await clearPushToken({ push_token: pushToken }).catch(() => {});
    await convexSignOut();
  }, [convexSignOut, clearPushToken]);

  const enableBiometric = useCallback(async () => {
    await SecureStore.setItemAsync(BIOMETRIC_ENABLED_KEY, 'true');
    setIsBiometricEnabled(true);
  }, []);

  const disableBiometric = useCallback(async () => {
    await SecureStore.deleteItemAsync(BIOMETRIC_ENABLED_KEY);
    setIsBiometricEnabled(false);
  }, []);

  const authenticateWithBiometric = useCallback(async (): Promise<boolean> => {
    try {
      // No fallbackLabel and no disableDeviceFallback: the system offers the
      // device passcode by itself when Face ID or Touch ID cannot be used.
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock Codecast',
      });
      return unlockVerdict(result) !== 'stay';
    } catch {
      // The check itself could not run (no native module answer). Open, as for
      // a phone with nothing enrolled: a lock nobody can pass protects nothing.
      return true;
    }
  }, []);

  // Local-first render: a locally trusted boot shows the cached app
  // immediately; "blank" covers only the ms-long anchor read and an
  // untrusted token mid-verification (see authRenderDecision).
  const renderDecision = authRenderDecision({
    bootPrincipalLoaded: bootPrincipal !== undefined,
    trustedSubject,
    outboxFailureSubject: outboxFailure?.subject ?? null,
    isLoading,
    isAuthenticated,
  });
  // Hold the native splash until the store has the disk cache. Hiding on
  // fonts left a kill-and-reopen window where the inbox painted skeletons
  // on an empty store. The effect runs after that paint, still under the
  // splash, so the first visible frame is already the cached list.
  useEffect(() => {
    if (shouldReleaseSplash({ hydrated, authDecision: renderDecision })) {
      bootMark("splash-hide", { decision: renderDecision });
      void SplashScreen.hideAsync();
    }
  }, [hydrated, renderDecision]);

  // One value per real change: this provider re-renders on every push of the
  // user doc (getCurrentUser above), and a fresh object each time would
  // re-render every useAuth() consumer, the root gate included.
  const contextValue = useMemo<AuthContextType>(() => ({
    isAuthenticated,
    isLoading,
    currentUserId,
    isBiometricAvailable,
    isBiometricEnabled,
    isBiometricSettingLoaded,
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
  }), [
    isAuthenticated,
    isLoading,
    currentUserId,
    isBiometricAvailable,
    isBiometricEnabled,
    isBiometricSettingLoaded,
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
  ]);

  return (
    <AuthContext.Provider
      value={contextValue}
    >
      {(() => {
        if (renderDecision === "children") return children;
        if (renderDecision === "blank") return null;
        return (
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
                  {outboxFailure?.message ? ` ${outboxFailure.message}` : ''}
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
        );
      })()}
    </AuthContext.Provider>
  );
}

const storeShotsDone = async () => {};
const STORE_SHOTS_AUTH: AuthContextType = {
  isAuthenticated: true,
  isLoading: false,
  currentUserId: 'hero-u-me',
  isBiometricAvailable: false,
  isBiometricEnabled: false,
  isBiometricSettingLoaded: true,
  isAppleAuthAvailable: false,
  signInWithGitHub: storeShotsDone,
  signInWithApple: storeShotsDone,
  signInWithEmail: async () => ({ needsVerification: false }),
  signUpWithEmail: async () => ({ needsVerification: false }),
  verifyEmailCode: storeShotsDone,
  signOut: storeShotsDone,
  enableBiometric: storeShotsDone,
  disableBiometric: storeShotsDone,
  authenticateWithBiometric: async () => true,
};

// Store shots mode (lib/storeShots/flag): signed in as the fixture world's
// Alex Rivera with no server. Seeds the store once the disk cache has
// hydrated, so the cache can never merge over the fixture rows.
function StoreShotsAuthProvider({ children }: { children: ReactNode }) {
  const hydrated = useInboxStore((s) => s.clientStateInitialized);
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!hydrated || seeded) return;
    require('./storeShots/seed').seedStoreShots();
    setSeeded(true);
    void SplashScreen.hideAsync();
  }, [hydrated, seeded]);
  return (
    <AuthContext.Provider value={STORE_SHOTS_AUTH}>
      {seeded ? children : null}
    </AuthContext.Provider>
  );
}

export const AuthProvider = STORE_SHOTS ? StoreShotsAuthProvider : RealAuthProvider;

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
