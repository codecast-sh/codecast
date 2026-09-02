// The persisted trust anchor: the last principal this device verified with the
// server, stored in SecureStore. The module is injected so this package has no
// Expo dependency; pass `expo-secure-store` itself.
export type SecureStoreLike = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

export const DEFAULT_LAST_PRINCIPAL_KEY = 'last_verified_principal';
export const DEFAULT_BIOMETRIC_ENABLED_KEY = 'biometric_enabled';

export type TrustAnchorStore = {
  /** Null when nothing is stored or the read fails. */
  read: () => Promise<string | null>;
  /** Failure is swallowed: the anchor is a hint for the next boot, not state. */
  write: (principalId: string) => Promise<void>;
  clear: () => Promise<void>;
};

export function createTrustAnchorStore(
  store: SecureStoreLike,
  key: string = DEFAULT_LAST_PRINCIPAL_KEY,
): TrustAnchorStore {
  return {
    read: () => store.getItemAsync(key).catch(() => null),
    write: (principalId) => store.setItemAsync(key, principalId).catch(() => {}),
    clear: () => store.deleteItemAsync(key),
  };
}

export type BiometricPreference = {
  isEnabled: () => Promise<boolean>;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
};

/** The "require Face ID / Touch ID on open" preference, kept in SecureStore. */
export function createBiometricPreference(
  store: SecureStoreLike,
  key: string = DEFAULT_BIOMETRIC_ENABLED_KEY,
): BiometricPreference {
  return {
    isEnabled: async () => (await store.getItemAsync(key)) === 'true',
    enable: () => store.setItemAsync(key, 'true'),
    disable: () => store.deleteItemAsync(key),
  };
}

export type LocalAuthenticationLike = {
  hasHardwareAsync(): Promise<boolean>;
  isEnrolledAsync(): Promise<boolean>;
  authenticateAsync(options: { promptMessage: string; fallbackLabel?: string }): Promise<{ success: boolean }>;
};

/** Biometric gate helper over `expo-local-authentication`. */
export function createBiometricGate(
  localAuth: LocalAuthenticationLike,
  prompt: { promptMessage: string; fallbackLabel?: string },
) {
  return {
    isAvailable: async () => {
      const compatible = await localAuth.hasHardwareAsync();
      const enrolled = await localAuth.isEnrolledAsync();
      return compatible && enrolled;
    },
    authenticate: async (): Promise<boolean> => {
      const result = await localAuth.authenticateAsync(prompt);
      return result.success;
    },
  };
}
