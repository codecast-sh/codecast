// Native Sign in with Apple: present Apple's system sheet and hand the
// resulting identity token to the `apple-native` Convex provider, which
// verifies it server side. No web browser and no OAuth redirect (the old path
// errored under App Store review). Apple returns the full name and email ONLY
// on the first authorization, so they are forwarded when present.

export type AppleCredentialLike = {
  identityToken: string | null;
  email?: string | null;
  fullName?: { givenName?: string | null; familyName?: string | null } | null;
};

export type AppleAuthenticationLike = {
  isAvailableAsync(): Promise<boolean>;
  signInAsync(options: { requestedScopes: any[] }): Promise<AppleCredentialLike>;
  AppleAuthenticationScope: { FULL_NAME: any; EMAIL: any };
};

/**
 * The params passed to `signIn("apple-native", params)`. Only forwards
 * name/email when Apple actually provided them (first sign-in only). Convex
 * `Value` rejects `undefined`, so the keys are omitted rather than passed
 * as undefined.
 */
export function appleNativeSignInParams(credential: AppleCredentialLike): Record<string, string> {
  if (!credential.identityToken) {
    throw new Error('No identity token returned from Apple');
  }
  const fullName = credential.fullName
    ? `${credential.fullName.givenName ?? ''} ${credential.fullName.familyName ?? ''}`.trim()
    : '';
  const params: Record<string, string> = { idToken: credential.identityToken };
  if (credential.email) params.email = credential.email;
  if (fullName) params.fullName = fullName;
  return params;
}

/** Run the whole sheet flow: Apple sheet, then the Convex sign-in. */
export async function signInWithAppleNative(
  apple: AppleAuthenticationLike,
  signIn: (provider: string, params: Record<string, string>) => Promise<unknown>,
  providerId: string = 'apple-native',
): Promise<void> {
  const credential = await apple.signInAsync({
    requestedScopes: [apple.AppleAuthenticationScope.FULL_NAME, apple.AppleAuthenticationScope.EMAIL],
  });
  await signIn(providerId, appleNativeSignInParams(credential));
}
