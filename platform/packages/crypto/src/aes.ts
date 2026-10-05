import { decodeBase64, encodeBase64 } from './base64';
import { encodeUTF8, decodeUTF8 } from './text';

/** AES-GCM uses a 12 byte nonce. The nonce is written in front of the ciphertext. */
const IV_LENGTH = 12;

async function importAESKey(key64: string, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        'raw',
        decodeBase64(key64) as BufferSource,
        { name: 'AES-GCM' },
        false,
        [usage]
    );
}

/**
 * The AES-GCM parameters. `additionalData` is authenticated but not
 * encrypted: a ciphertext sealed with it opens only when the same bytes are
 * presented again, which binds the ciphertext to its context (the row and
 * field it was written for) so it cannot be moved somewhere else and still
 * open. Omitted, the call is exactly what it was before the option existed.
 */
function gcmParams(iv: Uint8Array, additionalData?: Uint8Array): AesGcmParams {
    return additionalData === undefined
        ? { name: 'AES-GCM', iv: iv as BufferSource }
        : { name: 'AES-GCM', iv: iv as BufferSource, additionalData: additionalData as BufferSource };
}

/**
 * Encrypts raw bytes. The result is the random 12 byte nonce, then the
 * ciphertext, then the 16 byte authentication tag that AES-GCM appends.
 * `additionalData`, when given, must be given again to decrypt.
 */
export async function encryptAESGCM(
    data: Uint8Array,
    key64: string,
    additionalData?: Uint8Array
): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const cryptoKey = await importAESKey(key64, 'encrypt');

    const encrypted = await crypto.subtle.encrypt(
        gcmParams(iv, additionalData),
        cryptoKey,
        data as BufferSource
    );

    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encrypted), iv.length);

    return combined;
}

/**
 * Decrypts what `encryptAESGCM` produced and returns the exact bytes that went
 * in. Returns null when the key is wrong, the tag does not match, the
 * additional data differs from what it was sealed with, or the input is too
 * short to hold a nonce and a tag.
 */
export async function decryptAESGCM(
    data: Uint8Array,
    key64: string,
    additionalData?: Uint8Array
): Promise<Uint8Array | null> {
    try {
        const iv = data.slice(0, IV_LENGTH);
        const encrypted = data.slice(IV_LENGTH);
        const cryptoKey = await importAESKey(key64, 'decrypt');

        const decrypted = await crypto.subtle.decrypt(
            gcmParams(iv, additionalData),
            cryptoKey,
            encrypted as BufferSource
        );

        return new Uint8Array(decrypted);
    } catch (error) {
        return null;
    }
}

/** Encrypts text. The text is encoded as UTF-8 and the result is base64.
 *  `additionalData` (UTF-8) binds the ciphertext as in `encryptAESGCM`. */
export async function encryptAESGCMString(
    data: string,
    key64: string,
    additionalData?: string
): Promise<string> {
    const aad = additionalData === undefined ? undefined : encodeUTF8(additionalData);
    return encodeBase64(await encryptAESGCM(encodeUTF8(data), key64, aad));
}

/** Decrypts base64 text written by `encryptAESGCMString`, with the same
 *  `additionalData` it was sealed with. Returns null on failure. */
export async function decryptAESGCMString(
    data: string,
    key64: string,
    additionalData?: string
): Promise<string | null> {
    let combined: Uint8Array;
    try {
        combined = decodeBase64(data);
    } catch (error) {
        return null;
    }

    const aad = additionalData === undefined ? undefined : encodeUTF8(additionalData);
    const decrypted = await decryptAESGCM(combined, key64, aad);
    return decrypted === null ? null : decodeUTF8(decrypted);
}
