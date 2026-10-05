/** Lowercase hex, two characters per byte: the form webhook signatures and
 *  AWS request signing write a digest in. */
export function encodeHex(bytes: Uint8Array): string {
    let out = '';
    for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
    return out;
}

/**
 * Compares two strings without stopping at the first differing character, so
 * the time a signature check takes says nothing about how much of a guess was
 * right. Strings of different lengths are unequal at once: a length is not a
 * secret.
 */
export function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return mismatch === 0;
}
