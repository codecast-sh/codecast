// The phone's device key (lib/deviceKey) signs with noble's P-256; the server
// (convex/deviceKeys.verifyDeviceKey) checks with WebCrypto. This holds the
// two formats together: an uncompressed public point and a compact r||s
// signature over the SHA-256 of deviceKeyMessage, from a 48-byte seed.
import { expect, test } from 'bun:test';
import { p256 } from '@noble/curves/nist.js';
import { deviceKeyMessage } from '@codecast/shared/contracts/secrets';

test('a noble P-256 signature over the device key message verifies under WebCrypto, and only for that message', async () => {
  const secret = p256.utils.randomSecretKey(crypto.getRandomValues(new Uint8Array(48)));
  const pub = p256.getPublicKey(secret, false);
  expect(pub.length).toBe(65);
  const msg = new TextEncoder().encode(deviceKeyMessage('presence', 'Q2hhbGxlbmdlVmFsdWU'));
  const sig = p256.sign(msg, secret);
  expect(sig.length).toBe(64);
  const key = await crypto.subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const verify = (m: Uint8Array) => crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, m);
  expect(await verify(msg)).toBe(true);
  expect(await verify(new TextEncoder().encode(deviceKeyMessage('register', 'Q2hhbGxlbmdlVmFsdWU')))).toBe(false);
});
