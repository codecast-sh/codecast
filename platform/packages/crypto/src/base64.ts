export function decodeBase64(base64: string, encoding: 'base64' | 'base64url' = 'base64'): Uint8Array {
    let normalizedBase64 = base64;

    if (encoding === 'base64url') {
        normalizedBase64 = base64
            .replace(/-/g, '+')
            .replace(/_/g, '/');

        const padding = normalizedBase64.length % 4;
        if (padding) {
            normalizedBase64 += '='.repeat(4 - padding);
        }
    }

    const binaryString = atob(normalizedBase64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);

    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }

    return bytes;
}

/**
 * How many bytes to turn into characters at a time. Every byte becomes one
 * argument to `String.fromCharCode`, and a call with too many arguments
 * overflows the stack, so large buffers are read in pieces.
 */
const CHUNK_SIZE = 0x8000;

export function encodeBase64(buffer: Uint8Array, encoding: 'base64' | 'base64url' = 'base64'): string {
    let binaryString = '';
    for (let i = 0; i < buffer.length; i += CHUNK_SIZE) {
        binaryString += String.fromCharCode(...buffer.subarray(i, i + CHUNK_SIZE));
    }
    const base64 = btoa(binaryString);

    if (encoding === 'base64url') {
        return base64
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
    }

    return base64;
}
