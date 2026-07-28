// Web half of the provider-key transport (pl-207, Phase 3): seal an API key to the
// device's ECDH public key with the browser's Web Crypto, so it can travel through
// Convex as ciphertext and only the daemon (holding the private key) can read it.
//
// This is the SubtleCrypto mirror of the daemon's node:crypto decrypt
// (packages/cli/src/providerKeyCrypto.ts); the two interoperate only because both
// use the exact parameters in @codecast/shared/contracts (providerKeyCrypto). The
// round-trip is unit-tested there. Do not change the algorithm on one side only.

import {
  PROVIDER_KEY_HKDF_INFO,
  type EncryptedProviderKeyPayload,
} from "@codecast/shared/contracts";

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Encrypt `apiKey` to a device's ECDH public key (its `provider_key_pubkey`, from
 * listDevices). Generates an ephemeral P-256 keypair, does ECDH to the device key,
 * derives an AES-256-GCM key via HKDF-SHA256, and returns the sealed payload to put
 * in an enqueueProviderKeyCommand call. Convex/anyone but the target daemon sees
 * only ciphertext.
 */
export async function encryptProviderKey(
  devicePublicKeyB64: string,
  provider: string,
  apiKey: string,
): Promise<EncryptedProviderKeyPayload> {
  const subtle = crypto.subtle;
  const devicePub = await subtle.importKey(
    "raw",
    fromB64(devicePublicKeyB64),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const eph = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const shared = await subtle.deriveBits({ name: "ECDH", public: devicePub }, eph.privateKey, 256);
  const hkdfKey = await subtle.importKey("raw", shared, { name: "HKDF" }, false, ["deriveKey"]);
  const aesKey = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(PROVIDER_KEY_HKDF_INFO) },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, aesKey, new TextEncoder().encode(apiKey));
  const epk = await subtle.exportKey("raw", eph.publicKey);
  return { provider, epk: toB64(epk), iv: toB64(iv), ct: toB64(ct) };
}
