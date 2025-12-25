import { decodeBase64, encodeBase64 } from './base64';
import { encodeUTF8, decodeUTF8 } from './text';

export async function encryptAESGCMString(data: string, key64: string): Promise<string> {
    const keyBytes = decodeBase64(key64);
    const dataBytes = encodeUTF8(data);

    const iv = crypto.getRandomValues(new Uint8Array(12));

    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyBytes as BufferSource,
        { name: 'AES-GCM' },
        false,
        ['encrypt']
    );

    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        cryptoKey,
        dataBytes as BufferSource
    );

    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encrypted), iv.length);

    return encodeBase64(combined);
}

export async function decryptAESGCMString(data: string, key64: string): Promise<string | null> {
    try {
        const keyBytes = decodeBase64(key64);
        const combined = decodeBase64(data);

        const iv = combined.slice(0, 12);
        const encrypted = combined.slice(12);

        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            keyBytes as BufferSource,
            { name: 'AES-GCM' },
            false,
            ['decrypt']
        );

        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            cryptoKey,
            encrypted as BufferSource
        );

        return decodeUTF8(new Uint8Array(decrypted));
    } catch (error) {
        return null;
    }
}

export async function encryptAESGCM(data: Uint8Array, key64: string): Promise<Uint8Array> {
    const encrypted = await encryptAESGCMString(decodeUTF8(data), key64);
    return decodeBase64(encrypted);
}

export async function decryptAESGCM(data: Uint8Array, key64: string): Promise<Uint8Array | null> {
    const raw = await decryptAESGCMString(encodeBase64(data), key64);
    return raw ? encodeUTF8(raw) : null;
}
