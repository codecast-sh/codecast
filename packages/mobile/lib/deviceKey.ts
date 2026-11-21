// Face ID inside the app (web/lib/deviceKeyPresence, convex/deviceKeys.ts):
// the phone's device key, a P-256 key kept in the keychain behind biometry
// (expo-secure-store with requireAuthentication), so reading it to sign takes
// Face ID or Touch ID every time and it never leaves this phone. Its signature
// over the challenge confirms a gated press without the in-app browser.
//
// The key is made from expo-crypto's random bytes (Hermes has no crypto), a
// native module newer than some installed binaries: without it, or without
// enrolled biometry, the signer reads unavailable and presence.ts hands off to
// /confirm as before.
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Device from 'expo-device';
import { p256 } from '@noble/curves/nist.js';
import { deviceKeyMessage } from '@codecast/shared/contracts/secrets';
import type { DeviceKeySigner, Signed } from '@codecast/web/lib/deviceKeyPresence';
import { optionalNative } from './optionalNative';

const SECRET = 'codecast.device_key.secret';
const PUBLIC = 'codecast.device_key.public';
const CHALLENGE = /^[A-Za-z0-9_-]{16,128}$/;

const crypto = () => optionalNative('ExpoCrypto', () => require('expo-crypto') as typeof import('expo-crypto'));

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function toB64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));
const utf8 = (s: string) => new TextEncoder().encode(s);

async function credentialId(publicKey: string): Promise<string | null> {
  const c = crypto();
  if (!c) return null;
  const bytes = Uint8Array.from((publicKey.match(/../g) ?? []).map((h) => parseInt(h, 16)));
  return toB64url(new Uint8Array(await c.digest(c.CryptoDigestAlgorithm.SHA256, bytes)));
}

/** The person dismissing the system prompt is a cancel, said nowhere. */
const isCancel = (e: unknown) => /cancel/i.test(String((e as Error)?.message ?? e));

const pending = new Map<string, Uint8Array>();

export const phoneSigner: DeviceKeySigner = {
  async status() {
    const c = crypto();
    const biometric = !!c && (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
    const pub = biometric ? await SecureStore.getItemAsync(PUBLIC) : null;
    return { available: biometric, credential_id: pub ? await credentialId(pub) : null, name: Device.deviceName ?? Device.modelName ?? undefined };
  },
  async create({ challenge, reason }) {
    const c = crypto();
    if (!c || !CHALLENGE.test(challenge)) return { error: 'Face ID is not available on this phone' };
    const auth = await LocalAuthentication.authenticateAsync({ promptMessage: reason, disableDeviceFallback: false });
    if (!auth.success) return auth.error === 'user_cancel' || auth.error === 'system_cancel' || auth.error === 'app_cancel' ? { cancelled: true } : { error: 'Face ID did not finish' };
    const secret = p256.utils.randomSecretKey(c.getRandomBytes(48));
    const pub = p256.getPublicKey(secret, false);
    const id = (await credentialId(hex(pub)))!;
    pending.clear();
    pending.set(id, secret);
    const signature = p256.sign(utf8(deviceKeyMessage('register', challenge)), secret);
    return { public_key: toB64url(pub), signature: toB64url(signature), credential_id: id };
  },
  async keep(id) {
    const secret = pending.get(id);
    if (!secret) return { error: 'No new key to keep' };
    pending.clear();
    await SecureStore.setItemAsync(SECRET, hex(secret), {
      requireAuthentication: true,
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    await SecureStore.setItemAsync(PUBLIC, hex(p256.getPublicKey(secret, false)), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    return { kept: true };
  },
  async sign({ challenge, reason }): Promise<Signed> {
    if (!CHALLENGE.test(challenge)) return { error: 'Nothing to confirm' };
    const pub = await SecureStore.getItemAsync(PUBLIC);
    if (!pub) return { error: 'Face ID is not set up in this app' };
    let stored: string | null;
    try {
      stored = await SecureStore.getItemAsync(SECRET, { requireAuthentication: true, authenticationPrompt: reason });
    } catch (e) {
      return isCancel(e) ? { cancelled: true } : { error: (e as Error)?.message || 'Face ID did not finish' };
    }
    if (!stored) return { error: 'Face ID is not set up in this app' };
    const signature = p256.sign(utf8(deviceKeyMessage('presence', challenge)), unhex(stored));
    return { signature: toB64url(signature), credential_id: (await credentialId(pub))! };
  },
};
